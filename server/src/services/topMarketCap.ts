/**
 * Top Market Cap — KOSPI + KOSDAQ 통합 시가총액 상위 10개 산정.
 *
 * 데이터 소스: Naver Finance 모바일 JSON API (UTF-8, 인증 불필요).
 *   - https://m.stock.naver.com/api/stocks/marketValue/KOSPI?pageSize=30&page=1
 *   - https://m.stock.naver.com/api/stocks/marketValue/KOSDAQ?pageSize=30&page=1
 *
 * 우선주 포함, 보통주만 필터링하지 않음 (사용자 결정).
 *
 * 캐시: 1시간. cron (매시간 정시) 이 force=true 로 갱신 트리거.
 * Naver 양쪽 모두 실패 시 stale 캐시 fallback (자동매매 중단 회피).
 */

import logger from '../logger';

export type Market = 'KOSPI' | 'KOSDAQ';

export interface TopStock {
  rank: number;                // 통합 Top 10 내 순위 (1~10)
  ticker: string;              // 6자리 종목코드
  name: string;
  market: Market;
  marketCapKrw: number;        // 시가총액 원 단위 (정수, 정렬 기준)
  marketCapEok: number;        // 시가총액 억원 (표시용)
  marketCapHangeul: string;    // "1,631조 1,117억원"
  closePrice: number;          // 직전 종가/현재가 (원)
  fluctuationsRatio: number;   // 등락률 (%)
}

export interface TopMarketCapResult {
  top10: TopStock[];
  fetchedAt: string;           // ISO datetime
  source: 'naver-mobile' | 'naver-mobile-stale';
}

interface NaverStockRaw {
  itemCode?: string;
  stockName?: string;
  closePriceRaw?: string;
  fluctuationsRatio?: string;
  marketValueRaw?: string;
  marketValue?: string;
  marketValueHangeul?: string;
}

interface NaverApiResponse {
  stocks?: NaverStockRaw[];
}

const PAGE_SIZE = 30;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1시간 — cron이 정시마다 갱신
const FETCH_TIMEOUT_MS = 8_000;

let cache: { result: TopMarketCapResult; fetchedAt: number } | null = null;

async function fetchMarket(market: Market): Promise<TopStock[]> {
  const url = `https://m.stock.naver.com/api/stocks/marketValue/${market}?pageSize=${PAGE_SIZE}&page=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as NaverApiResponse;
    const stocks = json.stocks ?? [];

    return stocks
      .filter((s): s is Required<NaverStockRaw> => Boolean(s.itemCode && s.stockName))
      .map((s, idx): TopStock => ({
        rank: idx + 1,
        ticker: s.itemCode,
        name: s.stockName,
        market,
        marketCapKrw: Number(s.marketValueRaw) || 0,
        marketCapEok: Number((s.marketValue || '').replace(/,/g, '')) || 0,
        marketCapHangeul: s.marketValueHangeul || '',
        closePrice: Number(s.closePriceRaw) || 0,
        fluctuationsRatio: Number(s.fluctuationsRatio) || 0,
      }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Top 10 산정. 캐시 미스 또는 force=true 시 양 시장에서 재조회.
 * 양쪽 모두 실패하면 stale 캐시 반환 (있을 때) 또는 throw.
 */
export async function fetchTop10(force = false): Promise<TopMarketCapResult> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.result;
  }

  const [kospiResult, kosdaqResult] = await Promise.allSettled([
    fetchMarket('KOSPI'),
    fetchMarket('KOSDAQ'),
  ]);

  const kospi = kospiResult.status === 'fulfilled' ? kospiResult.value : [];
  const kosdaq = kosdaqResult.status === 'fulfilled' ? kosdaqResult.value : [];

  if (kospiResult.status === 'rejected') {
    logger.warn({ err: String(kospiResult.reason) }, '[TopMarketCap] KOSPI fetch failed');
  }
  if (kosdaqResult.status === 'rejected') {
    logger.warn({ err: String(kosdaqResult.reason) }, '[TopMarketCap] KOSDAQ fetch failed');
  }

  if (kospi.length === 0 && kosdaq.length === 0) {
    if (cache) {
      logger.warn('[TopMarketCap] 양쪽 모두 실패 — stale 캐시 fallback');
      return { ...cache.result, source: 'naver-mobile-stale' };
    }
    throw new Error('TopMarketCap: Naver API 양쪽 모두 실패 — 캐시 없음');
  }

  const combined: TopStock[] = [...kospi, ...kosdaq].sort(
    (a, b) => b.marketCapKrw - a.marketCapKrw,
  );
  const top10: TopStock[] = combined.slice(0, 10).map((s, i) => ({ ...s, rank: i + 1 }));

  const result: TopMarketCapResult = {
    top10,
    fetchedAt: new Date().toISOString(),
    source: 'naver-mobile',
  };
  cache = { result, fetchedAt: Date.now() };

  logger.info(
    {
      count: top10.length,
      top3: top10.slice(0, 3).map((s) => `${s.name}(${s.marketCapEok}억)`),
    },
    '[TopMarketCap] fetched',
  );
  return result;
}

/** 캐시 강제 갱신 트리거 (수동/cron) */
export async function refreshTop10(): Promise<TopMarketCapResult> {
  return fetchTop10(true);
}

/** 캐시 조회 — 없으면 null. UI 가벼운 조회용. */
export function getCachedTop10(): TopMarketCapResult | null {
  return cache?.result ?? null;
}

/** 테스트/수동: 캐시 무효화 */
export function invalidateTop10Cache(): void {
  cache = null;
}
