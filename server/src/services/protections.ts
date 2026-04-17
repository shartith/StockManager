/**
 * v4.16.0: Protection 시스템 (freqtrade 영감)
 *
 * 개별 주문 차단(kisOrder.isSuspendedToday)이 아닌 **전략 수준 circuit breaker**.
 * 전략이 망가지고 있다는 신호를 감지해 자동매매 자체를 일시 정지한다.
 *
 * 3가지 Protection:
 *   1. StoplossGuard   — 최근 N시간 내 M건 손절 → 전체 BUY 차단
 *   2. CooldownPeriod  — 특정 종목 최근 거래 후 N분간 재진입 금지
 *   3. LowProfitPairs  — 종목 최근 K거래 누적 수익률 <X% → 해당 종목 BUY 차단
 *
 * 결과:
 *   - 차단: reason 문자열 반환
 *   - 허용: null 반환
 */

import { queryOne, queryAll } from '../db';
import { getSettings } from './settings';
import { getLatestBacktest, isBacktestFresh } from './backtester';
import logger from '../logger';

export interface ProtectionContext {
  stockId: number;
  ticker: string;
  market?: string;
  orderType: 'BUY' | 'SELL';
}

export interface ProtectionConfig {
  stoplossGuard: {
    enabled: boolean;
    lookbackHours: number;   // 검사 기간 (시간)
    stopLossLimit: number;   // 이 횟수 이상 손절 → 차단
  };
  cooldownPeriod: {
    enabled: boolean;
    cooldownMinutes: number; // 거래 후 재진입 금지 시간
  };
  lowProfitPairs: {
    enabled: boolean;
    lookbackTrades: number;  // 최근 K거래 참조
    requiredProfitPercent: number; // 이 % 미만이면 차단
  };
  // v4.17.0: 백테스트 profit_factor 기반 차단
  backtestReject: {
    enabled: boolean;
    minProfitFactor: number;  // PF가 이 값 미만이면 차단 (기본 0.8)
    maxAgeHours: number;      // 백테스트 나이 제한
    minTrades: number;        // 통계적 유의성 최소 거래 수
  };
}

/** 기본값 — 보수적으로 설정. 사용자가 overrides 가능. */
export const DEFAULT_PROTECTION_CONFIG: ProtectionConfig = {
  stoplossGuard: {
    enabled: true,
    lookbackHours: 6,
    stopLossLimit: 3, // 6시간 내 3건 손절 → 전체 매매 정지
  },
  cooldownPeriod: {
    enabled: true,
    cooldownMinutes: 30, // 매매 후 30분 재진입 금지
  },
  lowProfitPairs: {
    enabled: true,
    lookbackTrades: 5, // 최근 5거래
    requiredProfitPercent: -5.0, // 누적 수익률 <-5%면 차단
  },
  backtestReject: {
    enabled: true,
    minProfitFactor: 0.8,  // PF<0.8 = 거래비용 제외 시 손실. 매수 금지
    maxAgeHours: 168,      // 7일 이내 백테스트만 유효
    minTrades: 5,          // 5거래 미만은 통계적 유의성 부족
  },
};

export function getProtectionConfig(): ProtectionConfig {
  const s = getSettings() as any;
  const user = s.protections || {};
  return {
    stoplossGuard: {
      ...DEFAULT_PROTECTION_CONFIG.stoplossGuard,
      ...(user.stoplossGuard || {}),
    },
    cooldownPeriod: {
      ...DEFAULT_PROTECTION_CONFIG.cooldownPeriod,
      ...(user.cooldownPeriod || {}),
    },
    lowProfitPairs: {
      ...DEFAULT_PROTECTION_CONFIG.lowProfitPairs,
      ...(user.lowProfitPairs || {}),
    },
    backtestReject: {
      ...DEFAULT_PROTECTION_CONFIG.backtestReject,
      ...(user.backtestReject || {}),
    },
  };
}

// ─── 개별 Protection ──────────────────────────────────

