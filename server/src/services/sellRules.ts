/**
 * 매도 규칙 엔진 (v5.1.0).
 *
 * 우선순위 순으로 평가, 선착 매도:
 *   1. TARGET_PROFIT     — Rule 7-1: 목표 수익률 (예: +3%)
 *   2. TRAILING_STOP     — Rule 7-2: 트레일링 활성 후 고점 대비 낙폭 (sticky activation)
 *   3. STOP_LOSS         — Rule 6: 손절선 이탈
 *   4. STAGNANT_TIME     — Rule 7+8 통합: +trailingActivatePercent 미달 + 1시간 경과 → 매도
 *   5. LOSS_TIME         — Rule 9: 손실 상태 + 1시간 경과 → 강제 손절
 *
 * v5.1 변경:
 *   - 트레일링은 sticky: 한번 +trailingActivatePercent 도달하면 계속 활성, 비활성 안 됨
 *   - SIDEWAYS_PROFIT 제거, STAGNANT_TIME으로 단순화 (수익률 무관 1시간 정체)
 *   - 수익 정의를 profitThresholdPercent (default 0.5%) 기준으로 — 수수료 보전
 *   - peakPrice / trailing_active는 intradayState (DB) 영구화
 *
 * EOD 룰(Rule 10/11)은 dailyStrategy.ts.
 */

import { queryOne } from '../db';
import { getSettings } from './settings';
import { getState, updatePeak, markSold } from './intradayState';

// ── Types ──

export type SellRule =
  | 'TARGET_PROFIT'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'STAGNANT_TIME'
  | 'LOSS_TIME'
  // v5.4.0 Entry/Exit Plan 룰
  | 'PARTIAL_T1'         // 1차 목표 도달 → 50% 분할 익절
  | 'FULL_T2'            // 2차 목표 도달 → 잔여 전량 익절
  | 'DYNAMIC_SL'         // 지지선 - ATR×0.5 이탈 → 동적 손절
  | 'SL_BE_LOCK'         // BE 잠금 후 매수가 이탈 → 무손실 청산
  // v5.4.0 패턴 룰
  | 'BEARISH_PATTERN'    // 일봉 약세 패턴 출현 → 추세 약화 청산
  | 'CONTEXT_DEFENSIVE'  // 시장 컨텍스트 방어 모드 + 소수익/손실 → 조기 청산
  | 'CONTEXT_CRITICAL';  // 시장 컨텍스트 위기 모드 → 무조건 청산

export interface SellRuleResult {
  shouldSell: boolean;
  rule?: SellRule;
  reason?: string;
  /** 부분 매도 비율 (0.0 ~ 1.0). 미지정이면 전량(1.0). */
  partialRatio?: number;
}

export interface HoldingContext {
  stockId: number;
  ticker: string;
  currentPrice: number;
  avgPrice: number;
  quantity: number;
  unrealizedPnLPercent: number;
  /** 현재 포지션이 시작된 시점 (lot tracking 기반). 미지정 시 DB fallback 으로 추정. */
  positionOpenedAt?: string | null;
  /** 일봉 약세 패턴 검출 결과. 호출자가 비동기 fetch 후 주입. */
  bearishPattern?: { pattern: string; description: string } | null;
  /** v5.4.0 — 시장 컨텍스트 평가 (NORMAL / DEFENSIVE / CRITICAL). 호출자가 marketContextMonitor 에서 주입. */
  contextLevel?: 'NORMAL' | 'DEFENSIVE' | 'CRITICAL';
  contextReason?: string;
}

// ── Buy timestamp ──

/**
 * 현재 포지션의 시작 시점.
 * 우선순위:
 *   1) ctx.positionOpenedAt (lot tracking 결과 — 가장 정확)
 *   2) auto_trades 의 가장 최근 FILLED BUY (datetime)
 *   3) transactions 의 가장 최근 BUY 의 created_at
 *
 * BUG FIX: 기존 fallback 이 transactions.date (날짜만) 을 사용해 자정으로 파싱 →
 * 매수 직후라도 KST 09:00 기준으로 1시간 누적 시 LOSS_TIME 오발. created_at 으로 교체.
 */
