import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB and settings for applyTradingRules tests
vi.mock('../db', () => ({
  queryAll: vi.fn().mockReturnValue([]),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn().mockReturnValue({
    tradingRulesEnabled: true,
    tradingRulesStrictMode: false,
    gapThresholdPercent: 3,
    volumeSurgeRatio: 1.5,
    lowVolumeRatio: 0.7,
    sidewaysAtrPercent: 1.0,
  }),
}));

import {
  applyTradingRules,
  buildPriceContext,
  buildMarketTimeContext,
  type MarketTimeContext,
  type PriceContext,
  type TradingRuleConfig,
} from '../services/tradingRules';
import { queryAll } from '../db';
import { getSettings } from '../services/settings';

// ── Test helpers ──

function makeTimeContext(overrides: Partial<MarketTimeContext> = {}): MarketTimeContext {
  return {
    phase: 'INTRADAY',
    hour: 10,
    minute: 30,
    isAfternoon: false,
    isPreClose30min: false,
    ...overrides,
  };
}

function makePriceContext(overrides: Partial<PriceContext> = {}): PriceContext {
  return {
    gapPercent: 0,
    intradayChangePercent: 0,
    isAtHigh: false,
    isAtLow: false,
    volumeRatio: 1.0,
    atrPercent: 2.0,
    lastCandleDirection: 'NEUTRAL',
    supportBroken: false,
    ...overrides,
  };
}

function makeSignal(signal: 'BUY' | 'SELL' | 'HOLD' = 'BUY', confidence = 70) {
  return { signal, confidence };
}

function makeRule(ruleId: string, category: 'TIME' | 'VOLUME' | 'VOLATILITY' | 'CANDLE' | 'SUPPORT' = 'TIME'): TradingRuleConfig {
  return {
    rule_id: ruleId,
    name: ruleId,
    description: '',
    category,
    is_enabled: true,
    params: {},
  };
}

function mockEnabledRules(ruleIds: string[]) {
  const categoryMap: Record<string, 'TIME' | 'VOLUME' | 'VOLATILITY' | 'CANDLE' | 'SUPPORT'> = {
    MORNING_SURGE_SELL: 'TIME',
    AFTERNOON_SURGE_NO_BUY: 'TIME',
    MORNING_DROP_NO_SELL: 'TIME',
    AFTERNOON_DROP_BUY_OPPORTUNITY: 'TIME',
    OPEN_SURGE_NO_BUY: 'TIME',
    PRECLOSE_SURGE_PARTIAL_SELL: 'TIME',
    LOW_VOLUME_SURGE_BUY: 'VOLUME',
    HIGH_VOLUME_SURGE_SELL: 'VOLUME',
    LOW_LOW_VOLUME_HOLD: 'VOLUME',
    HIGH_LOW_VOLUME_WAIT: 'VOLUME',
    SIDEWAYS_NO_TRADE: 'VOLATILITY',
    CANDLE_BUY_FILTER: 'CANDLE',
    CANDLE_SELL_FILTER: 'CANDLE',
    SUPPORT_BREAK_STOP_LOSS: 'SUPPORT',
  };
  vi.mocked(queryAll).mockReturnValue(
    ruleIds.map((id, i) => ({
      rule_id: id,
      name: id,
      description: '',
      category: categoryMap[id] || 'TIME',
      is_enabled: 1,
      priority: i,
      params_json: '{}',
    }))
  );
}

// ── buildPriceContext tests ──

