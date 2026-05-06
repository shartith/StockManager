import { getAccessToken, getKisConfig } from './kisAuth';
import { getSettings } from './settings';
import { kisApiCall, yahooApiCall } from './apiQueue';

/** KIS API로 단일 종목 현재가 조회 */
async function getKisStockPrice(ticker: string, token: string): Promise<number | null> {
  const snap = await getKisStockSnapshot(ticker, token);
  return snap?.price ?? null;
}

export interface KisSnapshot {
  price: number;
  open: number;
  prevClose: number;
  high: number;
  low: number;
  volume: number;          // 누적 거래량
  changePercent: number;   // 전일 대비 등락률
  viActivated: boolean;    // VI(변동성 완화장치) 발동 여부
  isSuspended: boolean;    // 거래정지/관리종목 여부 (대략)
}

/**
 * KIS API로 단일 종목 풀 스냅샷 조회 (가격 + 거래량 + VI + 시초가).
 * dailyStrategy의 매수 평가에서 1회 호출로 모든 정보 확보.
 */
export async function getKisStockSnapshot(ticker: string, token: string): Promise<KisSnapshot | null> {
  const { appKey, appSecret, baseUrl } = getKisConfig();
  try {
    const params = new URLSearchParams({
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: ticker,
    });
    const response = await fetch(
      `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
      }
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    if (data.rt_cd !== '0') return null;
    const o = data.output || {};
    const price = Number(o.stck_prpr) || 0;
    if (price <= 0) return null;
    return {
      price,
      open: Number(o.stck_oprc) || 0,
      prevClose: Number(o.stck_prdy_clpr) || price,
      high: Number(o.stck_hgpr) || price,
      low: Number(o.stck_lwpr) || price,
      volume: Number(o.acml_vol) || 0,
      changePercent: Number(o.prdy_ctrt) || 0,
      // VI 발동 기준가가 0이 아니면 발동 중. KIS field: vi_stnd_prc
      viActivated: Number(o.vi_stnd_prc) > 0,
      // 매매구분: '00' = 정상매매. 거래정지면 다른 값.
      // 주의: KIS는 거래정지 종목도 stck_prpr를 0이 아닌 직전가로 줄 수 있음 → fallback은 별도 시도.
      isSuspended: false, // 본격 판단은 주문 시 KIS 에러 코드(APBK0066 등)에 위임
    };
  } catch {
    return null;
  }
}

/** Yahoo Finance fallback */
async function getYahooStockPrice(ticker: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'StockManager/3.0' } }
    );
    if (!response.ok) return null;
    const data: any = await response.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return price ?? null;
  } catch {
    return null;
  }
}

export async function getStockPrice(ticker: string): Promise<number | null> {
  const settings = getSettings();
  // KIS API 설정이 있으면 KIS 우선
  if (settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      const price = await getKisStockPrice(ticker, token);
      if (price !== null) return price;
    } catch {
      // KIS 실패 시 Yahoo fallback
    }
  }
  // 해외주식 또는 KIS 미설정: Yahoo Finance (ticker.KS 형식 불필요 — 실패하면 null)
  return getYahooStockPrice(ticker);
}

// ─── Price cache (Fix #4) ────────────────────────────────────
//
// Avoid hitting KIS/Yahoo for every request. Stock prices change at most
// every few seconds during market hours, and a 60s cache cuts redundant
// calls drastically when the user refreshes the dashboard repeatedly.
const PRICE_CACHE_TTL_MS = 60_000;
const priceCache = new Map<string, { price: number; ts: number }>();

function getCachedPrice(ticker: string): number | null {
  const entry = priceCache.get(ticker);
  if (!entry) return null;
  if (Date.now() - entry.ts > PRICE_CACHE_TTL_MS) {
    priceCache.delete(ticker);
    return null;
  }
  return entry.price;
}

function setCachedPrice(ticker: string, price: number): void {
  priceCache.set(ticker, { price, ts: Date.now() });
}

/** Test/manual: clear all cached prices. */
export function invalidatePriceCache(): void {
  priceCache.clear();
}

export async function getMultipleStockPrices(tickers: string[], _tickerMarkets?: Map<string, string>): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const settings = getSettings();

  // Resolve cache hits first; only fetch what's missing
  const tickersToFetch: string[] = [];
  for (const ticker of tickers) {
    const cached = getCachedPrice(ticker);
    if (cached !== null) {
      prices.set(ticker, cached);
    } else {
      tickersToFetch.push(ticker);
    }
  }

  if (tickersToFetch.length === 0) {
    return prices;
  }

  const recordPrice = (ticker: string, price: number): void => {
    prices.set(ticker, price);
    setCachedPrice(ticker, price);
  };

  // KIS API 우선 (큐로 rate limit + 동시성 관리), 실패 시 Yahoo fallback
  if (settings.kisAppKey && settings.kisAppSecret) {
    try {
      const token = await getAccessToken();
      await Promise.all(
        tickersToFetch.map(async ticker => {
          const price = await kisApiCall(() => getKisStockPrice(ticker, token), `price-${ticker}`);
          if (price !== null) recordPrice(ticker, price);
        }),
      );
    } catch {
      await Promise.allSettled(
        tickersToFetch.map(async ticker => {
          const price = await yahooApiCall(() => getYahooStockPrice(ticker), `yahoo-${ticker}`);
          if (price !== null) recordPrice(ticker, price);
        })
      );
    }
  } else {
    await Promise.allSettled(
      tickersToFetch.map(async ticker => {
        const price = await yahooApiCall(() => getYahooStockPrice(ticker), `yahoo-${ticker}`);
        if (price !== null) recordPrice(ticker, price);
      })
    );
  }

  return prices;
}

// ─── 재무 데이터 (펀더멘털) ──────────────────────────────────

export interface FundamentalData {
  per?: number;
  pbr?: number;
  dividendYield?: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  // DART 재무제표
  roe?: number;
  revenue?: number;          // 매출액 (억원)
  revenueGrowth?: number;   // 매출 YoY 성장률 (%)
  operatingIncome?: number;  // 영업이익 (억원)
  operatingMargin?: number;  // 영업이익률 (%)
  netIncome?: number;        // 순이익 (억원)
  dartReportDate?: string;
}

const fundamentalCache = new Map<string, { data: FundamentalData; fetchedAt: number }>();
const FUNDAMENTAL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

/** Yahoo Finance에서 재무 데이터 조회 */
export async function getFundamentals(ticker: string): Promise<FundamentalData> {
  const cached = fundamentalCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FUNDAMENTAL_CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`
    );
    if (!res.ok) return {};
    const json: any = await res.json();
    const meta = json?.chart?.result?.[0]?.meta || {};

    const data: FundamentalData = {
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    };

    // KRX 종목: Yahoo ticker 형식이 다름 (005930.KS)
    // 기본 meta에 PER/PBR 없으면 빈 값
    fundamentalCache.set(ticker, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return {};
  }
}

/** KIS API 국내 종목 PER/PBR 조회 */
export async function getKisFundamentals(ticker: string): Promise<FundamentalData> {
  const cached = fundamentalCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < FUNDAMENTAL_CACHE_TTL) return cached.data;

  try {
    const settings = getSettings();
    if (!settings.kisAppKey || !settings.kisAppSecret) return {};

    const { appKey, appSecret, baseUrl } = getKisConfig();
    const token = await getAccessToken();

    const data: FundamentalData = await kisApiCall(async () => {
      const params = new URLSearchParams({
        fid_cond_mrkt_div_code: 'J',
        fid_input_iscd: ticker,
      });
      const response = await fetch(
        `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            appkey: appKey, appsecret: appSecret,
            tr_id: 'FHKST01010100', custtype: 'P',
          },
        }
      );
      if (!response.ok) return {};
      const json: any = await response.json();
      if (json.rt_cd !== '0') return {};
      const output = json.output || {};
      return {
        per: Number(output.per) || undefined,
        pbr: Number(output.pbr) || undefined,
        marketCap: Number(output.hts_avls) || undefined, // 시가총액(억)
      };
    }, `fundamental-${ticker}`);

    // DART 재무제표 병합 (활성화된 경우)
    try {
      if (settings.dartEnabled && settings.dartApiKey && ticker.length === 6) {
        const { getDartFinancials } = require('./dartApi');
        const dartData = await getDartFinancials(ticker);
        if (dartData) {
          if (dartData.roe) data.roe = dartData.roe;
          if (dartData.revenue) data.revenue = dartData.revenue;
          if (dartData.revenueGrowth !== undefined) data.revenueGrowth = dartData.revenueGrowth;
          if (dartData.operatingIncome) data.operatingIncome = dartData.operatingIncome;
          if (dartData.operatingMargin) data.operatingMargin = dartData.operatingMargin;
          if (dartData.netIncome) data.netIncome = dartData.netIncome;
          if (dartData.reportDate) data.dartReportDate = dartData.reportDate;
        }
      }
    } catch {}

    fundamentalCache.set(ticker, { data, fetchedAt: Date.now() });
    return data;
  } catch {
    return {};
  }
}

// ─── 글로벌 시장 컨텍스트 ─────────────────────────────────

export interface MarketContextData {
  kospi?: { price: number; changePercent: number };
  kosdaq?: { price: number; changePercent: number };
  vix?: { price: number; changePercent: number };
}

let marketContextCache: { data: MarketContextData; fetchedAt: number } | null = null;
const CONTEXT_CACHE_TTL = 30 * 60 * 1000; // 30분

export async function fetchYahooQuote(symbol: string): Promise<{ price: number; changePercent: number } | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: { 'User-Agent': 'StockManager/3.0' } }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    // range=1d일 때 chartPreviousClose = 전일 종가 (정확)
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const changePercent = prevClose ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0;
    return { price, changePercent };
  } catch {
    return null;
  }
}

/** KRX 시장 지수 조회 (KOSPI, KOSDAQ, VIX) */
export async function getMarketContext(): Promise<MarketContextData> {
  const now = Date.now();
  if (marketContextCache && now - marketContextCache.fetchedAt < CONTEXT_CACHE_TTL) {
    return marketContextCache.data;
  }

  const symbols = [
    { key: 'kospi', symbol: '^KS11' },
    { key: 'kosdaq', symbol: '^KQ11' },
    { key: 'vix', symbol: '^VIX' },
  ];

  const results = await Promise.allSettled(
    symbols.map(async s => ({ key: s.key, data: await fetchYahooQuote(s.symbol) }))
  );

  const context: MarketContextData = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.data) {
      (context as any)[r.value.key] = r.value.data;
    }
  }

  marketContextCache = { data: context, fetchedAt: now };
  return context;
}

/** 시장 컨텍스트를 LLM 입력용 텍스트로 변환 */
export function formatMarketContext(ctx: MarketContextData, _market: string): string {
  const lines: string[] = [];

  if (ctx.kospi) lines.push(`KOSPI: ${ctx.kospi.price.toLocaleString()} (${ctx.kospi.changePercent >= 0 ? '+' : ''}${ctx.kospi.changePercent}%)`);
  if (ctx.kosdaq) lines.push(`KOSDAQ: ${ctx.kosdaq.price.toLocaleString()} (${ctx.kosdaq.changePercent >= 0 ? '+' : ''}${ctx.kosdaq.changePercent}%)`);
  if (ctx.vix) lines.push(`VIX: ${ctx.vix.price.toFixed(1)} (${ctx.vix.changePercent >= 0 ? '+' : ''}${ctx.vix.changePercent}%)`);

  // VIX 경고
  if (ctx.vix) {
    if (ctx.vix.price > 30) lines.push('⚠️ VIX 30 초과 — 극도의 공포, 신규 매수 매우 보수적으로');
    else if (ctx.vix.price > 25) lines.push('⚠️ VIX 25 초과 — 공포 구간, 신규 매수 보수적으로');
  }

  return lines.join('\n  ');
}
