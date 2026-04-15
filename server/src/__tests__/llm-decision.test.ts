/**
 * llm.ts — getTradeDecision, parseDecisionResponse, buildAnalysisInput
 *
 * The existing llm*.test.ts covers callLlm resilience + checkLlmStatus.
 * This file drives the full getTradeDecision path so parseDecisionResponse,
 * buildStructuredPrompt, buildSystemPrompt, formatInputData, and
 * getTradeDecisionSingle/WithDebate all get exercised.
 *
 * Strategy: mock only `fetch` (vi.stubGlobal). Every getTradeDecision call
 * goes through the real callLlm mutex → fetch → parseDecisionResponse path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(() => null),
  execute: vi.fn(),
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    llmUrl: 'http://localhost:8000',
    llmModel: 'qwen3:4b',
    llmEnabled: true,
    debateMode: false,
    investmentStyle: 'balanced',
  })),
}));

vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { StockAnalysisInput } from '../services/llm';

// Baseline input — caller overrides individual fields.
function baseInput(overrides: Partial<StockAnalysisInput> = {}): StockAnalysisInput {
  return {
    ticker: '005930',
    name: '삼성전자',
    market: 'KRX',
    currentPrice: 70000,
    previousClose: 69000,
    changePercent: 1.45,
    indicators: {
      rsi14: 55,
      sma5: 70500,
      sma20: 69500,
      sma60: 68000,
      sma120: 67000,
      ema12: 70200,
      ema26: 69800,
      macd: 400,
      macdSignal: 300,
      macdHistogram: 100,
      bollingerUpper: 72000,
      bollingerMiddle: 70000,
      bollingerLower: 68000,
      vwap: 70100,
      atr14: 800,
      technicalSignal: 'BUY',
      technicalReasons: ['이동평균 정배열'],
    },
    recentCandles: [],
    volumeAnalysis: { avgVolume20d: 10_000_000, todayVsAvg: 1.2, volumeTrend: 'INCREASING' },
    ...overrides,
  };
}

const okJson = (bodyObj: unknown) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(bodyObj) } }] }),
});

describe('getTradeDecision — single mode + parseDecisionResponse', () => {
  let getTradeDecision: typeof import('../services/llm').getTradeDecision;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      queryAll: vi.fn(() => []),
      queryOne: vi.fn(() => null),
      execute: vi.fn(),
    }));
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({
        llmUrl: 'http://localhost:8000',
        llmModel: 'qwen3:4b',
        llmEnabled: true,
        debateMode: false,
        investmentStyle: 'balanced',
      })),
    }));
    vi.doMock('../logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../services/llm');
    getTradeDecision = mod.getTradeDecision;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a clean BUY decision with all fields', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'BUY',
      confidence: 85,
      targetPrice: 75000,
      stopLossPrice: 67000,
      entryPrice: 70000,
      suggestedRatio: 15,
      urgency: 'GRADUAL',
      reasoning: 'MA 정배열 + 거래량 증가',
      keyFactors: ['정배열', '거래량'],
      risks: ['시장 급락 가능성'],
      holdingPeriod: 'SHORT_TERM',
    }));

    const decision = await getTradeDecision(baseInput());
    expect(decision.signal).toBe('BUY');
    expect(decision.confidence).toBe(85);
    expect(decision.targetPrice).toBe(75000);
    expect(decision.stopLossPrice).toBe(67000);
    expect(decision.suggestedRatio).toBe(15);
    expect(decision.urgency).toBe('GRADUAL');
    expect(decision.keyFactors).toEqual(['정배열', '거래량']);
    expect(decision.risks).toEqual(['시장 급락 가능성']);
  });

  it('forces HOLD when confidence < 60 regardless of signal', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'BUY',
      confidence: 55,
      reasoning: 'weak BUY',
    }));

    const decision = await getTradeDecision(baseInput());
    expect(decision.signal).toBe('HOLD');
    expect(decision.confidence).toBe(55);
  });

  it('coerces invalid signal to HOLD', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'MAYBE',
      confidence: 80,
      reasoning: 'garbled',
    }));

    const decision = await getTradeDecision(baseInput());
    expect(decision.signal).toBe('HOLD');
  });

  it('clamps confidence below 0 to 0 and above 100 to 100', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'SELL', confidence: 150, reasoning: 'x',
    }));
    const d1 = await getTradeDecision(baseInput());
    expect(d1.confidence).toBe(100);
    expect(d1.signal).toBe('SELL');

    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'BUY', confidence: -30, reasoning: 'x',
    }));
    const d2 = await getTradeDecision(baseInput());
    expect(d2.confidence).toBe(0);
    expect(d2.signal).toBe('HOLD'); // confidence < 60 → HOLD
  });

  it('extracts JSON from surrounding thinking-model text', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Let me think... the correct answer is {"signal":"BUY","confidence":75,"reasoning":"ok"} as shown.' } }] }),
    });

    const decision = await getTradeDecision(baseInput());
    expect(decision.signal).toBe('BUY');
    expect(decision.confidence).toBe(75);
  });

  it('returns the safe fallback HOLD when response is not JSON at all', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'completely non-json garbage output' } }] }),
    });

    const decision = await getTradeDecision(baseInput());
    expect(decision.signal).toBe('HOLD');
    expect(decision.confidence).toBe(20);
    expect(decision.reasoning).toMatch(/파싱 실패/);
    expect(decision.keyFactors).toEqual(['응답 형식 오류']);
  });

  it('normalizes missing optional fields to sensible defaults', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'BUY',
      confidence: 70,
      // no targetPrice, stopLossPrice, urgency, keyFactors, risks, holdingPeriod
    }));

    const d = await getTradeDecision(baseInput());
    expect(d.targetPrice).toBeNull();
    expect(d.stopLossPrice).toBeNull();
    expect(d.entryPrice).toBeNull();
    expect(d.suggestedRatio).toBe(0);
    expect(d.urgency).toBe('NO_RUSH');
    expect(d.keyFactors).toEqual([]);
    expect(d.risks).toEqual([]);
    expect(d.holdingPeriod).toBe('SHORT_TERM');
    expect(d.reasoning).toBe('판단 근거 없음');
  });

  it('coerces non-array keyFactors/risks to empty arrays', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'BUY',
      confidence: 80,
      keyFactors: 'should-be-array',
      risks: { wrong: 'shape' },
      reasoning: 'x',
    }));

    const d = await getTradeDecision(baseInput());
    expect(d.keyFactors).toEqual([]);
    expect(d.risks).toEqual([]);
  });

  it('throws when LLM is disabled', async () => {
    vi.resetModules();
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({
        llmUrl: 'http://localhost:8000',
        llmModel: 'qwen3:4b',
        llmEnabled: false,
        debateMode: false,
      })),
    }));
    vi.doMock('../db', () => ({ queryAll: vi.fn(() => []), queryOne: vi.fn(() => null), execute: vi.fn() }));
    vi.doMock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

    const { getTradeDecision: gd } = await import('../services/llm');
    await expect(gd(baseInput())).rejects.toThrow(/비활성화/);
  });
});

describe('getTradeDecision — debate mode (3-call orchestration)', () => {
  let getTradeDecision: typeof import('../services/llm').getTradeDecision;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      queryAll: vi.fn(() => []), queryOne: vi.fn(() => null), execute: vi.fn(),
    }));
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({
        llmUrl: 'http://localhost:8000',
        llmModel: 'qwen3:4b',
        llmEnabled: true,
        debateMode: true,
        investmentStyle: 'balanced',
      })),
    }));
    vi.doMock('../logger', () => ({
      default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await import('../services/llm');
    getTradeDecision = mod.getTradeDecision;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('performs 3 sequential calls (bull, bear, judge) and returns judge verdict', async () => {
    // 1) Bull analyst — plain text
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '강세: 이동평균 정배열, 거래량 증가' } }] }),
    });
    // 2) Bear analyst — plain text
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '약세: 과매수 구간, 시장 피로' } }] }),
    });
    // 3) Judge — structured JSON
    fetchSpy.mockResolvedValueOnce(okJson({
      signal: 'HOLD',
      confidence: 65,
      reasoning: '강세와 약세 의견 모두 타당. 중립 유지.',
      keyFactors: ['양측 의견 팽팽'],
      risks: ['방향성 불확실'],
    }));

    const d = await getTradeDecision(baseInput());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(d.signal).toBe('HOLD');
    expect(d.confidence).toBe(65);
    expect(d.reasoning).toContain('중립');
  });
});

describe('buildAnalysisInput (pure helper)', () => {
  let buildAnalysisInput: typeof import('../services/llm').buildAnalysisInput;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({ queryAll: vi.fn(() => []), queryOne: vi.fn(() => null), execute: vi.fn() }));
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({
        llmUrl: '', llmModel: '', llmEnabled: false, debateMode: false,
      })),
    }));
    vi.doMock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

    const mod = await import('../services/llm');
    buildAnalysisInput = mod.buildAnalysisInput;
  });

  const makeCandles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100 + i,
      high: 105 + i,
      low: 99 + i,
      close: 102 + i,
      volume: 1_000_000 + i * 10_000,
    }));

  const indicators = {
    currentPrice: 120,
    rsi14: 55, sma5: 118, sma20: 115, sma60: 110, sma120: 105,
    ema12: 119, ema26: 116, macd: 2, macdSignal: 1, macdHistogram: 1,
    bollingerUpper: 125, bollingerMiddle: 118, bollingerLower: 111,
    vwap: 118, atr14: 3,
    signal: 'BUY' as const,
    signalReasons: ['uptrend'],
  };

  it('builds input with 5-candle tail and volume trend INCREASING', () => {
    const candles = makeCandles(20).map((c, i) => ({
      ...c,
      volume: i >= 15 ? 5_000_000 : 1_000_000, // last 5 days much higher
    }));
    const input = buildAnalysisInput('005930', '삼성전자', 'KRX', candles, indicators);

    expect(input.ticker).toBe('005930');
    expect(input.recentCandles).toHaveLength(5);
    expect(input.volumeAnalysis.volumeTrend).toBe('INCREASING');
    expect(input.volumeAnalysis.avgVolume20d).toBeGreaterThan(0);
  });

  it('detects DECREASING volume trend', () => {
    const candles = makeCandles(20).map((c, i) => ({
      ...c,
      volume: i < 15 ? 5_000_000 : 1_000_000, // last 5 days much lower
    }));
    const input = buildAnalysisInput('X', 'X', 'KRX', candles, indicators);
    expect(input.volumeAnalysis.volumeTrend).toBe('DECREASING');
  });

  it('returns STABLE volume trend for uniform candles', () => {
    const candles = makeCandles(20).map(c => ({ ...c, volume: 1_000_000 }));
    const input = buildAnalysisInput('X', 'X', 'KRX', candles, indicators);
    expect(input.volumeAnalysis.volumeTrend).toBe('STABLE');
  });

  it('computes changePercent from second-last close', () => {
    const candles = makeCandles(5);
    const input = buildAnalysisInput('X', 'X', 'KRX', candles, indicators);
    // currentPrice=120, prevClose=candles[3].close=105 → (120-105)/105*100 ≈ 14.29
    expect(input.previousClose).toBe(candles[candles.length - 2].close);
    expect(input.changePercent).toBeCloseTo(((120 - candles[3].close) / candles[3].close) * 100, 1);
  });

  it('propagates optional holding, newsSummary, and marketContext fields', () => {
    const candles = makeCandles(10);
    const input = buildAnalysisInput(
      'AAPL', 'Apple', 'NASDAQ', candles, indicators,
      { quantity: 10, avgPrice: 100, totalCost: 1000, unrealizedPnL: 200, unrealizedPnLPercent: 20, holdingDays: 30 },
      '애플 실적 호조',
      'S&P500 상승세',
    );
    expect(input.holding?.quantity).toBe(10);
    expect(input.newsSummary).toBe('애플 실적 호조');
    expect(input.marketContext).toBe('S&P500 상승세');
  });

  it('handles single-candle input without crashing', () => {
    const candles = makeCandles(1);
    const input = buildAnalysisInput('X', 'X', 'KRX', candles, indicators);
    // prevClose defaults to currentPrice when candles.length < 2
    expect(input.previousClose).toBe(indicators.currentPrice);
    expect(input.changePercent).toBe(0);
  });
});