describe('buildPriceContext', () => {
  describe('gap percent calculation', () => {
    it('positive gap (today open > yesterday close)', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 105, high: 110, low: 103, close: 108, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 108, {});
      expect(ctx.gapPercent).toBe(5);
    });

    it('negative gap (today open < yesterday close)', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 95, high: 100, low: 90, close: 92, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 92, {});
      expect(ctx.gapPercent).toBe(-5);
    });

    it('zero gap (today open = yesterday close)', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 105, low: 95, close: 102, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 102, {});
      expect(ctx.gapPercent).toBe(0);
    });

    it('zero previous close returns 0 gap', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 0, volume: 1000 },
        { open: 105, high: 110, low: 103, close: 108, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 108, {});
      expect(ctx.gapPercent).toBe(0);
    });
  });

  describe('intraday change percent', () => {
    it('positive intraday change', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 115, low: 98, close: 110, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 110, {});
      // (110 - 100) / 100 * 100 = 10%
      expect(ctx.intradayChangePercent).toBe(10);
    });

    it('negative intraday change', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 102, low: 88, close: 90, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 90, {});
      // (90 - 100) / 100 * 100 = -10%
      expect(ctx.intradayChangePercent).toBe(-10);
    });

    it('zero intraday change', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 102, low: 98, close: 100, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 100, {});
      expect(ctx.intradayChangePercent).toBe(0);
    });

    it('zero open price returns 0 intraday change', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 0, high: 50, low: 0, close: 50, volume: 1200 },
      ];
      const ctx = buildPriceContext(candles, 50, {});
      expect(ctx.intradayChangePercent).toBe(0);
    });
  });

  describe('volume ratio', () => {
    it('surge volume (>1.5x average)', () => {
      const candles = Array.from({ length: 20 }, () => ({
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      candles.push({ open: 100, high: 110, low: 95, close: 108, volume: 3000 });
      const ctx = buildPriceContext(candles, 108, {});
      expect(ctx.volumeRatio).toBeGreaterThan(1.5);
    });

    it('low volume (<0.7x average)', () => {
      const candles = Array.from({ length: 20 }, () => ({
        open: 100, high: 105, low: 95, close: 100, volume: 1000,
      }));
      candles.push({ open: 100, high: 102, low: 98, close: 101, volume: 200 });
      const ctx = buildPriceContext(candles, 101, {});
      expect(ctx.volumeRatio).toBeLessThan(0.7);
    });

    it('normal volume', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 105, low: 95, close: 102, volume: 1000 },
      ];
      const ctx = buildPriceContext(candles, 102, {});
      expect(ctx.volumeRatio).toBe(1);
    });

    it('zero average volume defaults ratio to 1', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 0 },
        { open: 100, high: 105, low: 95, close: 102, volume: 0 },
      ];
      const ctx = buildPriceContext(candles, 102, {});
      expect(ctx.volumeRatio).toBe(1);
    });
  });

  describe('RSI-based high/low detection', () => {
    const twoCandles = [
      { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
      { open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    ];

    it('RSI > 70 marks isAtHigh', () => {
      const ctx = buildPriceContext(twoCandles, 102, { rsi14: 75 });
      expect(ctx.isAtHigh).toBe(true);
      expect(ctx.isAtLow).toBe(false);
    });

    it('RSI < 30 marks isAtLow', () => {
      const ctx = buildPriceContext(twoCandles, 102, { rsi14: 25 });
      expect(ctx.isAtHigh).toBe(false);
      expect(ctx.isAtLow).toBe(true);
    });

    it('RSI between 30 and 70 is normal', () => {
      const ctx = buildPriceContext(twoCandles, 102, { rsi14: 50 });
      expect(ctx.isAtHigh).toBe(false);
      expect(ctx.isAtLow).toBe(false);
    });

    it('RSI exactly 70 is not high', () => {
      const ctx = buildPriceContext(twoCandles, 102, { rsi14: 70 });
      expect(ctx.isAtHigh).toBe(false);
    });

    it('RSI exactly 30 is not low', () => {
      const ctx = buildPriceContext(twoCandles, 102, { rsi14: 30 });
      expect(ctx.isAtLow).toBe(false);
    });

    it('uses RSI14 (uppercase) as fallback key', () => {
      const ctx = buildPriceContext(twoCandles, 102, { RSI14: 75 });
      expect(ctx.isAtHigh).toBe(true);
    });

    it('defaults RSI to 50 when no indicator provided', () => {
      const ctx = buildPriceContext(twoCandles, 102, {});
      expect(ctx.isAtHigh).toBe(false);
      expect(ctx.isAtLow).toBe(false);
    });
  });

  describe('ATR percent', () => {
    const twoCandles = [
      { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
      { open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    ];

    it('calculates ATR percent correctly', () => {
      const ctx = buildPriceContext(twoCandles, 200, { atr14: 10 });
      // (10 / 200) * 100 = 5%
      expect(ctx.atrPercent).toBe(5);
    });

    it('uses ATR14 (uppercase) as fallback', () => {
      const ctx = buildPriceContext(twoCandles, 200, { ATR14: 10 });
      expect(ctx.atrPercent).toBe(5);
    });

    it('zero current price defaults ATR percent to 1', () => {
      const ctx = buildPriceContext(twoCandles, 0, { atr14: 10 });
      expect(ctx.atrPercent).toBe(1);
    });

    it('no ATR indicator defaults to 0', () => {
      const ctx = buildPriceContext(twoCandles, 100, {});
      // atr defaults to 0, so (0/100)*100 = 0
      expect(ctx.atrPercent).toBe(0);
    });
  });

  describe('candle direction', () => {
    it('UP when close > open', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 110, low: 98, close: 108, volume: 1200 },
      ];
      expect(buildPriceContext(candles, 108, {}).lastCandleDirection).toBe('UP');
    });

    it('DOWN when close < open', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 108, high: 110, low: 95, close: 98, volume: 1200 },
      ];
      expect(buildPriceContext(candles, 98, {}).lastCandleDirection).toBe('DOWN');
    });

    it('NEUTRAL when close = open', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 110, low: 90, close: 100, volume: 1200 },
      ];
      expect(buildPriceContext(candles, 100, {}).lastCandleDirection).toBe('NEUTRAL');
    });
  });

  describe('support broken', () => {
    const twoCandles = [
      { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
      { open: 100, high: 105, low: 95, close: 98, volume: 1000 },
    ];

    it('support broken when below both SMA20 and SMA60', () => {
      const ctx = buildPriceContext(twoCandles, 85, { sma20: 100, sma60: 110 });
      expect(ctx.supportBroken).toBe(true);
    });

    it('support not broken when above SMA20', () => {
      const ctx = buildPriceContext(twoCandles, 105, { sma20: 100, sma60: 110 });
      expect(ctx.supportBroken).toBe(false);
    });

    it('support not broken when above SMA60', () => {
      const ctx = buildPriceContext(twoCandles, 95, { sma20: 100, sma60: 90 });
      expect(ctx.supportBroken).toBe(false);
    });

    it('uses SMA20/SMA60 (uppercase) as fallback', () => {
      const ctx = buildPriceContext(twoCandles, 85, { SMA20: 100, SMA60: 110 });
      expect(ctx.supportBroken).toBe(true);
    });

    it('defaults SMA to currentPrice (no support break)', () => {
      const ctx = buildPriceContext(twoCandles, 100, {});
      expect(ctx.supportBroken).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('empty candles array returns default context', () => {
      const ctx = buildPriceContext([], 100, {});
      expect(ctx.gapPercent).toBe(0);
      expect(ctx.intradayChangePercent).toBe(0);
      expect(ctx.isAtHigh).toBe(false);
      expect(ctx.isAtLow).toBe(false);
      expect(ctx.volumeRatio).toBe(1);
      expect(ctx.atrPercent).toBe(1);
      expect(ctx.lastCandleDirection).toBe('NEUTRAL');
      expect(ctx.supportBroken).toBe(false);
    });

    it('single candle returns default context', () => {
      const ctx = buildPriceContext(
        [{ open: 100, high: 105, low: 95, close: 102, volume: 1000 }],
        102,
        {},
      );
      expect(ctx.gapPercent).toBe(0);
      expect(ctx.lastCandleDirection).toBe('NEUTRAL');
    });

    it('zero current price', () => {
      const candles = [
        { open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        { open: 100, high: 105, low: 95, close: 102, volume: 1000 },
      ];
      const ctx = buildPriceContext(candles, 0, {});
      expect(ctx.intradayChangePercent).toBeCloseTo(-100, 0);
      expect(ctx.atrPercent).toBe(1);
    });
  });
});

// ── buildMarketTimeContext tests ──

describe('buildMarketTimeContext', () => {
  it('passes phase through correctly', () => {
    const ctx = buildMarketTimeContext('KRX', 'MARKET_OPEN');
    expect(ctx.phase).toBe('MARKET_OPEN');
  });

  it('returns current hour and minute', () => {
    const ctx = buildMarketTimeContext('KRX', 'INTRADAY');
    const now = new Date();
    expect(ctx.hour).toBe(now.getHours());
    expect(ctx.minute).toBe(now.getMinutes());
  });

  it('KRX: isAfternoon true at hour >= 14', () => {
    // We can only test the function output based on current time,
    // but we can verify the logic by checking the returned value matches expectations
    const ctx = buildMarketTimeContext('KRX', 'INTRADAY');
    const now = new Date();
    expect(ctx.isAfternoon).toBe(now.getHours() >= 14);
  });

  it('NYSE: isAfternoon true at hour >= 13', () => {
    const ctx = buildMarketTimeContext('NYSE', 'INTRADAY');
    const now = new Date();
    expect(ctx.isAfternoon).toBe(now.getHours() >= 13);
  });

  it('KRX: isPreClose30min true at 15:00+', () => {
    const ctx = buildMarketTimeContext('KRX', 'INTRADAY');
    const now = new Date();
    const expected = (now.getHours() === 15 && now.getMinutes() >= 0) || now.getHours() > 15;
    expect(ctx.isPreClose30min).toBe(expected);
  });

  it('NYSE: isPreClose30min true at 15:30+', () => {
    const ctx = buildMarketTimeContext('NYSE', 'INTRADAY');
    const now = new Date();
    const expected = (now.getHours() === 15 && now.getMinutes() >= 30) || now.getHours() > 15;
    expect(ctx.isPreClose30min).toBe(expected);
  });

  it('unknown market defaults to NYSE logic', () => {
    const ctx = buildMarketTimeContext('UNKNOWN', 'INTRADAY');
    const now = new Date();
    expect(ctx.isAfternoon).toBe(now.getHours() >= 13);
  });
});

// ── applyTradingRules tests ──

describe('applyTradingRules', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockReturnValue({
      tradingRulesEnabled: true,
      tradingRulesStrictMode: false,
      gapThresholdPercent: 3,
      volumeSurgeRatio: 1.5,
      lowVolumeRatio: 0.7,
      sidewaysAtrPercent: 1.0,
    } as any);
    vi.mocked(queryAll).mockReturnValue([]);
  });

  describe('disabled rules', () => {
    it('returns ALLOW with no changes when tradingRulesEnabled is false', () => {
      vi.mocked(getSettings).mockReturnValue({ tradingRulesEnabled: false } as any);
      const result = applyTradingRules(makeSignal('BUY'), makeTimeContext(), makePriceContext(), false);
      expect(result.action).toBe('ALLOW');
      expect(result.adjustedSignal).toBe('BUY');
      expect(result.triggeredRules).toHaveLength(0);
      expect(result.reasoning).toBe('매매 원칙 비활성화 상태');
    });
  });

  describe('no rules triggered', () => {
    it('returns ALLOW when no rules match', () => {
      mockEnabledRules(['MORNING_SURGE_SELL']);
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext({ isAfternoon: true }), // morning rule won't trigger in afternoon
        makePriceContext(),
        false,
      );
      expect(result.action).toBe('ALLOW');
      expect(result.triggeredRules).toHaveLength(0);
      expect(result.reasoning).toBe('적용된 규칙 없음');
    });
  });

  describe('Rule 1: MORNING_SURGE_SELL', () => {
    beforeEach(() => mockEnabledRules(['MORNING_SURGE_SELL']));

    it('triggers when morning + gap >= threshold + holding + not sell', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.adjustedSignal).toBe('SELL');
      expect(result.triggeredRules).toContain('MORNING_SURGE_SELL');
      expect(result.confidenceAdjustment).toBe(15);
    });

    it('does not trigger when already SELL', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('MORNING_SURGE_SELL');
    });

    it('does not trigger when not holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('MORNING_SURGE_SELL');
    });

    it('does not trigger in afternoon', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('MORNING_SURGE_SELL');
    });

    it('does not trigger when gap below threshold', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 2 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('MORNING_SURGE_SELL');
    });
  });

  describe('Rule 2: AFTERNOON_SURGE_NO_BUY', () => {
    beforeEach(() => mockEnabledRules(['AFTERNOON_SURGE_NO_BUY']));

    it('blocks BUY when afternoon + intraday surge', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ intradayChangePercent: 5 }),
        false,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.confidenceAdjustment).toBe(-20);
      expect(result.triggeredRules).toContain('AFTERNOON_SURGE_NO_BUY');
    });

    it('does not trigger on HOLD signal', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ intradayChangePercent: 5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('AFTERNOON_SURGE_NO_BUY');
    });
  });

  describe('Rule 3: MORNING_DROP_NO_SELL', () => {
    beforeEach(() => mockEnabledRules(['MORNING_DROP_NO_SELL']));

    it('blocks SELL when morning + gap down + holding', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: -5 }),
        true,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.confidenceAdjustment).toBe(-15);
      expect(result.triggeredRules).toContain('MORNING_DROP_NO_SELL');
    });

    it('does not trigger when not holding', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: -5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('MORNING_DROP_NO_SELL');
    });
  });

  describe('Rule 4: AFTERNOON_DROP_BUY_OPPORTUNITY', () => {
    beforeEach(() => mockEnabledRules(['AFTERNOON_DROP_BUY_OPPORTUNITY']));

    it('adds confidence on afternoon drop when HOLD + not holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ intradayChangePercent: -5 }),
        false,
      );
      expect(result.confidenceAdjustment).toBe(10);
      expect(result.triggeredRules).toContain('AFTERNOON_DROP_BUY_OPPORTUNITY');
      // Signal stays HOLD but confidence adjusted
      expect(result.adjustedSignal).toBe('HOLD');
    });

    it('does not trigger when holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ intradayChangePercent: -5 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('AFTERNOON_DROP_BUY_OPPORTUNITY');
    });

    it('does not trigger on BUY signal', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext({ isAfternoon: true }),
        makePriceContext({ intradayChangePercent: -5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('AFTERNOON_DROP_BUY_OPPORTUNITY');
    });
  });

  describe('Rule 5: OPEN_SURGE_NO_BUY', () => {
    beforeEach(() => mockEnabledRules(['OPEN_SURGE_NO_BUY']));

    it('blocks BUY at open hour (<10) with surge', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext({ hour: 9 }),
        makePriceContext({ intradayChangePercent: 5 }),
        false,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.triggeredRules).toContain('OPEN_SURGE_NO_BUY');
    });

    it('does not trigger at hour 10+', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext({ hour: 10 }),
        makePriceContext({ intradayChangePercent: 5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('OPEN_SURGE_NO_BUY');
    });
  });

  describe('Rule 6: PRECLOSE_SURGE_PARTIAL_SELL', () => {
    beforeEach(() => mockEnabledRules(['PRECLOSE_SURGE_PARTIAL_SELL']));

    it('triggers sell when pre-close + intraday >= 2% + holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isPreClose30min: true }),
        makePriceContext({ intradayChangePercent: 3 }),
        true,
      );
      expect(result.adjustedSignal).toBe('SELL');
      expect(result.triggeredRules).toContain('PRECLOSE_SURGE_PARTIAL_SELL');
    });

    it('does not trigger if already SELL', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext({ isPreClose30min: true }),
        makePriceContext({ intradayChangePercent: 3 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('PRECLOSE_SURGE_PARTIAL_SELL');
    });

    it('does not trigger below 2% change', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isPreClose30min: true }),
        makePriceContext({ intradayChangePercent: 1.5 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('PRECLOSE_SURGE_PARTIAL_SELL');
    });
  });

  describe('Rule 7: LOW_VOLUME_SURGE_BUY', () => {
    beforeEach(() => mockEnabledRules(['LOW_VOLUME_SURGE_BUY']));

    it('boosts confidence at low + volume surge', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtLow: true, volumeRatio: 2.0 }),
        false,
      );
      expect(result.confidenceAdjustment).toBe(25);
      expect(result.triggeredRules).toContain('LOW_VOLUME_SURGE_BUY');
    });

    it('does not trigger when not at low', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtLow: false, volumeRatio: 2.0 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('LOW_VOLUME_SURGE_BUY');
    });
  });

  describe('Rule 8: HIGH_VOLUME_SURGE_SELL', () => {
    beforeEach(() => mockEnabledRules(['HIGH_VOLUME_SURGE_SELL']));

    it('triggers sell at high + volume surge + holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ isAtHigh: true, volumeRatio: 2.0 }),
        true,
      );
      expect(result.adjustedSignal).toBe('SELL');
      expect(result.triggeredRules).toContain('HIGH_VOLUME_SURGE_SELL');
    });

    it('does not trigger if already SELL', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext(),
        makePriceContext({ isAtHigh: true, volumeRatio: 2.0 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('HIGH_VOLUME_SURGE_SELL');
    });
  });

  describe('Rule 9: LOW_LOW_VOLUME_HOLD', () => {
    beforeEach(() => mockEnabledRules(['LOW_LOW_VOLUME_HOLD']));

    it('blocks BUY at low + low volume', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtLow: true, volumeRatio: 0.5 }),
        false,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.confidenceAdjustment).toBe(-20);
      expect(result.triggeredRules).toContain('LOW_LOW_VOLUME_HOLD');
    });

    it('does not trigger on HOLD signal', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ isAtLow: true, volumeRatio: 0.5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('LOW_LOW_VOLUME_HOLD');
    });
  });

  describe('Rule 10: HIGH_LOW_VOLUME_WAIT', () => {
    beforeEach(() => mockEnabledRules(['HIGH_LOW_VOLUME_WAIT']));

    it('reduces confidence at high + low volume', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtHigh: true, volumeRatio: 0.5 }),
        false,
      );
      expect(result.confidenceAdjustment).toBe(-15);
      expect(result.triggeredRules).toContain('HIGH_LOW_VOLUME_WAIT');
    });
  });

  describe('Rule 11: SIDEWAYS_NO_TRADE', () => {
    beforeEach(() => mockEnabledRules(['SIDEWAYS_NO_TRADE']));

    it('blocks trading when ATR < sidewaysAtrPercent', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ atrPercent: 0.5 }),
        false,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.confidenceAdjustment).toBe(-25);
      expect(result.triggeredRules).toContain('SIDEWAYS_NO_TRADE');
    });

    it('does not trigger when already HOLD', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ atrPercent: 0.5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('SIDEWAYS_NO_TRADE');
    });

    it('does not trigger when ATR >= threshold', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ atrPercent: 1.5 }),
        false,
      );
      expect(result.triggeredRules).not.toContain('SIDEWAYS_NO_TRADE');
    });
  });

  describe('Rule 12: CANDLE_BUY_FILTER', () => {
    beforeEach(() => mockEnabledRules(['CANDLE_BUY_FILTER']));

    it('boosts confidence on BUY + DOWN candle', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'DOWN' }),
        false,
      );
      expect(result.confidenceAdjustment).toBe(10);
      expect(result.triggeredRules).toContain('CANDLE_BUY_FILTER');
    });

    it('reduces confidence on BUY + UP candle', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'UP' }),
        false,
      );
      expect(result.confidenceAdjustment).toBe(-10);
      expect(result.triggeredRules).toContain('CANDLE_BUY_FILTER');
    });

    it('does not trigger on NEUTRAL candle with BUY', () => {
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'NEUTRAL' }),
        false,
      );
      expect(result.triggeredRules).not.toContain('CANDLE_BUY_FILTER');
    });

    it('does not trigger on SELL signal', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'DOWN' }),
        true,
      );
      expect(result.triggeredRules).not.toContain('CANDLE_BUY_FILTER');
    });
  });

  describe('Rule 13: CANDLE_SELL_FILTER', () => {
    beforeEach(() => mockEnabledRules(['CANDLE_SELL_FILTER']));

    it('blocks SELL on DOWN candle + holding', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'DOWN' }),
        true,
      );
      expect(result.adjustedSignal).toBe('HOLD');
      expect(result.confidenceAdjustment).toBe(-15);
      expect(result.triggeredRules).toContain('CANDLE_SELL_FILTER');
    });

    it('allows SELL on UP candle + holding', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'UP' }),
        true,
      );
      expect(result.adjustedSignal).toBe('SELL');
      expect(result.confidenceAdjustment).toBe(5);
      expect(result.triggeredRules).toContain('CANDLE_SELL_FILTER');
    });

    it('does not trigger when not holding', () => {
      const result = applyTradingRules(
        makeSignal('SELL'),
        makeTimeContext(),
        makePriceContext({ lastCandleDirection: 'DOWN' }),
        false,
      );
      expect(result.triggeredRules).not.toContain('CANDLE_SELL_FILTER');
    });
  });

  describe('Rule 14: SUPPORT_BREAK_STOP_LOSS', () => {
    beforeEach(() => mockEnabledRules(['SUPPORT_BREAK_STOP_LOSS']));

    it('forces SELL when support broken + holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ supportBroken: true }),
        true,
      );
      expect(result.adjustedSignal).toBe('SELL');
      expect(result.confidenceAdjustment).toBe(30);
      expect(result.triggeredRules).toContain('SUPPORT_BREAK_STOP_LOSS');
    });

    it('does not trigger when not holding', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ supportBroken: true }),
        false,
      );
      expect(result.triggeredRules).not.toContain('SUPPORT_BREAK_STOP_LOSS');
    });

    it('does not trigger when support is intact', () => {
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext(),
        makePriceContext({ supportBroken: false }),
        true,
      );
      expect(result.triggeredRules).not.toContain('SUPPORT_BREAK_STOP_LOSS');
    });
  });

  describe('action determination', () => {
    it('returns MODIFY when signal is changed (non-strict)', () => {
      mockEnabledRules(['MORNING_SURGE_SELL']);
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.action).toBe('MODIFY');
    });

    it('returns BLOCK when signal is changed in strict mode', () => {
      vi.mocked(getSettings).mockReturnValue({
        tradingRulesEnabled: true,
        tradingRulesStrictMode: true,
        gapThresholdPercent: 3,
        volumeSurgeRatio: 1.5,
        lowVolumeRatio: 0.7,
        sidewaysAtrPercent: 1.0,
      } as any);
      mockEnabledRules(['MORNING_SURGE_SELL']);
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.action).toBe('BLOCK');
    });

    it('returns MODIFY when only confidence adjusted (no signal change)', () => {
      mockEnabledRules(['HIGH_LOW_VOLUME_WAIT']);
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtHigh: true, volumeRatio: 0.5 }),
        false,
      );
      expect(result.action).toBe('MODIFY');
      expect(result.adjustedSignal).toBe('BUY');
    });

    it('returns ALLOW when nothing triggered', () => {
      mockEnabledRules([]);
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext(),
        false,
      );
      expect(result.action).toBe('ALLOW');
    });
  });

  describe('multiple rules interaction', () => {
    it('combines confidence adjustments from multiple rules', () => {
      mockEnabledRules(['LOW_VOLUME_SURGE_BUY', 'CANDLE_BUY_FILTER']);
      const result = applyTradingRules(
        makeSignal('BUY'),
        makeTimeContext(),
        makePriceContext({ isAtLow: true, volumeRatio: 2.0, lastCandleDirection: 'DOWN' }),
        false,
      );
      // LOW_VOLUME_SURGE_BUY: +25, CANDLE_BUY_FILTER (DOWN): +10
      expect(result.confidenceAdjustment).toBe(35);
      expect(result.triggeredRules).toHaveLength(2);
    });
  });

  describe('settings threshold customization', () => {
    it('uses custom gapThresholdPercent', () => {
      vi.mocked(getSettings).mockReturnValue({
        tradingRulesEnabled: true,
        tradingRulesStrictMode: false,
        gapThresholdPercent: 5, // higher threshold
        volumeSurgeRatio: 1.5,
        lowVolumeRatio: 0.7,
        sidewaysAtrPercent: 1.0,
      } as any);
      mockEnabledRules(['MORNING_SURGE_SELL']);
      // gap 4% is below custom 5% threshold
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 4 }),
        true,
      );
      expect(result.triggeredRules).not.toContain('MORNING_SURGE_SELL');
    });

    it('uses nullish coalescing defaults when settings values missing', () => {
      vi.mocked(getSettings).mockReturnValue({
        tradingRulesEnabled: true,
        tradingRulesStrictMode: false,
        // All threshold values are undefined
      } as any);
      mockEnabledRules(['MORNING_SURGE_SELL']);
      // Should use default gapThresholdPercent = 3
      const result = applyTradingRules(
        makeSignal('HOLD'),
        makeTimeContext({ isAfternoon: false }),
        makePriceContext({ gapPercent: 5 }),
        true,
      );
      expect(result.triggeredRules).toContain('MORNING_SURGE_SELL');
    });
  });
});
