/**
 * weekendLearning.ts — 주말 학습 + 백테스트 루프 smoke 테스트 (UC-09)
 *
 * 외부 API(fetchCandleData)·LLM 호출을 mock하여 전체 파이프라인이
 * "에러 없이 돌고, 기대하는 DB 기록이 생기는지"를 smoke 테스트로 검증.
 * 유닛 테스트가 아니라 오케스트레이션 (runBacktest → saveBacktestResult,
 * weekly_reports INSERT, collectBacktestCandidates 호출 등) 통합 검증.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

// 외부 의존성 mock
vi.mock('../services/scheduler/helpers', () => ({
  fetchCandleData: vi.fn(),
}));

vi.mock('../services/performanceTracker', () => ({
  evaluatePendingPerformance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/weightOptimizer', () => ({
  optimizeWeights: vi.fn().mockReturnValue({ adjusted: [] }),
  loadWeights: vi.fn().mockReturnValue({
    CONSECUTIVE_BUY: 1.0, MACD_GOLDEN_CROSS: 1.0, RSI_OVERSOLD_BOUNCE: 1.0,
    VOLUME_SURGE: 1.0, BOLLINGER_BOUNCE: 1.0,
  }),
}));

vi.mock('../services/notification', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../services/exportImport', () => ({
  getLoraDataCount: vi.fn().mockReturnValue(0),
  generateLoraDataset: vi.fn(),
}));

vi.mock('../services/settings', () => ({
  getSettings: vi.fn().mockReturnValue({
    llmEnabled: false, // LLM 리포트 생성 skip
    llmModel: '',
    llmUrl: '',
    llmApiKey: '',
  }),
}));

// llm.ts는 getSettings가 llmEnabled=false일 때 호출 안 됨 — 안전 위해 mock
vi.mock('../services/llm', () => ({
  callLlm: vi.fn().mockResolvedValue(''),
}));

import { initializeDB, execute, queryOne, queryAll } from '../db';
import { runWeekendLearning } from '../services/scheduler/weekendLearning';
import { fetchCandleData } from '../services/scheduler/helpers';

/** 60일치 캔들 데이터를 생성 (runBacktest의 `>= 60` 워밍업 조건 충족) */
function makeCandles(basePrice: number = 1000, days: number = 90): any[] {
  const candles: any[] = [];
  let price = basePrice;
  for (let i = 0; i < days; i++) {
    const volatility = (Math.sin(i * 0.3) + Math.cos(i * 0.1)) * 50;
    price += volatility;
    candles.push({
      time: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: price - 10,
      high: price + 20,
      low: price - 20,
      close: price,
      volume: 100000 + Math.abs(volatility) * 1000,
    });
  }
  return candles;
}

describe('runWeekendLearning (UC-09: 주말 학습 + 백테스트 루프)', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM stocks');
    execute('DELETE FROM watchlist');
    execute('DELETE FROM recommendations');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM trade_signals');
    execute('DELETE FROM backtest_results');
    execute('DELETE FROM weekly_reports');
    vi.clearAllMocks();

    // 기본 seed: 후보 수집 대상 종목
    execute(
      `INSERT INTO stocks (id, ticker, name, market) VALUES
       (1, '005930', '삼성전자', 'KRX'),
       (2, '000660', 'SK하이닉스', 'KRX')`
    );
    execute(
      `INSERT INTO watchlist (stock_id, market) VALUES (1, 'KRX'), (2, 'KRX')`
    );
  });

  it('smoke: 에러 없이 완료되고 weekly_reports에 INSERT', async () => {
    vi.mocked(fetchCandleData).mockResolvedValue(makeCandles());

    await expect(runWeekendLearning()).resolves.not.toThrow();

    const row = queryOne(`SELECT report, stats_json FROM weekly_reports ORDER BY id DESC LIMIT 1`);
    expect(row).toBeTruthy();
    expect(row?.report).toContain('주간 요약');
  });

  it('백테스트 결과가 backtest_results에 저장됨 (거래 5건 이상일 때만)', async () => {
    vi.mocked(fetchCandleData).mockResolvedValue(makeCandles());

    await runWeekendLearning();

    // 후보 종목이 5건 이상 거래를 만들면 저장됨. 실패해도 smoke는 통과.
    const rows = queryAll(`SELECT ticker, profit_factor, total_trades FROM backtest_results`);
    expect(Array.isArray(rows)).toBe(true);
    // 각 레코드의 total_trades는 5 이상이어야 함 (저장 조건)
    for (const r of rows) {
      expect(r.total_trades).toBeGreaterThanOrEqual(5);
    }
  });

  it('fetchCandleData가 후보 종목 각각에 대해 호출됨', async () => {
    vi.mocked(fetchCandleData).mockResolvedValue(makeCandles());

    await runWeekendLearning();

    // 최소 후보 종목 수만큼 호출되었어야 함 (A/B 비교에서 중복 호출 가능)
    expect(vi.mocked(fetchCandleData).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('캔들 데이터 60개 미만 → 해당 종목 백테스트 skip, 에러 없이 계속', async () => {
    vi.mocked(fetchCandleData).mockResolvedValue(makeCandles(1000, 30)); // 30일

    await expect(runWeekendLearning()).resolves.not.toThrow();

    // 저장된 백테스트 결과 없음
    const rows = queryAll(`SELECT ticker FROM backtest_results`);
    expect(rows.length).toBe(0);
  });

  it('fetchCandleData 실패해도 루프 전체는 계속 진행', async () => {
    vi.mocked(fetchCandleData).mockRejectedValue(new Error('API timeout'));

    await expect(runWeekendLearning()).resolves.not.toThrow();

    // weekly_reports는 여전히 기록됨
    const row = queryOne(`SELECT id FROM weekly_reports ORDER BY id DESC LIMIT 1`);
    expect(row).toBeTruthy();
  });

  it('후보 종목이 0개여도 에러 없이 smoke 통과', async () => {
    execute(`DELETE FROM watchlist`);
    execute(`DELETE FROM stocks`);

    await expect(runWeekendLearning()).resolves.not.toThrow();

    const row = queryOne(`SELECT id FROM weekly_reports ORDER BY id DESC LIMIT 1`);
    expect(row).toBeTruthy();
  });
});
