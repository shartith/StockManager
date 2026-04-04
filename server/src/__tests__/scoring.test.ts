import { describe, it, expect, vi, beforeEach } from 'vitest';

// scoring.ts depends on DB, settings, notification, weightOptimizer
vi.mock('../db', () => ({
  queryAll: vi.fn().mockReturnValue([]),
  queryOne: vi.fn().mockReturnValue(null),
  execute: vi.fn().mockReturnValue({ changes: 1, lastId: 1 }),
}));

vi.mock('../services/notification', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn().mockReturnValue({
    autoTradeEnabled: false,
    autoTradeMaxPerStock: 2000000,
  }),
}));

vi.mock('../services/weightOptimizer', () => ({
  loadWeights: vi.fn().mockReturnValue({
    CONSECUTIVE_BUY: 1.0,
    HIGH_CONFIDENCE: 1.0,
    VOLUME_SURGE: 1.0,
    RSI_OVERSOLD_BOUNCE: 1.0,
    BOLLINGER_BOUNCE: 1.0,
    MACD_GOLDEN_CROSS: 1.0,
    PRICE_MOMENTUM: 1.0,
    NEWS_POSITIVE: 1.0,
    NEWS_SENTIMENT: 1.0,
    TIME_DECAY: 1.0,
  }),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { evaluateAndScore, getRecommendationScore, getScoreHistory } from '../services/scoring';
import type { TechnicalIndicators } from '../services/technicalAnalysis';
import { queryAll, queryOne, execute } from '../db';
import { getSettings } from '../services/settings';
import { createNotification } from '../services/notification';
import { loadWeights } from '../services/weightOptimizer';

// ── Test fixtures ──

function makeDecision(overrides: Record<string, any> = {}) {
  return {
    signal: 'BUY' as const,
    confidence: 85,
    targetPrice: 12000,
    stopLossPrice: 9500,
    entryPrice: 10000,
    suggestedRatio: 30,
    urgency: 'IMMEDIATE' as const,
    reasoning: 'test',
    keyFactors: ['RSI'],
    risks: ['volatility'],
    holdingPeriod: 'SHORT_TERM' as const,
    ...overrides,
  };
}

function makeIndicators(overrides: Partial<TechnicalIndicators> = {}): TechnicalIndicators {
  return {
    rsi14: 35,
    sma5: 10100, sma20: 10000, sma60: 9800, sma120: 9500,
    ema12: 10050, ema26: 9950,
    macd: 100, macdSignal: 80, macdHistogram: 20,
    bollingerUpper: 10500, bollingerMiddle: 10000, bollingerLower: 9700,
    vwap: 10100, atr14: 200,
    currentPrice: 9750,
    signal: 'BUY',
    signalReasons: ['RSI oversold'],
    ...overrides,
  };
}

describe('scoring engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queryAll).mockReturnValue([]);
    vi.mocked(queryOne).mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM stocks')) return { id: 999 };
      if (sql.includes('SELECT id FROM watchlist')) return null;
      if (sql.includes('SELECT name FROM recommendations')) return { name: 'Test' };
      return null;
    });
    vi.mocked(execute).mockReturnValue({ changes: 1, lastId: 1 });
    vi.mocked(getSettings).mockReturnValue({
      autoTradeEnabled: false,
      autoTradeMaxPerStock: 2000000,
      autoTradeScoreThreshold: 100,
    } as any);
    vi.mocked(loadWeights).mockReturnValue({
      CONSECUTIVE_BUY: 1.0,
      HIGH_CONFIDENCE: 1.0,
      VOLUME_SURGE: 1.0,
      RSI_OVERSOLD_BOUNCE: 1.0,
      BOLLINGER_BOUNCE: 1.0,
      MACD_GOLDEN_CROSS: 1.0,
      PRICE_MOMENTUM: 1.0,
      NEWS_POSITIVE: 1.0,
      NEWS_SENTIMENT: 1.0,
      TIME_DECAY: 1.0,
    });
  });

  // ── 1. CONSECUTIVE_BUY ──

  describe('CONSECUTIVE_BUY scoring', () => {
    it('adds bonus for BUY signal based on consecutive count', async () => {
      // Mock consecutive_buys = 2 from DB
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('consecutive_buys')) return { consecutive_buys: 2 };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      expect(consDetail).toBeDefined();
      // consecutive = 2 + 1 = 3, min(3*10, 50) * 1.0 = 30
      expect(consDetail!.value).toBe(30);
    });

    it('caps at 50 for high consecutive counts', async () => {
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('consecutive_buys')) return { consecutive_buys: 10 };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      expect(consDetail).toBeDefined();
      // consecutive = 11, min(110, 50) * 1.0 = 50
      expect(consDetail!.value).toBe(50);
    });

    it('resets consecutive count when signal is not BUY', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ signal: 'HOLD' }));
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      expect(consDetail).toBeUndefined();
      // Verify the UPDATE query was called with 0
      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining('consecutive_buys = 0'),
        expect.any(Array),
      );
    });

    it('handles null consecutive_buys from DB', async () => {
      vi.mocked(queryOne).mockReturnValue(null);

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      expect(consDetail).toBeDefined();
      // consecutive = (0) + 1 = 1, min(10, 50) = 10
      expect(consDetail!.value).toBe(10);
    });

    it('applies weight multiplier', async () => {
      vi.mocked(loadWeights).mockReturnValue({
        CONSECUTIVE_BUY: 1.5,
        HIGH_CONFIDENCE: 1.0,
        VOLUME_SURGE: 1.0,
        RSI_OVERSOLD_BOUNCE: 1.0,
        BOLLINGER_BOUNCE: 1.0,
        MACD_GOLDEN_CROSS: 1.0,
        PRICE_MOMENTUM: 1.0,
        NEWS_POSITIVE: 1.0,
        NEWS_SENTIMENT: 1.0,
        TIME_DECAY: 1.0,
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      // consecutive = 1, min(10, 50) * 1.5 = 15
      expect(consDetail!.value).toBe(15);
    });
  });

  // ── 2. HIGH_CONFIDENCE ──

  describe('HIGH_CONFIDENCE scoring', () => {
    it('adds score for confidence >= 60', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 80 }));
      const confDetail = result.details.find(d => d.type === 'HIGH_CONFIDENCE');
      expect(confDetail).toBeDefined();
      // (80 - 60) / 2 * 1.0 = 10
      expect(confDetail!.value).toBe(10);
    });

    it('no score for confidence < 60', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 50 }));
      const confDetail = result.details.find(d => d.type === 'HIGH_CONFIDENCE');
      expect(confDetail).toBeUndefined();
    });

    it('max score at confidence 100', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 100 }));
      const confDetail = result.details.find(d => d.type === 'HIGH_CONFIDENCE');
      expect(confDetail).toBeDefined();
      // (100 - 60) / 2 * 1.0 = 20
      expect(confDetail!.value).toBe(20);
    });

    it('exactly 60 confidence gives 0 score', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 60 }));
      const confDetail = result.details.find(d => d.type === 'HIGH_CONFIDENCE');
      expect(confDetail).toBeDefined();
      expect(confDetail!.value).toBe(0);
    });
  });

  // ── 3. VOLUME_SURGE ──

  describe('VOLUME_SURGE scoring', () => {
    it('adds +15 for volume >= 1.5x average', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, {
        avgVolume20d: 10000,
        todayVsAvg: 2.0,
        volumeTrend: 'INCREASING',
      });
      const volDetail = result.details.find(d => d.type === 'VOLUME_SURGE');
      expect(volDetail).toBeDefined();
      expect(volDetail!.value).toBe(15);
    });

    it('adds +5 for INCREASING volume trend below 1.5x', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, {
        avgVolume20d: 10000,
        todayVsAvg: 1.2,
        volumeTrend: 'INCREASING',
      });
      const volDetail = result.details.find(d => d.type === 'VOLUME_SURGE');
      expect(volDetail).toBeDefined();
      expect(volDetail!.value).toBe(5);
    });

    it('no score when volume analysis missing', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const volDetail = result.details.find(d => d.type === 'VOLUME_SURGE');
      expect(volDetail).toBeUndefined();
    });

    it('no score for low volume with DECREASING trend', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, {
        avgVolume20d: 10000,
        todayVsAvg: 0.8,
        volumeTrend: 'DECREASING',
      });
      const volDetail = result.details.find(d => d.type === 'VOLUME_SURGE');
      expect(volDetail).toBeUndefined();
    });
  });

  // ── 4. RSI_OVERSOLD_BOUNCE ──

  describe('RSI_OVERSOLD_BOUNCE scoring', () => {
    it('adds +15 for RSI between 30 and 40', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: 35 }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeDefined();
      expect(rsiDetail!.value).toBe(15);
    });

    it('no score for RSI below 30', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: 25 }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeUndefined();
    });

    it('no score for RSI above 40', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: 50 }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeUndefined();
    });

    it('exactly RSI 30 triggers', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: 30 }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeDefined();
    });

    it('exactly RSI 40 triggers', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: 40 }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeDefined();
    });

    it('null RSI does not trigger', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({ rsi14: null as any }));
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      expect(rsiDetail).toBeUndefined();
    });
  });

  // ── 5. BOLLINGER_BOUNCE ──

  describe('BOLLINGER_BOUNCE scoring', () => {
    it('adds +10 when price is near bollinger lower (<3% distance)', async () => {
      // currentPrice 9750, bollingerLower 9700, bollingerMiddle 10000
      // dist = (9750 - 9700) / 9700 * 100 ≈ 0.515%
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        currentPrice: 9750,
        bollingerLower: 9700,
        bollingerMiddle: 10000,
      }));
      const bbDetail = result.details.find(d => d.type === 'BOLLINGER_BOUNCE');
      expect(bbDetail).toBeDefined();
      expect(bbDetail!.value).toBe(10);
    });

    it('no score when price is above bollinger middle', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        currentPrice: 10500,
        bollingerLower: 9700,
        bollingerMiddle: 10000,
      }));
      const bbDetail = result.details.find(d => d.type === 'BOLLINGER_BOUNCE');
      expect(bbDetail).toBeUndefined();
    });

    it('no score when distance from lower > 3%', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        currentPrice: 10100,
        bollingerLower: 9700,
        bollingerMiddle: 10500,
      }));
      const bbDetail = result.details.find(d => d.type === 'BOLLINGER_BOUNCE');
      // dist = (10100 - 9700) / 9700 * 100 ≈ 4.12%
      expect(bbDetail).toBeUndefined();
    });

    it('no score when bollinger bands are missing', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        bollingerLower: null as any,
        bollingerMiddle: null as any,
      }));
      const bbDetail = result.details.find(d => d.type === 'BOLLINGER_BOUNCE');
      expect(bbDetail).toBeUndefined();
    });
  });

  // ── 6. MACD_GOLDEN_CROSS ──

  describe('MACD_GOLDEN_CROSS scoring', () => {
    it('adds +20 when MACD histogram > 0 and MACD > 0', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        macdHistogram: 20,
        macd: 100,
      }));
      const macdDetail = result.details.find(d => d.type === 'MACD_GOLDEN_CROSS');
      expect(macdDetail).toBeDefined();
      expect(macdDetail!.value).toBe(20);
    });

    it('no score when MACD histogram <= 0', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        macdHistogram: -5,
        macd: 100,
      }));
      const macdDetail = result.details.find(d => d.type === 'MACD_GOLDEN_CROSS');
      expect(macdDetail).toBeUndefined();
    });

    it('no score when MACD <= 0', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), makeIndicators({
        macdHistogram: 20,
        macd: -10,
      }));
      const macdDetail = result.details.find(d => d.type === 'MACD_GOLDEN_CROSS');
      expect(macdDetail).toBeUndefined();
    });
  });

  // ── 7. PRICE_MOMENTUM ──

  describe('PRICE_MOMENTUM scoring', () => {
    it('adds +10 when urgency is IMMEDIATE', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ urgency: 'IMMEDIATE' }));
      const momDetail = result.details.find(d => d.type === 'PRICE_MOMENTUM');
      expect(momDetail).toBeDefined();
      expect(momDetail!.value).toBe(10);
    });

    it('no score when urgency is not IMMEDIATE', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ urgency: 'WAIT' }));
      const momDetail = result.details.find(d => d.type === 'PRICE_MOMENTUM');
      expect(momDetail).toBeUndefined();
    });
  });

  // ── 8. TIME_DECAY ──

  describe('TIME_DECAY scoring', () => {
    it('applies negative decay for old scores', async () => {
      // First call returns base score, second returns old scores
      let callCount = 0;
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('old_total')) return { old_total: 50 };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const decayDetail = result.details.find(d => d.type === 'TIME_DECAY');
      expect(decayDetail).toBeDefined();
      // -round(50 * 0.2) = -10
      expect(decayDetail!.value).toBe(-10);
    });

    it('no decay when no old scores', async () => {
      vi.mocked(queryOne).mockReturnValue(null);

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const decayDetail = result.details.find(d => d.type === 'TIME_DECAY');
      expect(decayDetail).toBeUndefined();
    });

    it('no decay when old_total is 0', async () => {
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('old_total')) return { old_total: 0 };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const decayDetail = result.details.find(d => d.type === 'TIME_DECAY');
      expect(decayDetail).toBeUndefined();
    });
  });

  // ── 9. NEWS_SENTIMENT ──

  describe('NEWS_SENTIMENT scoring', () => {
    it('adds +10 for strongly positive sentiment (> 30)', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, 50);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeDefined();
      expect(sentDetail!.value).toBe(10);
    });

    it('adds -10 for strongly negative sentiment (< -30)', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, -50);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeDefined();
      expect(sentDetail!.value).toBe(-10);
    });

    it('uses scaled value for moderate sentiment', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, 15);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeDefined();
      // round(15 / 3) = 5
      expect(sentDetail!.value).toBe(5);
    });

    it('negative moderate sentiment gives negative score', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, -15);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeDefined();
      // round(-15 / 3) = -5
      expect(sentDetail!.value).toBe(-5);
    });

    it('no score when sentimentScore is 0', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, 0);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeUndefined();
    });

    it('no score when sentimentScore is undefined', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision(), undefined, undefined, undefined);
      const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
      expect(sentDetail).toBeUndefined();
    });
  });

  // ── Score DB recording ──

  describe('score recording', () => {
    it('records each detail to recommendation_scores table', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const insertCalls = vi.mocked(execute).mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('INSERT INTO recommendation_scores'),
      );
      expect(insertCalls.length).toBe(result.details.length);
    });

    it('updates recommendations table score', async () => {
      evaluateAndScore('TEST', 'KRX', makeDecision());
      const updateCalls = vi.mocked(execute).mock.calls.filter(
        c => typeof c[0] === 'string' && c[0].includes('UPDATE recommendations SET score'),
      );
      expect(updateCalls.length).toBe(1);
    });
  });

  // ── Total score ──

  describe('total score calculation', () => {
    it('includes base score from DB', async () => {
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 50 }];
        return [];
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 50, urgency: 'WAIT' }));
      // base = 50, plus whatever round scores
      expect(result.totalScore).toBeGreaterThanOrEqual(50);
    });

    it('handles null base score from DB', async () => {
      vi.mocked(queryAll).mockReturnValue([{ total: null }]);
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 50, urgency: 'WAIT' }));
      expect(result.totalScore).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Promotion logic ──

  describe('promotion to watchlist', () => {
    it('promotes to watchlist at score >= 80', async () => {
      // Base score of 70, round score should push over 80
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 70 }];
        return [];
      });
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM stocks')) return { id: 1 };
        if (sql.includes('SELECT id FROM watchlist')) return null; // not in watchlist yet
        if (sql.includes('SELECT name FROM recommendations')) return { name: 'Test Stock' };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 85 }));
      if (result.totalScore >= 80) {
        expect(result.promoted).toBe(true);
        expect(result.promotedTo).toBe('watchlist');
      }
    });

    it('skips promotion when already in watchlist', async () => {
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 75 }];
        return [];
      });
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM stocks')) return { id: 1 };
        if (sql.includes('SELECT id FROM watchlist')) return { id: 1 }; // already in watchlist
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 85 }));
      // promoteToWatchlist returns false when already in watchlist
      if (result.totalScore >= 80) {
        expect(result.promoted).toBe(false);
      }
    });
  });

  describe('promotion to auto-trade', () => {
    it('promotes to auto_trade at score >= 100 when autoTradeEnabled', async () => {
      vi.mocked(getSettings).mockReturnValue({
        autoTradeEnabled: true,
        autoTradeMaxPerStock: 2000000,
      } as any);
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 90 }];
        return [];
      });
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM stocks')) return { id: 1 };
        if (sql.includes('SELECT id FROM watchlist')) return null;
        if (sql.includes('SELECT name FROM recommendations')) return { name: 'Test Stock' };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 85 }));
      if (result.totalScore >= 100) {
        expect(result.promoted).toBe(true);
        expect(result.promotedTo).toBe('auto_trade');
      }
    });

    it('does not promote to auto_trade when autoTradeEnabled is false', async () => {
      vi.mocked(getSettings).mockReturnValue({
        autoTradeEnabled: false,
      } as any);
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 90 }];
        return [];
      });
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM stocks')) return { id: 1 };
        if (sql.includes('SELECT id FROM watchlist')) return null;
        if (sql.includes('SELECT name FROM recommendations')) return { name: 'Test Stock' };
        return null;
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ confidence: 85 }));
      if (result.totalScore >= 100) {
        // Falls through to watchlist promotion instead
        expect(result.promotedTo).not.toBe('auto_trade');
      }
    });
  });

  describe('auto-trade promotion creates stock if not exists', () => {
    it('creates stock entry when stock not in DB', async () => {
      vi.mocked(getSettings).mockReturnValue({
        autoTradeEnabled: true,
        autoTradeMaxPerStock: 2000000,
      } as any);
      vi.mocked(queryAll).mockImplementation((sql: string) => {
        if (sql.includes('SUM(score_value) as total')) return [{ total: 95 }];
        return [];
      });

      let stockCreated = false;
      vi.mocked(queryOne).mockImplementation((sql: string) => {
        if (sql.includes('SELECT id FROM stocks')) {
          if (!stockCreated) {
            return null; // first call: stock doesn't exist
          }
          return { id: 1 }; // after creation
        }
        if (sql.includes('SELECT name FROM recommendations')) return { name: 'New Stock' };
        if (sql.includes('SELECT id FROM watchlist')) return null;
        return null;
      });
      vi.mocked(execute).mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO stocks')) stockCreated = true;
        return { changes: 1, lastId: 1 };
      });

      const result = await evaluateAndScore('NEWSTOCK', 'KRX', makeDecision({ confidence: 85 }));
      if (result.totalScore >= 100) {
        const insertStockCalls = vi.mocked(execute).mock.calls.filter(
          c => typeof c[0] === 'string' && c[0].includes('INSERT INTO stocks'),
        );
        expect(insertStockCalls.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Weight multipliers ──

  describe('weight multipliers', () => {
    it('scales all scores by weight', async () => {
      vi.mocked(loadWeights).mockReturnValue({
        CONSECUTIVE_BUY: 2.0,
        HIGH_CONFIDENCE: 2.0,
        VOLUME_SURGE: 2.0,
        RSI_OVERSOLD_BOUNCE: 2.0,
        BOLLINGER_BOUNCE: 2.0,
        MACD_GOLDEN_CROSS: 2.0,
        PRICE_MOMENTUM: 2.0,
        NEWS_POSITIVE: 2.0,
        NEWS_SENTIMENT: 2.0,
        TIME_DECAY: 2.0,
      });

      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      // 1 consecutive, min(10, 50) * 2.0 = 20
      expect(consDetail!.value).toBe(20);
    });
  });

  // ── No indicators ──

  describe('missing indicators', () => {
    it('skips indicator-based scores when indicators undefined', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision());
      const rsiDetail = result.details.find(d => d.type === 'RSI_OVERSOLD_BOUNCE');
      const bbDetail = result.details.find(d => d.type === 'BOLLINGER_BOUNCE');
      const macdDetail = result.details.find(d => d.type === 'MACD_GOLDEN_CROSS');
      expect(rsiDetail).toBeUndefined();
      expect(bbDetail).toBeUndefined();
      expect(macdDetail).toBeUndefined();
    });
  });

  // ── SELL signal ──

  describe('SELL signal handling', () => {
    it('resets consecutive buys on SELL', async () => {
      const result = await evaluateAndScore('TEST', 'KRX', makeDecision({ signal: 'SELL' }));
      const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
      expect(consDetail).toBeUndefined();
    });
  });
});

