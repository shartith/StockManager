import { describe, it, expect, vi } from 'vitest';

// scoring.ts는 DB 의존이 있어 모킹 필요
vi.mock('../db', () => ({
  queryAll: vi.fn().mockReturnValue([]),
  queryOne: vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT id FROM stocks')) return { id: 1 };
    if (sql.includes('SELECT id FROM watchlist')) return { id: 1 }; // 이미 관심종목에 있는 것으로
    return null;
  }),
  execute: vi.fn().mockReturnValue({ lastId: 1 }),
}));

vi.mock('../services/notification', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn().mockReturnValue({
    autoTradeEnabled: true,
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

import { evaluateAndScore } from '../services/scoring';
import type { TechnicalIndicators } from '../services/technicalAnalysis';

const mockDecision = {
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
};

const mockIndicators: TechnicalIndicators = {
  rsi14: 35,
  sma5: 10100, sma20: 10000, sma60: 9800, sma120: 9500,
  ema12: 10050, ema26: 9950,
  macd: 100, macdSignal: 80, macdHistogram: 20,
  bollingerUpper: 10500, bollingerMiddle: 10000, bollingerLower: 9700,
  vwap: 10100, atr14: 200,
  currentPrice: 9750,
  signal: 'BUY',
  signalReasons: ['RSI 과매도'],
};

describe('스코어링 엔진', () => {
  it('BUY 신호에 점수 부여', () => {
    const result = evaluateAndScore('TEST', 'KRX', mockDecision, mockIndicators);
    expect(result.totalScore).toBeGreaterThan(0);
    expect(result.details.length).toBeGreaterThan(0);
  });

  it('HIGH_CONFIDENCE 점수 포함', () => {
    const result = evaluateAndScore('TEST', 'KRX', mockDecision, mockIndicators);
    const confDetail = result.details.find(d => d.type === 'HIGH_CONFIDENCE');
    expect(confDetail).toBeDefined();
    expect(confDetail!.value).toBeGreaterThan(0);
  });

  it('감성 점수 반영', () => {
    const result = evaluateAndScore('TEST', 'KRX', mockDecision, mockIndicators, undefined, 50);
    const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
    expect(sentDetail).toBeDefined();
    expect(sentDetail!.value).toBe(10); // 50 > 30 → +10
  });

  it('부정 감성 점수 반영', () => {
    const result = evaluateAndScore('TEST', 'KRX', mockDecision, mockIndicators, undefined, -50);
    const sentDetail = result.details.find(d => d.type === 'NEWS_SENTIMENT');
    expect(sentDetail).toBeDefined();
    expect(sentDetail!.value).toBe(-10); // -50 < -30 → -10
  });

  it('HOLD 신호면 CONSECUTIVE_BUY 리셋', () => {
    const holdDecision = { ...mockDecision, signal: 'HOLD' as const, confidence: 40 };
    const result = evaluateAndScore('TEST', 'KRX', holdDecision, mockIndicators);
    const consDetail = result.details.find(d => d.type === 'CONSECUTIVE_BUY');
    expect(consDetail).toBeUndefined(); // HOLD이므로 연속 BUY 보너스 없음
  });
});
