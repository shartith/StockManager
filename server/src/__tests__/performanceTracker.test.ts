/**
 * performanceTracker.ts — registerSignalForTracking 버그 회귀 테스트
 *
 * 발견 경위: 성과 분석 탭이 모든 데이터가 비어있는 상태로 표시되어
 * 조사한 결과, trade_signals가 106건 누적되었음에도 signal_performance
 * 테이블에는 단 한 건도 등록되지 않은 것이 원인이었다.
 *
 * 근본 원인:
 *   - helpers.ts는 `input.indicators`를 `indicators_json.indicators`로 저장했으나
 *   - StockAnalysisInput.indicators 서브오브젝트에는 currentPrice가 없음
 *   - currentPrice는 input 최상위에 있음
 *   - registerSignalForTracking은 `indicators.indicators?.currentPrice`만 참조
 *   - 항상 0이 되어 `if (signalPrice <= 0) return;`로 skip
 *
 * 수정:
 *   - helpers.ts: JSON에 `currentPrice` 최상위 필드 추가
 *   - performanceTracker.ts: 두 경로 모두 fallback 조회
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({ mlxEnabled: false, mlxUrl: '' })),
}));

import { initializeDB, queryAll, queryOne, execute } from '../db';
import { registerSignalForTracking, backfillUntrackedSignals } from '../services/performanceTracker';

function insertStock(id: number, ticker = '005930'): void {
  execute(
    'INSERT INTO stocks (id, ticker, name, market, sector) VALUES (?, ?, ?, ?, ?)',
    [id, ticker, '삼성전자', 'KRX', '반도체'],
  );
}

function insertSignal(stockId: number, indicatorsJson: object): number {
  const { lastId } = execute(
    "INSERT INTO trade_signals (stock_id, signal_type, source, confidence, indicators_json, llm_reasoning) VALUES (?, 'BUY', 'test', 80, ?, 'test')",
    [stockId, JSON.stringify(indicatorsJson)],
  );
  return lastId;
}

describe('registerSignalForTracking — currentPrice path resolution', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM signal_performance');
    execute('DELETE FROM trade_signals');
    execute('DELETE FROM stocks');
  });

  it('registers when currentPrice is at top level (new format v4.8.1+)', () => {
    insertStock(1);
    const signalId = insertSignal(1, {
      currentPrice: 70000,        // ← 최상위 (수정된 포맷)
      indicators: { rsi14: 55, sma20: 69000 },
      targetPrice: 75000,
      stopLossPrice: 67000,
      keyFactors: ['moving avg'],
    });

    registerSignalForTracking(signalId);

    const perf = queryOne('SELECT * FROM signal_performance WHERE signal_id = ?', [signalId]);
    expect(perf).toBeTruthy();
    expect(perf.signal_price).toBe(70000);
    expect(perf.target_price).toBe(75000);
    expect(perf.stop_loss_price).toBe(67000);
  });

  it('registers when currentPrice is nested under indicators (legacy fallback)', () => {
    insertStock(1);
    const signalId = insertSignal(1, {
      indicators: {
        currentPrice: 70000,      // ← indicators 안 (legacy 시도 경로)
        rsi14: 55,
      },
      targetPrice: 75000,
    });

    registerSignalForTracking(signalId);

    const perf = queryOne('SELECT * FROM signal_performance WHERE signal_id = ?', [signalId]);
    expect(perf).toBeTruthy();
    expect(perf.signal_price).toBe(70000);
  });

  it('regression: old format without currentPrice still gets skipped (no false data)', () => {
    insertStock(1);
    // Simulates the buggy format that produced 106 untracked signals
    const signalId = insertSignal(1, {
      indicators: { rsi14: 55 },  // ← currentPrice 없음
      targetPrice: 75000,
    });

    registerSignalForTracking(signalId);

    const perf = queryOne('SELECT * FROM signal_performance WHERE signal_id = ?', [signalId]);
    expect(perf).toBeNull(); // 여전히 등록 안 됨 — 잘못된 가격으로 기록되는 것보다 낫다
  });

  it('sets performance_tracked = 1 after successful registration', () => {
    insertStock(1);
    const signalId = insertSignal(1, { currentPrice: 70000, indicators: {} });

    registerSignalForTracking(signalId);

    const signal = queryOne('SELECT performance_tracked FROM trade_signals WHERE id = ?', [signalId]);
    expect(signal.performance_tracked).toBe(1);
  });

  it('does not duplicate on repeated calls (idempotent)', () => {
    insertStock(1);
    const signalId = insertSignal(1, { currentPrice: 70000, indicators: {} });

    registerSignalForTracking(signalId);
    registerSignalForTracking(signalId);
    registerSignalForTracking(signalId);

    const count = queryAll('SELECT id FROM signal_performance WHERE signal_id = ?', [signalId]).length;
    expect(count).toBe(1);
  });
});

describe('backfillUntrackedSignals — 과거 신호 복구', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM signal_performance');
    execute('DELETE FROM trade_signals');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM transactions');
    execute('DELETE FROM stocks');
  });

  it('recovers an untracked signal using auto_trades price', () => {
    insertStock(1);
    const sigId = insertSignal(1, { indicators: {} }); // no currentPrice → was skipped

    // Matching BUY order within 24h
    execute(
      "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 72000, datetime('now'))",
      [1],
    );

    const result = backfillUntrackedSignals();
    expect(result.registered).toBe(1);
    expect(result.skipped).toBe(0);

    const perf = queryOne('SELECT signal_price FROM signal_performance WHERE signal_id = ?', [sigId]);
    expect(perf.signal_price).toBe(72000);
  });

  it('falls back to transactions.price when auto_trades is absent', () => {
    insertStock(1);
    const sigId = insertSignal(1, { indicators: {} });

    const today = new Date().toISOString().slice(0, 10);
    execute(
      "INSERT INTO transactions (stock_id, type, quantity, price, date) VALUES (?, 'BUY', 5, 71500, ?)",
      [1, today],
    );

    const result = backfillUntrackedSignals();
    expect(result.registered).toBe(1);
    const perf = queryOne('SELECT signal_price FROM signal_performance WHERE signal_id = ?', [sigId]);
    expect(perf.signal_price).toBe(71500);
  });

  it('skips signals with no matching buy record', () => {
    insertStock(1);
    insertSignal(1, { indicators: {} });

    const result = backfillUntrackedSignals();
    expect(result.registered).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('does not re-register already tracked signals', () => {
    insertStock(1);
    const sigId = insertSignal(1, { currentPrice: 70000, indicators: {} });
    registerSignalForTracking(sigId); // already tracked

    // Even if there's an auto_trade, no retrieval should happen
    execute(
      "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 99999, datetime('now'))",
      [1],
    );

    const result = backfillUntrackedSignals();
    expect(result.total).toBe(0); // no untracked signals left
  });

  it('preserves original created_at (so 7-day evaluation timer starts from signal date)', () => {
    insertStock(1);
    const signalDate = '2026-04-01 10:00:00';
    execute(
      "INSERT INTO trade_signals (stock_id, signal_type, source, confidence, indicators_json, llm_reasoning, created_at) VALUES (?, 'BUY', 'test', 80, ?, 'test', ?)",
      [1, JSON.stringify({ indicators: {} }), signalDate],
    );
    execute(
      "INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, created_at) VALUES (?, 'BUY', 'FILLED', 10, 70000, ?)",
      [1, signalDate],
    );

    backfillUntrackedSignals();
    const perf = queryOne("SELECT created_at FROM signal_performance WHERE stock_id = 1");
    expect(perf.created_at).toMatch(/^2026-04-01/);
  });
});
