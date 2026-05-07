/**
 * Entry / Exit Plan — 종목별 진입/익절/손절 가격을 사전 계산.
 *
 * 매매 룰(Rule 6 STOP_LOSS, Rule 7 TARGET_PROFIT, TRAILING_STOP) 과는 OR 관계로
 * 독립적으로 평가됨. 매도 시점에 가장 먼저 매칭된 룰 우선.
 *
 * 사용 방식:
 *   - 매수 진입 직전: primaryEntry / supportEntry 비교 → 즉시 매수 vs 지정가 reservation
 *   - 보유 중: t1Target 도달 시 1차 분할 익절, t2Target 시 2차 익절, dynamicSL 이탈 시 손절
 *
 * 주의: STOP_LOSS / TRAILING_STOP 은 평단(=cost basis) 기준. 여기서 계산하는
 *       dynamicSL 은 보조 지표 (지지선 + ATR) 기준. 둘 중 더 높은 가격이 트리거.
 */

import { fetchDailyCandles } from './candleData';
import { calcATR, calcSMA, type CandleData } from './technicalAnalysis';
import logger from '../logger';

export interface EntryExitPlan {
  ticker: string;
  currentPrice: number;
  /** 즉시 체결 시 사용 — 현재가 -0.5% (기존 동작) */
  primaryEntry: number;
  /** 눌림목 매수 — 지지선 근처 */
  supportEntry: number;
  /** 1차 익절 (50% 부분 매도) */
  t1Target: number;
  /** 2차 익절 (잔여 매도 또는 트레일 시작) */
  t2Target: number;
  /** 동적 손절 — 지지선 - ATR×0.5 */
  dynamicSL: number;
  /** 14일 ATR (변동성) */
  atr: number;
  /** 5일 저점 (지지) */
  recentLow: number;
  /** 5일 고점 (저항) */
  recentHigh: number;
  /** 20일 SMA */
  sma20: number | null;
  /** 분석 사유 한 줄 */
  reason: string;
}

const SUPPORT_OFFSET_PERCENT = 0.005;   // 지지선 +0.5% 위에 진입가 두기
const T1_MIN_PCT = 0.02;                // T1 최소 +2%
const T2_MIN_PCT = 0.04;                // T2 최소 +4%
const SL_ATR_MULTIPLIER = 0.5;          // 지지선 - ATR × 0.5

/**
 * 종목의 매매 계획을 계산.
 * 캔들 데이터 부족 (<30개) 또는 ATR 계산 실패 시 null 반환 → 기본 룰만 적용.
 */
export async function computeEntryExitPlan(
  ticker: string,
  currentPrice: number,
): Promise<EntryExitPlan | null> {
  if (currentPrice <= 0) return null;

  const candles = await fetchDailyCandles(ticker, { days: 60 });
  if (candles.length < 30) {
    logger.debug({ ticker, candleCount: candles.length }, 'computeEntryExitPlan: insufficient candles');
    return null;
  }

  const atr = calcATR(candles, 14);
  if (!atr) return null;

  const last5 = candles.slice(-5);
  const recentLow = Math.min(...last5.map(c => c.low));
  const recentHigh = Math.max(...last5.map(c => c.high));
  const sma20 = calcSMA(candles.map(c => c.close), 20);

  // 지지선: 5일 저점과 20일 SMA 중 현재가에 더 가까운 (단, 현재가 미만이어야 함)
  const candidates = [recentLow];
  if (sma20 !== null && sma20 < currentPrice) candidates.push(sma20);
  const support = Math.max(...candidates.filter(v => v < currentPrice));
  const supportEntry = Math.round(support * (1 + SUPPORT_OFFSET_PERCENT));

  const primaryEntry = Math.floor(currentPrice * 0.995);

  // T1 / T2: 5일 고점과 +2% / +4% 중 큰 쪽
  const t1ByHigh = recentHigh;
  const t1ByPct = currentPrice * (1 + T1_MIN_PCT);
  const t1Target = Math.round(Math.max(t1ByHigh, t1ByPct));

  const t2ByPct = currentPrice * (1 + T2_MIN_PCT);
  const t2Target = Math.round(Math.max(t1Target * 1.015, t2ByPct));

  const dynamicSL = Math.round(support - atr * SL_ATR_MULTIPLIER);

  const reason = `지지 ${support.toLocaleString()} (5일저 ${recentLow.toLocaleString()}, 20MA ${sma20 ? sma20.toLocaleString() : 'n/a'}), 저항 ${recentHigh.toLocaleString()}, ATR ${atr.toFixed(0)}`;

  return {
    ticker,
    currentPrice,
    primaryEntry,
    supportEntry,
    t1Target,
    t2Target,
    dynamicSL,
    atr,
    recentLow,
    recentHigh,
    sma20,
    reason,
  };
}

// 종목별 plan 캐시 (보유 중 매도 룰 평가에 1분마다 재계산하지 않도록)
const _planCache = new Map<string, { plan: EntryExitPlan; computedAt: number }>();
const PLAN_CACHE_TTL_MS = 30 * 60 * 1000; // 30분

export async function getCachedEntryExitPlan(
  ticker: string,
  currentPrice: number,
): Promise<EntryExitPlan | null> {
  const cached = _planCache.get(ticker);
  if (cached && Date.now() - cached.computedAt < PLAN_CACHE_TTL_MS) {
    // currentPrice 만 갱신해서 반환 (T1/T2/SL 은 일봉 기반이라 그대로)
    return { ...cached.plan, currentPrice };
  }
  const plan = await computeEntryExitPlan(ticker, currentPrice);
  if (plan) _planCache.set(ticker, { plan, computedAt: Date.now() });
  return plan;
}

export function invalidatePlanCache(ticker?: string): void {
  if (!ticker) _planCache.clear();
  else _planCache.delete(ticker);
}

// 상수 export (다른 모듈에서 정책 일관성 유지 목적)
export const ENTRY_EXIT_CONSTANTS = {
  SUPPORT_OFFSET_PERCENT,
  T1_MIN_PCT,
  T2_MIN_PCT,
  SL_ATR_MULTIPLIER,
};
