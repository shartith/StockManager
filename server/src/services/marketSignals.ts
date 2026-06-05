/**
 * Market signal analysis (v5.7.0).
 *
 * KOSPI 일변동률, 5일/20일 이동평균선, 추세 판정 — rebalanceStrategy 가 매매 결정에 사용.
 *
 * 데이터 소스:
 *   - 단일 일변동률: Yahoo `^KS11` (range=1d) — 기존 marketBrake 와 동일 경로
 *   - 이동평균: Yahoo `^KS11` (range=3mo) — 60일치면 5/20MA 모두 안정적으로 계산
 *
 * 캐시:
 *   - 60초 캐시. 매시간 cron 에서 1~수 회 호출되는 정도라 짧게.
 */

import logger from '../logger';

interface KospiDailyChange {
  price: number;
  changePercent: number;     // 전일 종가 대비 변동률
  fetchedAt: number;
}

interface KospiTrend {
  ma5: number;
  ma20: number;
  ma5LtMa20: boolean;        // 5일선 < 20일선 (단기 약세 시그널)
  closesUsed: number;        // 실제 계산에 쓰인 봉 수 (디버깅용)
  fetchedAt: number;
}

const CACHE_TTL = 60_000;
const REGIME_CACHE_TTL = 60 * 60 * 1000; // 200일선은 일 단위라 1시간 캐시
let dailyCache: KospiDailyChange | null = null;
let trendCache: KospiTrend | null = null;
let regimeCache: KospiRegime | null = null;

/** Yahoo 일봉 닫는값 N개 가져오기. 최신이 배열의 마지막. */
async function fetchKospiCloses(rangeText: string): Promise<number[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=${rangeText}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(closes)) return [];
    return closes.filter((c: unknown): c is number => typeof c === 'number' && Number.isFinite(c) && c > 0);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fetchKospiCloses failed');
    return [];
  }
}

/**
 * KOSPI 전일 대비 변동률 (-3.5 = 3.5% 하락).
 * Yahoo `chartPreviousClose` 가 정확 — meta 의 regularMarketPrice / chartPreviousClose 로 계산.
 */
export async function getKospiDailyChange(): Promise<KospiDailyChange | null> {
  if (dailyCache && Date.now() - dailyCache.fetchedAt < CACHE_TTL) return dailyCache;

  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = Number(meta.regularMarketPrice);
    const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
    const changePercent = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
    dailyCache = { price, changePercent, fetchedAt: Date.now() };
    return dailyCache;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'getKospiDailyChange failed');
    return null;
  }
}

/** 단순 이동평균. closes 배열의 마지막 N 개로 계산. 부족하면 null. */
export function simpleMovingAverage(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / window;
}

/**
 * KOSPI 5일/20일 단순이동평균 + 추세 시그널.
 * 5MA < 20MA 이면 단기 약세 (데드크로스 영역).
 */
export async function getKospiTrend(): Promise<KospiTrend | null> {
  if (trendCache && Date.now() - trendCache.fetchedAt < CACHE_TTL) return trendCache;

  const closes = await fetchKospiCloses('3mo'); // 약 60 봉
  const ma5 = simpleMovingAverage(closes, 5);
  const ma20 = simpleMovingAverage(closes, 20);
  if (ma5 === null || ma20 === null) {
    logger.warn({ closesUsed: closes.length }, 'getKospiTrend: insufficient data');
    return null;
  }
  trendCache = {
    ma5,
    ma20,
    ma5LtMa20: ma5 < ma20,
    closesUsed: closes.length,
    fetchedAt: Date.now(),
  };
  return trendCache;
}

export interface KospiRegime {
  belowMa200: boolean;       // KOSPI 종가 < 200일선 → 장기 약세장 판정
  price: number;
  ma200: number;
  closesUsed: number;
  fetchedAt: number;
}

/**
 * v6.0 200일선 레짐 필터 — KOSPI 가 장기추세선(200일 SMA) 아래면 약세장.
 *
 * 백테스트: 완만한 하락장(2018·2022)에서 신규 매수를 멈춰 손실을 크게 줄임
 * (2022 -21% → 0%, 최악연도 -21% → -9%). 단 급락+급반등(2020 COVID)에선
 * 반등을 일부 놓치는 휩쏘 비용 존재. "약세장 방어 vs 반등 참여" 트레이드오프.
 *
 * 데이터 부족(신규 지수 등) 시 belowMa200=false (보수적으로 매수 허용).
 */
export async function getKospiRegime(): Promise<KospiRegime | null> {
  if (regimeCache && Date.now() - regimeCache.fetchedAt < REGIME_CACHE_TTL) return regimeCache;

  const closes = await fetchKospiCloses('1y'); // 약 244 봉 → 200일선 계산 가능
  const ma200 = simpleMovingAverage(closes, 200);
  if (ma200 === null || closes.length === 0) {
    logger.warn({ closesUsed: closes.length }, 'getKospiRegime: insufficient data (200MA)');
    return null;
  }
  const price = closes[closes.length - 1];
  regimeCache = {
    belowMa200: price < ma200,
    price,
    ma200,
    closesUsed: closes.length,
    fetchedAt: Date.now(),
  };
  return regimeCache;
}

export interface DyingMarketSignal {
  isDying: boolean;
  reason: string;
  kospiChangePercent?: number;
  ma5?: number;
  ma20?: number;
}

/**
 * "죽는 시장" 판정:
 *   5일선 < 20일선 (단기 약세 추세) AND KOSPI 일변동률 <= -2%
 * → 신규 매수만 일시 차단 (보유 종목은 유지)
 *
 * 두 조건 모두 만족해야 함:
 *   - MA 조건만으로는 횡보장에도 자주 발동 → 일변동률로 필터링
 *   - 일변동률 조건만으로는 일시적 하락에도 발동 → MA 로 추세 확인
 */
export async function detectDyingMarket(): Promise<DyingMarketSignal> {
  const [daily, trend] = await Promise.all([getKospiDailyChange(), getKospiTrend()]);

  if (!daily || !trend) {
    return { isDying: false, reason: 'KOSPI 데이터 없음 — 보수적으로 매수 허용' };
  }

  const kospiDown = daily.changePercent <= -2;
  const isDying = trend.ma5LtMa20 && kospiDown;

  return {
    isDying,
    reason: isDying
      ? `5MA(${trend.ma5.toFixed(0)}) < 20MA(${trend.ma20.toFixed(0)}) + KOSPI ${daily.changePercent}%`
      : '',
    kospiChangePercent: daily.changePercent,
    ma5: trend.ma5,
    ma20: trend.ma20,
  };
}

/** 테스트/디버깅: 캐시 무효화 */
export function invalidateMarketSignalsCache(): void {
  dailyCache = null;
  trendCache = null;
  regimeCache = null;
}
