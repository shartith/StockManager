/**
 * Coverage pass: signalAnalyzer.ts was at 0% — this file adds happy path +
 * edge cases + branch coverage for all three exported functions.
 *
 * Uses in-memory better-sqlite3 for isolation.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute } from '../db';
import {
  analyzeSignalAccuracy,
  getScoreTypeCorrelations,
  buildAccuracyReport,
} from '../services/signalAnalyzer';

/**
 * Insert a synthetic signal_performance row. Defaults produce a "winning" row
 * (return_7d = 5) so callers only override what they care about.
 */
function insertSignal(overrides: Partial<Record<string, unknown>> = {}): void {
  const row = {
    signal_id: 1,
    stock_id: 1,
    ticker: '005930',
    market: 'KRX',
    signal_type: 'BUY',
    signal_confidence: 75,
    signal_price: 70000,
    target_price: 75000,
    stop_loss_price: 65000,
    return_7d: 5,
    return_14d: 7,
    return_30d: 10,
    target_hit: 1,
    stop_loss_hit: 0,
    key_factors_json: JSON.stringify(['earnings_beat', 'sector_rotation']),
    ...overrides,
  };
  execute(
    `INSERT INTO signal_performance (
      signal_id, stock_id, ticker, market, signal_type, signal_confidence,
      signal_price, target_price, stop_loss_price,
      return_7d, return_14d, return_30d,
      target_hit, stop_loss_hit, key_factors_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.signal_id, row.stock_id, row.ticker, row.market, row.signal_type,
      row.signal_confidence, row.signal_price, row.target_price, row.stop_loss_price,
      row.return_7d, row.return_14d, row.return_30d,
      row.target_hit, row.stop_loss_hit, row.key_factors_json,
    ],
  );
}

describe('signalAnalyzer', () => {
  beforeAll(async () => {
    await initializeDB();
    // signal_performance has FK → stocks(id) and trade_signals(id).
    // Disable FK enforcement on this in-memory DB so tests can synthesize
    // rows without also seeding parents.
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM signal_performance');
    execute('DELETE FROM recommendation_scores');
  });

  describe('analyzeSignalAccuracy', () => {
    it('returns empty-shape stats when no evaluated rows exist', () => {
      const stats = analyzeSignalAccuracy(90);
      expect(stats.totalEvaluated).toBe(0);
      expect(stats.overallWinRate).toBeNull();
      expect(stats.byConfidence).toEqual([]);
      expect(stats.byMarket).toEqual([]);
      expect(stats.avgReturn7d).toBeNull();
      expect(stats.avgReturn14d).toBeNull();
      expect(stats.avgReturn30d).toBeNull();
      expect(stats.targetHitRate).toBeNull();
      expect(stats.stopLossHitRate).toBeNull();
      expect(stats.bestFactors).toEqual([]);
      expect(stats.worstFactors).toEqual([]);
    });

    it('computes overall win rate correctly for mixed outcomes', () => {
      // 3 wins (return_7d > 0), 1 loss (return_7d < 0) → 75%
      insertSignal({ return_7d: 5 });
      insertSignal({ return_7d: 3 });
      insertSignal({ return_7d: 8 });
      insertSignal({ return_7d: -4 });

      const stats = analyzeSignalAccuracy(90);
      expect(stats.totalEvaluated).toBe(4);
      expect(stats.overallWinRate).toBe(75);
    });

    it('buckets by confidence brackets and drops empty buckets', () => {
      // 65 → 60-70, 75 → 70-80
      insertSignal({ signal_confidence: 65, return_7d: 2 });
      insertSignal({ signal_confidence: 75, return_7d: -1 });
      insertSignal({ signal_confidence: 75, return_7d: 4 });

      const stats = analyzeSignalAccuracy(90);
      const brackets = stats.byConfidence.map(b => b.bracket);
      expect(brackets).toContain('60-70');
      expect(brackets).toContain('70-80');
      expect(brackets).not.toContain('80-90');
      expect(brackets).not.toContain('90-100');

      const sixty = stats.byConfidence.find(b => b.bracket === '60-70')!;
      expect(sixty.count).toBe(1);
      expect(sixty.winRate).toBe(100);

      const seventy = stats.byConfidence.find(b => b.bracket === '70-80')!;
      expect(seventy.count).toBe(2);
      expect(seventy.winRate).toBe(50);
    });

    it('includes the 90-100 bracket when confidence is exactly 100', () => {
      insertSignal({ signal_confidence: 100, return_7d: 12 });
      const stats = analyzeSignalAccuracy(90);
      const top = stats.byConfidence.find(b => b.bracket === '90-100');
      expect(top).toBeDefined();
      expect(top!.count).toBe(1);
    });

    it('groups by market and handles multiple markets', () => {
      insertSignal({ market: 'KRX', return_7d: 5 });
      insertSignal({ market: 'KRX', return_7d: -2 });
      insertSignal({ market: 'NASDAQ', return_7d: 8 });

      const stats = analyzeSignalAccuracy(90);
      const krx = stats.byMarket.find(m => m.market === 'KRX')!;
      const nasdaq = stats.byMarket.find(m => m.market === 'NASDAQ')!;

      expect(krx.count).toBe(2);
      expect(krx.winRate).toBe(50);
      expect(nasdaq.count).toBe(1);
      expect(nasdaq.winRate).toBe(100);
    });

    it('null-out 14d/30d when no evaluated rows have those values', () => {
      insertSignal({ return_7d: 5, return_14d: null, return_30d: null });
      const stats = analyzeSignalAccuracy(90);
      expect(stats.avgReturn7d).not.toBeNull();
      expect(stats.avgReturn14d).toBeNull();
      expect(stats.avgReturn30d).toBeNull();
    });

    it('targetHitRate and stopLossHitRate reflect only rows with those prices', () => {
      insertSignal({ target_price: 80000, target_hit: 1, stop_loss_price: null });
      insertSignal({ target_price: 80000, target_hit: 0, stop_loss_price: null });
      insertSignal({ target_price: null, stop_loss_price: 50000, stop_loss_hit: 1 });

      const stats = analyzeSignalAccuracy(90);
      expect(stats.targetHitRate).toBe(50); // 1 of 2 with target hit
      expect(stats.stopLossHitRate).toBe(100); // 1 of 1 with stop loss hit
    });

    it('extracts best/worst factors (min 3 occurrences)', () => {
      // winning_factor appears 3x, all wins → 100%
      insertSignal({ return_7d: 5, key_factors_json: JSON.stringify(['winning_factor']) });
      insertSignal({ return_7d: 3, key_factors_json: JSON.stringify(['winning_factor']) });
      insertSignal({ return_7d: 2, key_factors_json: JSON.stringify(['winning_factor']) });
      // losing_factor appears 3x, all losses → 0%
      insertSignal({ return_7d: -2, key_factors_json: JSON.stringify(['losing_factor']) });
      insertSignal({ return_7d: -5, key_factors_json: JSON.stringify(['losing_factor']) });
      insertSignal({ return_7d: -1, key_factors_json: JSON.stringify(['losing_factor']) });
      // rare_factor only 2x → should be filtered out (min 3)
      insertSignal({ return_7d: 1, key_factors_json: JSON.stringify(['rare_factor']) });
      insertSignal({ return_7d: 2, key_factors_json: JSON.stringify(['rare_factor']) });

      const stats = analyzeSignalAccuracy(90);
      const bestNames = stats.bestFactors.map(f => f.factor);
      expect(bestNames).toContain('winning_factor');
      expect(bestNames).not.toContain('rare_factor');
      expect(stats.bestFactors.find(f => f.factor === 'winning_factor')?.winRate).toBe(100);
    });

    it('tolerates malformed key_factors_json', () => {
      insertSignal({ return_7d: 5, key_factors_json: 'not valid json' });
      expect(() => analyzeSignalAccuracy(90)).not.toThrow();
    });
  });

  describe('getScoreTypeCorrelations', () => {
    it('returns empty array when no matching data', () => {
      expect(getScoreTypeCorrelations()).toEqual([]);
    });

    it('excludes score types with fewer than 10 samples', () => {
      // Only 2 signal rows × 2 score rows = 4 join pairs — below n ≥ 10
      for (let i = 0; i < 2; i++) {
        execute(
          'INSERT INTO signal_performance (signal_id, stock_id, ticker, signal_type, signal_confidence, signal_price, return_7d) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [i, 1, 'X', 'BUY', 80, 100, i + 1],
        );
        execute(
          "INSERT INTO recommendation_scores (ticker, market, score_type, score_value) VALUES ('X', 'KRX', 'MOMENTUM', ?)",
          [i * 10],
        );
      }
      expect(getScoreTypeCorrelations()).toEqual([]);
    });
  });

  describe('buildAccuracyReport', () => {
    it('returns null when fewer than 5 evaluated rows', () => {
      insertSignal({ return_7d: 5 });
      insertSignal({ return_7d: 5 });
      expect(buildAccuracyReport()).toBeNull();
    });

    it('produces a non-empty string report with at least 5 evaluated rows', () => {
      for (let i = 0; i < 6; i++) {
        insertSignal({ return_7d: 3 });
      }
      const report = buildAccuracyReport();
      expect(report).not.toBeNull();
      expect(report).toContain('전체 BUY 신호 승률');
      expect(report).toContain('7일 평균 수익률');
    });

    it('omits 14d/30d lines when those values are all null', () => {
      for (let i = 0; i < 6; i++) {
        insertSignal({ return_7d: 3, return_14d: null, return_30d: null });
      }
      const report = buildAccuracyReport()!;
      expect(report).not.toContain('14일:');
      expect(report).not.toContain('30일:');
    });

    it('includes best/worst factor lines when factors meet the ≥3 threshold', () => {
      for (let i = 0; i < 5; i++) {
        insertSignal({
          return_7d: 3,
          key_factors_json: JSON.stringify(['consistent_winner']),
        });
      }
      const report = buildAccuracyReport()!;
      expect(report).toContain('신뢰할 수 있는 판단 요인');
      expect(report).toContain('consistent_winner');
    });
  });
});