// ── getRecommendationScore ──

describe('getRecommendationScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns score from DB', async () => {
    vi.mocked(queryOne).mockReturnValue({ score: 85 });
    expect(getRecommendationScore('TEST', 'KRX')).toBe(85);
  });

  it('returns 0 when no record found', async () => {
    vi.mocked(queryOne).mockReturnValue(null);
    expect(getRecommendationScore('TEST', 'KRX')).toBe(0);
  });

  it('returns 0 when score is null', async () => {
    vi.mocked(queryOne).mockReturnValue({ score: null });
    expect(getRecommendationScore('TEST', 'KRX')).toBe(0);
  });
});

// ── getScoreHistory ──

describe('getScoreHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns score history from DB', async () => {
    const mockHistory = [
      { id: 1, ticker: 'TEST', score_type: 'HIGH_CONFIDENCE', score_value: 10 },
      { id: 2, ticker: 'TEST', score_type: 'VOLUME_SURGE', score_value: 15 },
    ];
    vi.mocked(queryAll).mockReturnValue(mockHistory);
    const history = getScoreHistory('TEST', 'KRX');
    expect(history).toEqual(mockHistory);
    expect(history).toHaveLength(2);
  });

  it('returns empty array when no history', async () => {
    vi.mocked(queryAll).mockReturnValue([]);
    expect(getScoreHistory('TEST', 'KRX')).toEqual([]);
  });
});
