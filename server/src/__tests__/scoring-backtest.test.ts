/**
 * scoring.ts — BACKTEST_* 가점/감점 단위 테스트 (UC-11)
 *
 * v4.17.0 백테스트 파이프라인 통합에서 추가된 두 ScoreType:
 *   - BACKTEST_PROFITABLE (PF ≥ 1.5) → +15
 *   - BACKTEST_UNPROFITABLE (PF < 1.0) → -20
 *
 * getLatestBacktest / isBacktestFresh 를 mock하여 다양한 조합을 검증.
 * freshness·significance 가드 동작, 중립 구간(1.0 ≤ PF < 1.5), 등을 커버.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock 설정 ────────────────────────────────────────────

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
    autoTradeScoreThreshold: 100,
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
    SPREAD_TIGHT: 1.0,
    BOOK_DEPTH_STRONG: 1.0,
    SPREAD_WIDE: 1.0,
    SELL_SIGNAL: 1.0,
    HOLD_SIGNAL: 1.0,
    CONSECUTIVE_HOLD: 1.0,
    CONSECUTIVE_SELL: 1.0,
    LOW_CONFIDENCE: 1.0,
    RANK_DECAY: 1.0,
    BACKTEST_PROFITABLE: 1.0,
    BACKTEST_UNPROFITABLE: 1.0,
  }),
}));

vi.mock('../services/portfolioManager', () => ({
  checkPromotionEligibility: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// backtester 모듈 mock — scoring.ts의 `await import('./backtester')`도 이 mock이 가로챈다
vi.mock('../services/backtester', () => ({
  getLatestBacktest: vi.fn(),
  isBacktestFresh: vi.fn(),
}));

import { evaluateAndScore } from '../services/scoring';
import { getLatestBacktest, isBacktestFresh } from '../services/backtester';

// ─── 픽스처 ──────────────────────────────────────────────

function makeDecision(overrides: Record<string, any> = {}) {
  return {
    signal: 'BUY' as const,
    confidence: 70,
    targetPrice: 12000,
    stopLossPrice: 9500,
    entryPrice: 10000,
    suggestedRatio: 30,
    urgency: 'NO_RUSH' as const,
    reasoning: 'test',
    keyFactors: [],
    risks: [],
    holdingPeriod: 'SHORT_TERM' as const,
    ...overrides,
  };
}

function mockBacktest(
  pf: number | null,
  opts: { totalTrades?: number; winRate?: number; ageHours?: number; fresh?: boolean } = {}
) {
  const { totalTrades = 10, winRate = 50, ageHours = 24, fresh = true } = opts;
  vi.mocked(getLatestBacktest).mockReturnValue({
    profitFactor: pf,
    winRate,
    totalReturn: 5,
    totalTrades,
    maxDrawdown: 10,
    sharpeRatio: 1.0,
    createdAt: new Date().toISOString(),
    ageHours,
  });
  vi.mocked(isBacktestFresh).mockReturnValue(fresh);
}

// ─── 테스트 ───────────────────────────────────────────────

describe('scoring BACKTEST_* (UC-11: 백테스트 기반 필터)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('가점 (BACKTEST_PROFITABLE)', () => {
    it('PF=1.5 정확히 → +15', async () => {
      mockBacktest(1.5);
      const result = await evaluateAndScore('T1', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_PROFITABLE');
      expect(d).toBeDefined();
      expect(d!.value).toBe(15);
    });

    it('PF=2.0 (강한 신호) → +15', async () => {
      mockBacktest(2.0);
      const result = await evaluateAndScore('T2', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_PROFITABLE');
      expect(d!.value).toBe(15);
    });

    it('reason에 PF, 거래수, 승률 포함', async () => {
      mockBacktest(1.8, { totalTrades: 25, winRate: 72 });
      const result = await evaluateAndScore('T3', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_PROFITABLE');
      expect(d!.reason).toContain('1.80');
      expect(d!.reason).toContain('25');
      expect(d!.reason).toContain('72');
    });
  });

  describe('감점 (BACKTEST_UNPROFITABLE)', () => {
    it('PF=0.5 → -20', async () => {
      mockBacktest(0.5);
      const result = await evaluateAndScore('T4', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE');
      expect(d).toBeDefined();
      expect(d!.value).toBe(-20);
    });

    it('PF=0.99 (1.0 바로 아래) → -20', async () => {
      mockBacktest(0.99);
      const result = await evaluateAndScore('T5', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE');
      expect(d!.value).toBe(-20);
    });

    it('PF=null (거래 없음)은 0으로 취급되어 감점', async () => {
      mockBacktest(null);
      const result = await evaluateAndScore('T6', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE');
      expect(d).toBeDefined();
    });

    it('reason에 "전략 미작동" 키워드 포함', async () => {
      mockBacktest(0.3);
      const result = await evaluateAndScore('T7', 'KRX', makeDecision());
      const d = result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE');
      expect(d!.reason).toContain('전략 미작동');
    });
  });

  describe('중립 구간 (1.0 ≤ PF < 1.5)', () => {
    it('PF=1.0 → 가점/감점 모두 없음', async () => {
      mockBacktest(1.0);
      const result = await evaluateAndScore('T8', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_PROFITABLE')).toBeUndefined();
      expect(result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE')).toBeUndefined();
    });

    it('PF=1.25 → 중립', async () => {
      mockBacktest(1.25);
      const result = await evaluateAndScore('T9', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_PROFITABLE')).toBeUndefined();
      expect(result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE')).toBeUndefined();
    });

    it('PF=1.49 (1.5 바로 아래) → 중립', async () => {
      mockBacktest(1.49);
      const result = await evaluateAndScore('T10', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_PROFITABLE')).toBeUndefined();
    });
  });

  describe('Freshness/Significance 가드', () => {
    it('백테스트 결과 없음(null) → 무시', async () => {
      vi.mocked(getLatestBacktest).mockReturnValue(null);
      vi.mocked(isBacktestFresh).mockReturnValue(false);

      const result = await evaluateAndScore('T11', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_PROFITABLE')).toBeUndefined();
      expect(result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE')).toBeUndefined();
    });

    it('isBacktestFresh=false (오래됨) → 무시', async () => {
      mockBacktest(0.3, { fresh: false }); // PF 낮지만 stale
      const result = await evaluateAndScore('T12', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_UNPROFITABLE')).toBeUndefined();
    });

    it('isBacktestFresh=false + 높은 PF → 가점도 안 함', async () => {
      mockBacktest(2.5, { fresh: false });
      const result = await evaluateAndScore('T13', 'KRX', makeDecision());
      expect(result.details.find(x => x.type === 'BACKTEST_PROFITABLE')).toBeUndefined();
    });
  });

  describe('getLatestBacktest 호출 인자', () => {
    it('올바른 ticker/market 전달', async () => {
      mockBacktest(1.5);
      await evaluateAndScore('005930', 'KRX', makeDecision());
      expect(getLatestBacktest).toHaveBeenCalledWith('005930', 'KRX');
    });

    it('NASDAQ 종목도 시장 인자 정확히 전달', async () => {
      mockBacktest(1.5);
      await evaluateAndScore('AAPL', 'NASDAQ', makeDecision());
      expect(getLatestBacktest).toHaveBeenCalledWith('AAPL', 'NASDAQ');
    });
  });

  describe('예외 안전성', () => {
    it('getLatestBacktest throw해도 전체 스코어링은 계속 진행', async () => {
      vi.mocked(getLatestBacktest).mockImplementation(() => {
        throw new Error('DB error');
      });
      const result = await evaluateAndScore('T14', 'KRX', makeDecision());
      // 예외는 catch되어 debug 로그만 찍힘. score 계산 자체는 정상 반환.
      expect(result).toBeDefined();
      expect(typeof result.totalScore).toBe('number');
    });
  });
});