/** 1. StoplossGuard — 최근 N시간 내 손절 M건 초과 시 전체 BUY 차단.
 *  SELL은 허용 (포지션 청산 자유). */
function checkStoplossGuard(
  ctx: ProtectionContext,
  cfg: ProtectionConfig['stoplossGuard']
): string | null {
  if (!cfg.enabled) return null;
  if (ctx.orderType !== 'BUY') return null; // SELL은 통과

  // "손절"로 청산된 거래 = transactions의 SELL 중 memo에 '손절'/'STOP'/'stop' 포함,
  // 또는 auto_trades에서 sellRules 발동 기록. 가장 확실한 신호는 최근 SELL 중
  // 실제 손실이 발생한 건.
  //
  // transactions 기반으로 N시간 내 손실 SELL을 집계:
  //   - 같은 종목에서 BUY 평균가 < SELL 가격? 아님, 그냥 memo에 손절 포함 확인이 빠름
  //   - 단순화: memo LIKE '%손절%' OR memo LIKE '%stop%' (auto_trades의 stop)
  const row = queryOne(
    `SELECT COUNT(*) AS cnt FROM transactions
     WHERE type = 'SELL'
       AND deleted_at IS NULL
       AND created_at >= datetime('now', '-${cfg.lookbackHours} hours')
       AND (memo LIKE '%손절%' OR memo LIKE '%STOP_LOSS%' OR memo LIKE '%stop_loss%')`,
  );
  const stopLossCount = row?.cnt ?? 0;
  if (stopLossCount >= cfg.stopLossLimit) {
    return `StoplossGuard: 최근 ${cfg.lookbackHours}시간 내 손절 ${stopLossCount}건 ≥ ${cfg.stopLossLimit} — 전체 매수 차단`;
  }
  return null;
}

