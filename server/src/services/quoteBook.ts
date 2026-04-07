/**
 * 호가(Bid/Ask) 조회 서비스
 *
 * KIS API FHKST01010200 (inquire-asking-price-exp-ccn)을 호출하여
 * 매수/매도 10단계 호가를 조회하고 스프레드/깊이/품질 파생지표를 계산합니다.
 *
 * 품질 판정 기준:
 *   GOOD: spread ≤ 0.2%  && topBookDepth ≥ 10,000,000원
 *   FAIR: spread ≤ 0.5%  && topBookDepth ≥ 3,000,000원
 *   POOR: 그 외 (슬리피지 위험 경고)
 */

import { getAccessToken, getKisConfig } from './kisAuth';
import { kisApiCall } from './apiQueue';
import logger from '../logger';

// ── Types ──

export type Market = 'KRX' | 'NYSE' | 'NASDAQ' | 'AMEX' | 'NASD';

export interface BidAskLevel {
  price: number;
  qty: number;
}

export type QuoteQuality = 'GOOD' | 'FAIR' | 'POOR';

export interface QuoteBook {
  ticker: string;
  market: Market;
  bids: BidAskLevel[];      // best bid (index 0) → 10 levels
  asks: BidAskLevel[];      // best ask (index 0) → 10 levels
  midPrice: number;
  spreadPercent: number;     // (best_ask - best_bid) / mid * 100
  depthImbalance: number;    // total_bid_qty / total_ask_qty
  topBookDepthKrw: number;   // best_bid_qty*best_bid + best_ask_qty*best_ask
  quality: QuoteQuality;
  fetchedAt: string;
}

// ── Quality thresholds ──

const SPREAD_GOOD_MAX = 0.2;
const SPREAD_FAIR_MAX = 0.5;
const DEPTH_GOOD_MIN_KRW = 10_000_000;
const DEPTH_FAIR_MIN_KRW = 3_000_000;

// ── Cache ──

const CACHE_TTL_MS = 60 * 1000; // 60s — quotes change rapidly
const cache = new Map<string, { data: QuoteBook; fetchedAt: number }>();

function getCacheKey(ticker: string, market: Market): string {
  return `${market}:${ticker}`;
}

function getCached(key: string): QuoteBook | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

// ── Quality Assessment ──

export function assessQuoteQuality(spreadPercent: number, topBookDepthKrw: number): QuoteQuality {
  if (spreadPercent <= SPREAD_GOOD_MAX && topBookDepthKrw >= DEPTH_GOOD_MIN_KRW) {
    return 'GOOD';
  }
  if (spreadPercent <= SPREAD_FAIR_MAX && topBookDepthKrw >= DEPTH_FAIR_MIN_KRW) {
    return 'FAIR';
  }
  return 'POOR';
}

// ── Domestic (KRX) KIS API ──

interface KisAskingPriceResponse {
  rt_cd?: string;
  msg1?: string;
  output1?: Record<string, string | number>;
  output2?: Record<string, string | number>;
}

async function fetchKrxQuoteBook(ticker: string): Promise<QuoteBook | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    logger.debug({ err, ticker }, 'KIS auth failed for quote book');
    return null;
  }

  try {
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
    });

    const response = await kisApiCall(() => fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010200',
          custtype: 'P',
        },
      }
    ));

    if (!response.ok) {
      logger.debug({ ticker, status: response.status }, 'KRX quote book HTTP error');
      return null;
    }

    const data = await response.json() as KisAskingPriceResponse;
    if (data.rt_cd !== '0') {
      logger.debug({ ticker, rt_cd: data.rt_cd, msg: data.msg1 }, 'KRX quote book API error');
      return null;
    }

    const output = data.output1;
    if (!output) return null;

    // Parse 10 levels of bid/ask
    // KIS field naming: askp1~askp10 (매도호가), bidp1~bidp10 (매수호가)
    // Quantities: askp_rsqn1~askp_rsqn10, bidp_rsqn1~bidp_rsqn10
    const asks: BidAskLevel[] = [];
    const bids: BidAskLevel[] = [];

    for (let i = 1; i <= 10; i++) {
      const askPrice = Number(output[`askp${i}`]);
      const askQty = Number(output[`askp_rsqn${i}`]);
      const bidPrice = Number(output[`bidp${i}`]);
      const bidQty = Number(output[`bidp_rsqn${i}`]);

      if (askPrice > 0 && askQty >= 0) asks.push({ price: askPrice, qty: askQty });
      if (bidPrice > 0 && bidQty >= 0) bids.push({ price: bidPrice, qty: bidQty });
    }

    if (asks.length === 0 || bids.length === 0) {
      logger.debug({ ticker }, 'KRX quote book empty levels');
      return null;
    }

    return buildQuoteBook(ticker, 'KRX', bids, asks);
  } catch (err) {
    logger.debug({ err, ticker }, 'KRX quote book fetch failed');
    return null;
  }
}

// ── Build QuoteBook with derived metrics ──

function buildQuoteBook(
  ticker: string,
  market: Market,
  bids: BidAskLevel[],
  asks: BidAskLevel[],
): QuoteBook | null {
  const bestBid = bids[0];
  const bestAsk = asks[0];

  if (!bestBid || !bestAsk || bestBid.price <= 0 || bestAsk.price <= 0) {
    return null;
  }

  const midPrice = (bestBid.price + bestAsk.price) / 2;
  const spreadPercent = ((bestAsk.price - bestBid.price) / midPrice) * 100;

  const totalBidQty = bids.reduce((sum, l) => sum + l.qty, 0);
  const totalAskQty = asks.reduce((sum, l) => sum + l.qty, 0);
  const depthImbalance = totalAskQty > 0 ? totalBidQty / totalAskQty : 0;

  const topBookDepthKrw = bestBid.qty * bestBid.price + bestAsk.qty * bestAsk.price;

  const quality = assessQuoteQuality(spreadPercent, topBookDepthKrw);

  return {
    ticker,
    market,
    bids,
    asks,
    midPrice: Math.round(midPrice * 100) / 100,
    spreadPercent: Math.round(spreadPercent * 1000) / 1000,
    depthImbalance: Math.round(depthImbalance * 100) / 100,
    topBookDepthKrw: Math.round(topBookDepthKrw),
    quality,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Public API ──

/**
 * 종목의 호가(bid/ask) 정보를 조회합니다.
 * @returns QuoteBook 또는 실패/미지원 시 null
 */
export async function getQuoteBook(ticker: string, market: Market): Promise<QuoteBook | null> {
  const cacheKey = getCacheKey(ticker, market);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // 해외 주식은 KIS 호가 엔드포인트 미지원 — 현재는 null 반환
  // (향후 Yahoo Finance bid/ask 필드로 확장 가능)
  if (market !== 'KRX') {
    return null;
  }

  const qb = await fetchKrxQuoteBook(ticker);
  if (qb) {
    cache.set(cacheKey, { data: qb, fetchedAt: Date.now() });
  }
  return qb;
}

/** 캐시 무효화 (테스트/수동 갱신용) */
export function invalidateQuoteBookCache(ticker?: string, market?: Market): void {
  if (ticker && market) {
    cache.delete(getCacheKey(ticker, market));
  } else {
    cache.clear();
  }
}
