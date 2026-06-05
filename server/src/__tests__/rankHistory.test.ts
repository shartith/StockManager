/**
 * v5.7.0 rank_history — 시총 순위 시계열 추적 및 isRankImproving 판정.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute } from '../db';
import { getPreviousRank, isRankImproving } from '../services/topMarketCap';

function seedRank(ticker: string, rank: number, daysAgo: number, hoursOffset = 0): void {
  execute(
    `INSERT INTO rank_history (ticker, rank, fetched_at)
     VALUES (?, ?, datetime('now', '-' || ? || ' days', '-' || ? || ' hours'))`,
    [ticker, rank, daysAgo, hoursOffset],
  );
}

describe('rank_history — getPreviousRank / isRankImproving', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM rank_history');
  });

  it('과거 기록 없으면 null', () => {
    expect(getPreviousRank('329180', 24)).toBeNull();
  });

  it('정확히 N시간 이전 기록 조회', () => {
    seedRank('329180', 15, 1); // 1일 전 = 24시간 전
    seedRank('329180', 18, 2); // 2일 전 = 48시간 전
    expect(getPreviousRank('329180', 24)).toBe(15); // 24시간 이전 중 가장 최근
    expect(getPreviousRank('329180', 48)).toBe(18); // 48시간 이전 중 가장 최근
  });

  it('isRankImproving — 24h 전 30위 → 현재 25위 (5단계 상승, threshold=2): true', () => {
    seedRank('329180', 30, 1, 1); // 25시간 전 (안전하게 24h 이상 과거)
    expect(isRankImproving('329180', 25, 24, 2)).toBe(true);
  });

  it('isRankImproving — 24h 전 15위 → 현재 14위 (1단계만 상승, threshold=2): false', () => {
    seedRank('005930', 15, 1, 1);
    expect(isRankImproving('005930', 14, 24, 2)).toBe(false);
  });

  it('isRankImproving — 24h 전 10위 → 현재 12위 (하락): false', () => {
    seedRank('005930', 10, 1, 1);
    expect(isRankImproving('005930', 12, 24, 2)).toBe(false);
  });

  it('isRankImproving — 데이터 없음: false (보수적)', () => {
    expect(isRankImproving('UNKNOWN', 15, 24, 2)).toBe(false);
  });
});