/** 2. CooldownPeriod — 특정 종목의 최근 거래 후 N분간 재진입 금지. */
function checkCooldownPeriod(
  ctx: ProtectionContext,
  cfg: ProtectionConfig['cooldownPeriod']
): string | null {
  if (!cfg.enabled) return null;
  if (ctx.orderType !== 'BUY') return null; // 재진입 개념이라 BUY만

  const row = queryOne(
    `SELECT created_at FROM auto_trades
     WHERE stock_id = ?
       AND created_at >= datetime('now', '-${cfg.cooldownMinutes} minutes')
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.stockId],
  );
  if (row?.created_at) {
    const last = new Date(row.created_at).getTime();
    const elapsedMin = Math.floor((Date.now() - last) / 60_000);
    const remaining = cfg.cooldownMinutes - elapsedMin;
    return `CooldownPeriod: ${ctx.ticker} 최근 거래 ${elapsedMin}분 전 — ${remaining}분 후 재진입 가능`;
  }
  return null;
}

/** 3. LowProfitPairs — 종목 최근 K거래 누적 수익률 <X% 이면 해당 종목 BUY 차단. */
function checkLowProfitPairs(
  ctx: ProtectionContext,
  cfg: ProtectionConfig['lowProfitPairs']
): string | null {
  if (!cfg.enabled) return null;
  if (ctx.orderType !== 'BUY') return null;

  // 최근 K건의 BUY→SELL 쌍에서 실현 수익률 계산.
  // signal_performance가 비어있을 수 있으므로 transactions 기반으로 추정.
  // 단순화: 같은 stock_id의 최근 K건 SELL 메모에서 % 추출 시도, 없으면 현재가 대비 avg.
  const recentSells = queryAll(
    `SELECT memo, price, quantity FROM transactions
     WHERE stock_id = ? AND type = 'SELL' AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ?`,
    [ctx.stockId, cfg.lookbackTrades],
  );
  if (recentSells.length < cfg.lookbackTrades) return null; // 샘플 부족

  // memo에서 "+N.N%" 또는 "-N.N%" 패턴 추출
  let totalPnlPct = 0;
  let count = 0;
  for (const s of recentSells) {
    const m = (s.memo || '').match(/[+-]?\d+\.\d+\s*%/);
    if (m) {
      const pct = parseFloat(m[0].replace('%', ''));
      if (!Number.isNaN(pct)) {
        totalPnlPct += pct;
        count++;
      }
    }
  }
  if (count < cfg.lookbackTrades) return null; // 파싱 실패한 건 skip

  const avgPnl = totalPnlPct / count;
  if (avgPnl < cfg.requiredProfitPercent) {
    return `LowProfitPairs: ${ctx.ticker} 최근 ${count}거래 평균 수익률 ${avgPnl.toFixed(1)}% < ${cfg.requiredProfitPercent}% — 해당 종목 매수 차단`;
  }
  return null;
}

/** 4. BacktestReject — 종목의 최신 백테스트 profit_factor가 임계값 미만이면 BUY 차단.
 *  "실시간 매수 결정"이 아닌 "전략이 이 종목에 통하지 않는다"는 구조적 필터.
 *  신선도(ageHours) + 통계 유의성(minTrades) 체크 포함. 백테스트 없으면 통과. */
function checkBacktestReject(
  ctx: ProtectionContext,
  cfg: ProtectionConfig['backtestReject']
): string | null {
  if (!cfg.enabled) return null;
  if (ctx.orderType !== 'BUY') return null; // SELL은 통과
  if (!ctx.market) return null;              // market 정보 없으면 스킵

  const bt = getLatestBacktest(ctx.ticker, ctx.market);
  if (!isBacktestFresh(bt, { maxAgeHours: cfg.maxAgeHours, minTrades: cfg.minTrades })) {
    return null; // 백테스트 없거나 오래됨/소표본 → 판단 보류 (통과)
  }

  const pf = bt!.profitFactor ?? 0;
  if (pf < cfg.minProfitFactor) {
    return `BacktestReject: ${ctx.ticker} 백테스트 PF ${pf.toFixed(2)} < ${cfg.minProfitFactor} (거래 ${bt!.totalTrades}건, 수익률 ${bt!.totalReturn.toFixed(1)}%, 승률 ${bt!.winRate}%)`;
  }
  return null;
}

// ─── 통합 체크 ────────────────────────────────────────

export interface ProtectionResult {
  allowed: boolean;
  reason?: string;
  protectionName?: string;
}

/** 모든 Protection을 순차 평가. 하나라도 차단이면 즉시 반환. */
export function checkProtections(ctx: ProtectionContext): ProtectionResult {
  const cfg = getProtectionConfig();

  const stoplossReason = checkStoplossGuard(ctx, cfg.stoplossGuard);
  if (stoplossReason) {
    return { allowed: false, reason: stoplossReason, protectionName: 'StoplossGuard' };
  }

  const cooldownReason = checkCooldownPeriod(ctx, cfg.cooldownPeriod);
  if (cooldownReason) {
    return { allowed: false, reason: cooldownReason, protectionName: 'CooldownPeriod' };
  }

  const lowProfitReason = checkLowProfitPairs(ctx, cfg.lowProfitPairs);
  if (lowProfitReason) {
    return { allowed: false, reason: lowProfitReason, protectionName: 'LowProfitPairs' };
  }

  const backtestReason = checkBacktestReject(ctx, cfg.backtestReject);
  if (backtestReason) {
    return { allowed: false, reason: backtestReason, protectionName: 'BacktestReject' };
  }

  return { allowed: true };
}

/** 차단 시 system_events 기록 + log. */
export async function logProtectionBlock(ctx: ProtectionContext, result: ProtectionResult): Promise<void> {
  if (result.allowed) return;
  try {
    const { logSystemEvent } = await import('./systemEvent');
    await logSystemEvent(
      'INFO',
      'PROTECTION_BLOCKED',
      `${result.protectionName} 차단: ${ctx.ticker}`,
      result.reason ?? '',
      ctx.ticker
    );
  } catch (err) {
    logger.error({ err, ctx, result }, 'Protection block logging failed');
  }
}
