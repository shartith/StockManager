import logger from '../logger';
import { queryAll } from '../db';
import { getSettings } from './settings';

// ── Types ──

export type RuleCategory = 'TIME' | 'VOLUME' | 'VOLATILITY' | 'CANDLE' | 'SUPPORT';

export interface TradingRuleResult {
  action: 'ALLOW' | 'BLOCK' | 'MODIFY';
  originalSignal: 'BUY' | 'SELL' | 'HOLD';
  adjustedSignal: 'BUY' | 'SELL' | 'HOLD';
  confidenceAdjustment: number;
  triggeredRules: string[];
  reasoning: string;
}

export interface MarketTimeContext {
  phase: string;
  hour: number;
  minute: number;
  isAfternoon: boolean;
  isPreClose30min: boolean;
}

export interface PriceContext {
  gapPercent: number;
  intradayChangePercent: number;
  isAtHigh: boolean;
  isAtLow: boolean;
  volumeRatio: number;
  atrPercent: number;
  lastCandleDirection: 'UP' | 'DOWN' | 'NEUTRAL';
  supportBroken: boolean;
}

export interface TradingRuleConfig {
  rule_id: string;
  name: string;
  description: string;
  category: RuleCategory;
  is_enabled: boolean;
  params: Record<string, number>;
}

// ── Rule Loading ──

export function getEnabledRules(): TradingRuleConfig[] {
  const rows = queryAll('SELECT * FROM trading_rules WHERE is_enabled = 1 ORDER BY priority ASC');
  return rows.map((r: any) => ({
    rule_id: r.rule_id,
    name: r.name,
    description: r.description,
    category: r.category,
    is_enabled: !!r.is_enabled,
    params: JSON.parse(r.params_json || '{}'),
  }));
}

export function getAllRules(): TradingRuleConfig[] {
  const rows = queryAll('SELECT * FROM trading_rules ORDER BY priority ASC');
  return rows.map((r: any) => ({
    ...r,
    is_enabled: !!r.is_enabled,
    params: JSON.parse(r.params_json || '{}'),
  }));
}

// ── Core Rule Engine ──

