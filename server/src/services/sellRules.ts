/**
 * 매도 규칙 엔진 — LLM 불필요, hard rules
 *
 * 4가지 규칙을 우선순위 순으로 평가하여 선착 매도 신호를 반환한다:
 *   1. TARGET_PROFIT  — 목표 수익률 도달
 *   2. STOP_LOSS      — 손절 기준 이탈
 *   3. TRAILING_STOP  — 고점 대비 낙폭 초과
 *   4. HOLDING_TIME   — 보유 시간 초과
 *
 * 매도 판단은 매수 판단보다 우선 실행된다 (continuousMonitor.ts에서 호출).
 */

import { queryOne } from '../db';
import { getSettings } from './settings';
import logger from '../logger';

// ── Types ──

export type SellRule = 'TARGET_PROFIT' | 'STOP_LOSS' | 'TRAILING_STOP' | 'HOLDING_TIME';

export interface SellRuleResult {
  shouldSell: boolean;
  rule?: SellRule;
  reason?: string;
}

export interface HoldingContext {
  stockId: number;
  ticker: string;
  currentPrice: number;
  avgPrice: number;
  quantity: number;
  unrealizedPnLPercent: number;
}

// ── In-memory peak price tracker ──

const peakPrices = new Map<number, number>();

/** 고점 갱신 — 현재가가 기존 고점보다 높으면 업데이트 */
export function updatePeakPrice(stockId: number, currentPrice: number): number {
  const existing = peakPrices.get(stockId) ?? currentPrice;
  const peak = Math.max(existing, currentPrice);
  peakPrices.set(stockId, peak);
  return peak;
}

/** 매도 완료 후 고점 초기화 */
export function resetPeakPrice(stockId: number): void {
  peakPrices.delete(stockId);
}

/** 현재 고점 조회 (테스트용) */
export function getPeakPrice(stockId: number): number | undefined {
  return peakPrices.get(stockId);
}

// ── 매수 시각 조회 ──

/**
 * auto_trades 테이블에서 가장 최근 체결된 BUY 주문의 시각을 가져온다.
 * auto_trades가 없으면 transactions 테이블의 date를 fallback으로 사용
 * (단, DATE 타입이라 분 단위 정밀도 없음).
 */
export function getBuyTimestamp(stockId: number): Date | null {
  // auto_trades: DATETIME → 분 단위 정밀도
  const autoTrade = queryOne(
    "SELECT created_at FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND status = 'FILLED' ORDER BY created_at DESC LIMIT 1",
    [stockId],
  );
  if (autoTrade?.created_at) {
    return new Date(autoTrade.created_at);
  }

  // fallback: transactions (수동 매수도 포함)
  const tx = queryOne(
    "SELECT date FROM transactions WHERE stock_id = ? AND type = 'BUY' ORDER BY date DESC, id DESC LIMIT 1",
    [stockId],
  );
  if (tx?.date) {
    return new Date(tx.date);
  }

  return null;
}

// ── 핵심 평가 함수 ──

/**
 * ROI Table 평가 — 경과 시간 t에 대해 "해당 시점의 목표 수익률 임계값"을 반환.
 * 테이블은 [[minutes, profitPct], ...] 형태. minutes 오름차순 정렬 가정.
 * 가장 최근에 통과한 단계의 profitPct를 사용 (step function, not interpolated).
 *
 * 예: [[0, 3], [30, 2], [60, 1], [120, 0]]
 *   - t=0~29분:   threshold = 3%
 *   - t=30~59분:  threshold = 2%
 *   - t=60~119분: threshold = 1%
 *   - t≥120분:    threshold = 0% (손익무관 청산)
 *
 * 반환값이 null이면 해당 시점에 ROI 규칙 적용 불가 (테이블 미설정).
 */
function getRoiThresholdAt(minutes: number, table?: Array<[number, number]>): number | null {
  if (!table || table.length === 0) return null;
  const sorted = [...table].sort((a, b) => a[0] - b[0]);
  let threshold: number | null = null;
  for (const [t, pct] of sorted) {
    if (minutes >= t) threshold = pct;
    else break;
  }
  return threshold;
}

/**
 * 매도 규칙을 우선순위 순으로 평가.
 * 첫 번째 매칭되는 규칙에서 즉시 반환 (선착순).
 *
 * v4.16.0: ROI Table 지원. settings.roiTable이 있으면 Rule 1+4가 통합되어
 *   시간 경과에 따라 감쇠하는 익절 임계값으로 작동 (freqtrade 스타일).
 *   테이블 없으면 기존 Rule 1(고정 targetProfitRate) + Rule 4(maxHoldMinutes) 유지.
 */
export function evaluateSellRules(ctx: HoldingContext): SellRuleResult {
  const settings = getSettings();

  if (!settings.sellRulesEnabled) {
    return { shouldSell: false };
  }

  const buyTs = getBuyTimestamp(ctx.stockId);
  const holdingMinutes = buyTs ? (Date.now() - buyTs.getTime()) / 60_000 : 0;

  // Rule 1: ROI Table 또는 고정 targetProfitRate로 익절 판정
  if (settings.roiTable && settings.roiTable.length > 0) {
    const threshold = getRoiThresholdAt(holdingMinutes, settings.roiTable);
    if (threshold !== null && ctx.unrealizedPnLPercent >= threshold) {
      return {
        shouldSell: true,
        rule: 'TARGET_PROFIT',
        reason: `ROI Table (t=${Math.round(holdingMinutes)}분, ${ctx.unrealizedPnLPercent.toFixed(1)}% ≥ ${threshold}%)`,
      };
    }
  } else if (ctx.unrealizedPnLPercent >= settings.targetProfitRate) {
    return {
      shouldSell: true,
      rule: 'TARGET_PROFIT',
      reason: `목표 수익률 도달 (${ctx.unrealizedPnLPercent.toFixed(1)}% ≥ ${settings.targetProfitRate}%)`,
    };
  }

  // Rule 2: 손절 매도
  if (ctx.unrealizedPnLPercent <= -settings.hardStopLossRate) {
    return {
      shouldSell: true,
      rule: 'STOP_LOSS',
      reason: `손절 (${ctx.unrealizedPnLPercent.toFixed(1)}% ≤ -${settings.hardStopLossRate}%)`,
    };
  }

  // Rule 3: 트레일링 스탑 매도
  const peak = updatePeakPrice(ctx.stockId, ctx.currentPrice);
  if (peak > 0) {
    const dropFromPeak = ((peak - ctx.currentPrice) / peak) * 100;
    if (dropFromPeak >= settings.trailingStopRate) {
      return {
        shouldSell: true,
        rule: 'TRAILING_STOP',
        reason: `트레일링 스탑 (고점 ${peak.toLocaleString()} → 현재 ${ctx.currentPrice.toLocaleString()}, -${dropFromPeak.toFixed(1)}% ≥ ${settings.trailingStopRate}%)`,
      };
    }
  }

  // Rule 4: 보유 시간 초과 매도 — ROI Table이 없을 때만 단독 적용.
  // ROI Table이 있으면 table의 마지막 항목이 "시간 초과 강매도" 역할을 이미 수행.
  if (!settings.roiTable && buyTs) {
    if (holdingMinutes >= settings.maxHoldMinutes) {
      return {
        shouldSell: true,
        rule: 'HOLDING_TIME',
        reason: `보유 시간 초과 (${Math.round(holdingMinutes)}분 ≥ ${settings.maxHoldMinutes}분)`,
      };
    }
  }

  return { shouldSell: false };
}