export function getBuyTimestamp(stockId: number, positionOpenedAt?: string | null): Date | null {
  if (positionOpenedAt) return new Date(positionOpenedAt);

  const autoTrade = queryOne<{ created_at: string }>(
    "SELECT created_at FROM auto_trades WHERE stock_id = ? AND order_type = 'BUY' AND status = 'FILLED' ORDER BY datetime(created_at) DESC LIMIT 1",
    [stockId],
  );
  if (autoTrade?.created_at) return new Date(autoTrade.created_at);

  const tx = queryOne<{ created_at: string }>(
    "SELECT created_at FROM transactions WHERE stock_id = ? AND type = 'BUY' AND deleted_at IS NULL ORDER BY datetime(created_at) DESC, id DESC LIMIT 1",
    [stockId],
  );
  if (tx?.created_at) return new Date(tx.created_at);

  return null;
}

/** Public — 매도 후 호출. peak/trailing 정리. */
export function resetPeakPrice(stockId: number): void {
  markSold(stockId);
}

// ── 핵심 평가 ──

export function evaluateSellRules(ctx: HoldingContext): SellRuleResult {
  const settings = getSettings();
  if (!settings.sellRulesEnabled) return { shouldSell: false };

  const profitThresh = settings.profitThresholdPercent ?? 0.5;
  const trailingActivate = settings.trailingActivatePercent ?? 3.0;

  // 트레일링 활성 여부 결정 — peak 갱신과 함께 처리.
  // +trailingActivatePercent 도달 시 활성 (sticky).
  const shouldActivate = ctx.unrealizedPnLPercent >= trailingActivate;
  const peak = updatePeak(ctx.stockId, ctx.currentPrice, shouldActivate);
  const state = getState(ctx.stockId);
  const trailingActive = state?.trailingActive ?? false;

  // ── 시장 컨텍스트 (v5.4.0) — 시장 전반 위기 시 보유분 보호 ──
  // CRITICAL: 무조건 청산 (KOSPI -2%/세션고점 OR VIX > 30)
  // DEFENSIVE + PnL ≤ +0.5%: 조기 청산 (수익 미보장 상태에서 시장 약세)
  if (ctx.contextLevel === 'CRITICAL') {
    return {
      shouldSell: true,
      rule: 'CONTEXT_CRITICAL',
      reason: `시장 위기 컨텍스트 — 보유분 일괄 청산 (${ctx.contextReason ?? ''}, PnL ${ctx.unrealizedPnLPercent.toFixed(1)}%)`,
    };
  }
  if (ctx.contextLevel === 'DEFENSIVE' && ctx.unrealizedPnLPercent <= 0.5) {
    return {
      shouldSell: true,
      rule: 'CONTEXT_DEFENSIVE',
      reason: `시장 방어 컨텍스트 + 수익 미보장 — 조기 청산 (${ctx.contextReason ?? ''}, PnL ${ctx.unrealizedPnLPercent.toFixed(1)}%)`,
    };
  }

  // ── 약세 패턴 (v5.4.0) — 일봉 차트 약세 신호 + 손실/소수익 상태일 때 조기 청산 ──
  // 큰 수익 중인 종목까지 패턴만으로 끊지 않도록 PnL < +1% 일 때만 발동.
  // DEFENSIVE 컨텍스트에서는 임계값을 +2% 까지 확장 (시장 약세 시 조기 보호).
  const bearishPnLThreshold = ctx.contextLevel === 'DEFENSIVE' ? 2.0 : 1.0;
  if (ctx.bearishPattern && ctx.unrealizedPnLPercent < bearishPnLThreshold) {
    return {
      shouldSell: true,
      rule: 'BEARISH_PATTERN',
      reason: `약세 캔들 패턴 (${ctx.bearishPattern.description}) — 추세 약화로 조기 청산 (PnL ${ctx.unrealizedPnLPercent.toFixed(1)}%)`,
    };
  }

  // ── Entry/Exit Plan 룰 (v5.4.0) — 사용자가 사전 계산한 가격 기반 ──
  // STOP_LOSS / TARGET_PROFIT 보다 우선 평가 (더 정밀한 가격 기반 룰).
  if (state) {
    // PARTIAL_T1 — 1차 목표 미도달 시 50% 분할 익절 (한 번만)
    if (state.t1Target !== null && !state.t1Filled && ctx.currentPrice >= state.t1Target) {
      return {
        shouldSell: true,
        rule: 'PARTIAL_T1',
        reason: `1차 목표가 ${state.t1Target.toLocaleString()} 도달 (현재 ${ctx.currentPrice.toLocaleString()}, +${ctx.unrealizedPnLPercent.toFixed(1)}%) — 50% 분할 익절`,
        partialRatio: 0.5,
      };
    }
    // FULL_T2 — 2차 목표 도달 시 잔여 전량 익절
    if (state.t2Target !== null && ctx.currentPrice >= state.t2Target) {
      return {
        shouldSell: true,
        rule: 'FULL_T2',
        reason: `2차 목표가 ${state.t2Target.toLocaleString()} 도달 (현재 ${ctx.currentPrice.toLocaleString()}, +${ctx.unrealizedPnLPercent.toFixed(1)}%) — 잔여 전량 익절`,
      };
    }
    // SL_BE_LOCK — SL이 BE로 이동된 상태에서 매수가 이탈 시 무손실 청산
    if (state.slMovedToBE && state.dynamicSL !== null && ctx.currentPrice <= state.dynamicSL) {
      return {
        shouldSell: true,
        rule: 'SL_BE_LOCK',
        reason: `BE 잠금 발동 (매수가 ${state.dynamicSL.toLocaleString()} 이탈, 현재 ${ctx.currentPrice.toLocaleString()}) — 무손실 청산`,
      };
    }
    // DYNAMIC_SL — 지지선 - ATR×0.5 이탈 시 (BE 이동 전, 평단 -2% 임계보다 먼저 작동 가능)
    if (!state.slMovedToBE && state.dynamicSL !== null && ctx.currentPrice <= state.dynamicSL) {
      return {
        shouldSell: true,
        rule: 'DYNAMIC_SL',
        reason: `동적 손절선 ${state.dynamicSL.toLocaleString()} 이탈 (현재 ${ctx.currentPrice.toLocaleString()}) — 추세 이탈`,
      };
    }
  }

  // Rule 7-1: 목표 수익률 도달 → 즉시 익절
  if (ctx.unrealizedPnLPercent >= settings.targetProfitRate) {
    return {
      shouldSell: true,
      rule: 'TARGET_PROFIT',
      reason: `목표 수익률 도달 (${ctx.unrealizedPnLPercent.toFixed(1)}% ≥ ${settings.targetProfitRate}%)`,
    };
  }

  // Rule 7-2: 트레일링 스탑 — 활성된 경우만 평가
  if (trailingActive && peak > 0) {
    const dropFromPeak = ((peak - ctx.currentPrice) / peak) * 100;
    if (dropFromPeak >= settings.trailingStopRate) {
      return {
        shouldSell: true,
        rule: 'TRAILING_STOP',
        reason: `트레일링 스탑 (활성됨, 고점 ${peak.toLocaleString()} → ${ctx.currentPrice.toLocaleString()}, -${dropFromPeak.toFixed(1)}% ≥ ${settings.trailingStopRate}%)`,
      };
    }
  }

  // Rule 6: 손절선 이탈
  if (ctx.unrealizedPnLPercent <= -settings.hardStopLossRate) {
    return {
      shouldSell: true,
      rule: 'STOP_LOSS',
      reason: `손절 (${ctx.unrealizedPnLPercent.toFixed(1)}% ≤ -${settings.hardStopLossRate}%)`,
    };
  }

  // Rule 7+8: STAGNANT_TIME — trailingActivate 미달 + sidewaysMinutes 경과 + 수익 상태
  // 사용자 안: "+3% 미달 + 1시간 정체 → 매도"
  const buyTs = getBuyTimestamp(ctx.stockId, ctx.positionOpenedAt);
  if (buyTs) {
    const heldMin = (Date.now() - buyTs.getTime()) / 60_000;
    const sidewaysMin = settings.sidewaysMinutes ?? 60;
    if (heldMin >= sidewaysMin
        && !trailingActive
        && ctx.unrealizedPnLPercent >= profitThresh
        && ctx.unrealizedPnLPercent < trailingActivate) {
      return {
        shouldSell: true,
        rule: 'STAGNANT_TIME',
        reason: `정체 청산 (${Math.round(heldMin)}분 보유, +${ctx.unrealizedPnLPercent.toFixed(1)}% < ${trailingActivate}%, 트레일링 미활성)`,
      };
    }
  }

  // Rule 9: LOSS_TIME — 손실 상태 + lossMinutes 경과
  if (buyTs && ctx.unrealizedPnLPercent < 0) {
    const heldMin = (Date.now() - buyTs.getTime()) / 60_000;
    const lossMin = settings.lossMinutes ?? 60;
    if (heldMin >= lossMin) {
      return {
        shouldSell: true,
        rule: 'LOSS_TIME',
        reason: `손실 시간초과 (${Math.round(heldMin)}분 손실 유지, ${ctx.unrealizedPnLPercent.toFixed(1)}%)`,
      };
    }
  }

  return { shouldSell: false };
}