export function applyTradingRules(
  signal: { signal: 'BUY' | 'SELL' | 'HOLD'; confidence: number },
  timeContext: MarketTimeContext,
  priceContext: PriceContext,
  isHolding: boolean,
): TradingRuleResult {
  const settings = getSettings();
  if (!settings.tradingRulesEnabled) {
    return {
      action: 'ALLOW',
      originalSignal: signal.signal,
      adjustedSignal: signal.signal,
      confidenceAdjustment: 0,
      triggeredRules: [],
      reasoning: '매매 원칙 비활성화 상태',
    };
  }

  const rules = getEnabledRules();
  const triggered: string[] = [];
  let adjustedSignal = signal.signal;
  let totalConfidenceAdj = 0;
  const reasons: string[] = [];

  const gapThreshold = settings.gapThresholdPercent ?? 3;
  const volumeSurge = settings.volumeSurgeRatio ?? 1.5;
  const lowVolume = settings.lowVolumeRatio ?? 0.7;
  const sidewaysAtr = settings.sidewaysAtrPercent ?? 1.0;

  for (const rule of rules) {
    switch (rule.rule_id) {
      // ── Rule 1: 아침 폭등 → 절량 매도 ──
      case 'MORNING_SURGE_SELL':
        if (!timeContext.isAfternoon && priceContext.gapPercent >= gapThreshold && isHolding) {
          if (signal.signal !== 'SELL') {
            adjustedSignal = 'SELL';
            totalConfidenceAdj += 15;
            triggered.push(rule.rule_id);
            reasons.push(`아침 갭업 ${priceContext.gapPercent.toFixed(1)}% → 매도 권고`);
          }
        }
        break;

      // ── Rule 2: 오후 폭등 → 추격 매수 금지 ──
      case 'AFTERNOON_SURGE_NO_BUY':
        if (timeContext.isAfternoon && priceContext.intradayChangePercent >= gapThreshold && signal.signal === 'BUY') {
          adjustedSignal = 'HOLD';
          totalConfidenceAdj -= 20;
          triggered.push(rule.rule_id);
          reasons.push(`오후 상승 ${priceContext.intradayChangePercent.toFixed(1)}% → 추격 매수 차단`);
        }
        break;

      // ── Rule 3: 아침 폭락 → 선부른 매도 금지 ──
      case 'MORNING_DROP_NO_SELL':
        if (!timeContext.isAfternoon && priceContext.gapPercent <= -gapThreshold && signal.signal === 'SELL' && isHolding) {
          adjustedSignal = 'HOLD';
          totalConfidenceAdj -= 15;
          triggered.push(rule.rule_id);
          reasons.push(`아침 갭다운 ${priceContext.gapPercent.toFixed(1)}% → 반등 대기`);
        }
        break;

      // ── Rule 4: 오후 폭락 → 내일 저가 매수 기회 ──
      case 'AFTERNOON_DROP_BUY_OPPORTUNITY':
        if (timeContext.isAfternoon && priceContext.intradayChangePercent <= -gapThreshold && !isHolding) {
          if (signal.signal === 'HOLD') {
            totalConfidenceAdj += 10;
            triggered.push(rule.rule_id);
            reasons.push(`오후 하락 ${priceContext.intradayChangePercent.toFixed(1)}% → 익일 매수 기회`);
          }
        }
        break;

      // ── Rule 5: 개장 직후 급등 → 충동 매수 No ──
      case 'OPEN_SURGE_NO_BUY':
        if (timeContext.hour < 10 && priceContext.intradayChangePercent >= gapThreshold && signal.signal === 'BUY') {
          adjustedSignal = 'HOLD';
          totalConfidenceAdj -= 15;
          triggered.push(rule.rule_id);
          reasons.push('개장 직후 급등 → 충동 매수 방지');
        }
        break;

      // ── Rule 6: 장 마감 전 급등 → 일부 익절 ──
      case 'PRECLOSE_SURGE_PARTIAL_SELL':
        if (timeContext.isPreClose30min && priceContext.intradayChangePercent >= 2 && isHolding) {
          if (signal.signal !== 'SELL') {
            adjustedSignal = 'SELL';
            totalConfidenceAdj += 10;
            triggered.push(rule.rule_id);
            reasons.push(`장 마감 전 상승 ${priceContext.intradayChangePercent.toFixed(1)}% → 일부 익절`);
          }
        }
        break;

      // ── Rule 7: 저점 + 거래량 급증 → 과감 매수 ──
      case 'LOW_VOLUME_SURGE_BUY':
        if (priceContext.isAtLow && priceContext.volumeRatio >= volumeSurge) {
          totalConfidenceAdj += 25;
          triggered.push(rule.rule_id);
          reasons.push(`저점 + 거래량 ${priceContext.volumeRatio.toFixed(1)}x → 매수 강화`);
        }
        break;

      // ── Rule 8: 고점 + 거래량 급증 → 신속 매도 ──
      case 'HIGH_VOLUME_SURGE_SELL':
        if (priceContext.isAtHigh && priceContext.volumeRatio >= volumeSurge && isHolding) {
          if (signal.signal !== 'SELL') {
            adjustedSignal = 'SELL';
            totalConfidenceAdj += 15;
            triggered.push(rule.rule_id);
            reasons.push('고점 + 거래량 급증 → 매도 전환');
          }
        }
        break;

      // ── Rule 9: 저점 + 거래량 감소 → 관망 ──
      case 'LOW_LOW_VOLUME_HOLD':
        if (priceContext.isAtLow && priceContext.volumeRatio <= lowVolume) {
          if (signal.signal === 'BUY') {
            adjustedSignal = 'HOLD';
            totalConfidenceAdj -= 20;
            triggered.push(rule.rule_id);
            reasons.push('저점이나 거래량 부족 → 관망');
          }
        }
        break;

      // ── Rule 10: 고점 + 거래량 감소 → 기다리기 ──
      case 'HIGH_LOW_VOLUME_WAIT':
        if (priceContext.isAtHigh && priceContext.volumeRatio <= lowVolume) {
          totalConfidenceAdj -= 15;
          triggered.push(rule.rule_id);
          reasons.push('고점 + 저거래량 → 신중 대기');
        }
        break;

      // ── Rule 11: 횡보장 → 거래 안 함 ──
      case 'SIDEWAYS_NO_TRADE':
        if (priceContext.atrPercent < sidewaysAtr) {
          if (signal.signal !== 'HOLD') {
            adjustedSignal = 'HOLD';
            totalConfidenceAdj -= 25;
            triggered.push(rule.rule_id);
            reasons.push(`ATR ${priceContext.atrPercent.toFixed(2)}% → 횡보장 거래 중단`);
          }
        }
        break;

      // ── Rule 12: 음봉 매수 고려, 양봉 매수 금지 ──
      case 'CANDLE_BUY_FILTER':
        if (signal.signal === 'BUY') {
          if (priceContext.lastCandleDirection === 'DOWN') {
            totalConfidenceAdj += 10;
            triggered.push(rule.rule_id);
            reasons.push('음봉 확인 → 매수 신뢰도 상향');
          } else if (priceContext.lastCandleDirection === 'UP') {
            totalConfidenceAdj -= 10;
            triggered.push(rule.rule_id);
            reasons.push('양봉 상태 → 매수 신뢰도 하향');
          }
        }
        break;

      // ── Rule 13: 양봉 일부 매도, 음봉 매도 금지 ──
      case 'CANDLE_SELL_FILTER':
        if (signal.signal === 'SELL' && isHolding) {
          if (priceContext.lastCandleDirection === 'DOWN') {
            adjustedSignal = 'HOLD';
            totalConfidenceAdj -= 15;
            triggered.push(rule.rule_id);
            reasons.push('음봉 상태 → 매도 보류');
          } else if (priceContext.lastCandleDirection === 'UP') {
            totalConfidenceAdj += 5;
            triggered.push(rule.rule_id);
            reasons.push('양봉 확인 → 매도 허용');
          }
        }
        break;

      // ── Rule 14: 지지선 이탈 → 손절 필수 ──
      case 'SUPPORT_BREAK_STOP_LOSS':
        if (priceContext.supportBroken && isHolding) {
          adjustedSignal = 'SELL';
          totalConfidenceAdj += 30;
          triggered.push(rule.rule_id);
          reasons.push('SMA20+SMA60 하향 돌파 → 즉시 손절');
        }
        break;
    }
  }

  // Determine action
  let action: 'ALLOW' | 'BLOCK' | 'MODIFY' = 'ALLOW';
  if (adjustedSignal !== signal.signal) {
    action = settings.tradingRulesStrictMode ? 'BLOCK' : 'MODIFY';
  } else if (totalConfidenceAdj !== 0) {
    action = 'MODIFY';
  }

  if (triggered.length > 0) {
    logger.info({ triggered, adjustedSignal, totalConfidenceAdj }, '매매 원칙 적용');
  }

  return {
    action,
    originalSignal: signal.signal,
    adjustedSignal,
    confidenceAdjustment: totalConfidenceAdj,
    triggeredRules: triggered,
    reasoning: reasons.join('; ') || '적용된 규칙 없음',
  };
}

// ── Helper: Build PriceContext from analysis data ──

export function buildPriceContext(
  candles: { open: number; high: number; low: number; close: number; volume: number }[],
  currentPrice: number,
  indicators: any,
): PriceContext {
  if (candles.length < 2) {
    return {
      gapPercent: 0,
      intradayChangePercent: 0,
      isAtHigh: false,
      isAtLow: false,
      volumeRatio: 1,
      atrPercent: 1,
      lastCandleDirection: 'NEUTRAL',
      supportBroken: false,
    };
  }

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  // Gap = today open vs yesterday close
  const gapPercent = prevCandle.close > 0
    ? ((lastCandle.open - prevCandle.close) / prevCandle.close) * 100
    : 0;

  // Intraday change
  const intradayChangePercent = lastCandle.open > 0
    ? ((currentPrice - lastCandle.open) / lastCandle.open) * 100
    : 0;

  // Volume ratio (last vs avg 20d)
  const recentVolumes = candles.slice(-20).map(c => c.volume);
  const avgVolume = recentVolumes.length > 0
    ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length
    : 1;
  const volumeRatio = avgVolume > 0 ? lastCandle.volume / avgVolume : 1;

  // RSI-based high/low detection
  const rsi = indicators?.rsi14 ?? indicators?.RSI14 ?? 50;
  const isAtHigh = rsi > 70;
  const isAtLow = rsi < 30;

  // ATR percent
  const atr = indicators?.atr14 ?? indicators?.ATR14 ?? 0;
  const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 1;

  // Last candle direction
  const lastCandleDirection: 'UP' | 'DOWN' | 'NEUTRAL' =
    lastCandle.close > lastCandle.open ? 'UP' :
    lastCandle.close < lastCandle.open ? 'DOWN' : 'NEUTRAL';

  // Support broken (below SMA20 AND SMA60)
  const sma20 = indicators?.sma20 ?? indicators?.SMA20 ?? currentPrice;
  const sma60 = indicators?.sma60 ?? indicators?.SMA60 ?? currentPrice;
  const supportBroken = currentPrice < sma20 && currentPrice < sma60;

  return {
    gapPercent,
    intradayChangePercent,
    isAtHigh,
    isAtLow,
    volumeRatio,
    atrPercent,
    lastCandleDirection,
    supportBroken,
  };
}

// ── Helper: Build MarketTimeContext ──

export function buildMarketTimeContext(market: string, phase: string): MarketTimeContext {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  const isKRX = market === 'KRX';
  const isAfternoon = isKRX ? hour >= 14 : hour >= 13;
  const isPreClose30min = isKRX
    ? (hour === 15 && minute >= 0) || hour > 15
    : (hour === 15 && minute >= 30) || hour > 15;

  return {
    phase,
    hour,
    minute,
    isAfternoon,
    isPreClose30min,
  };
}
