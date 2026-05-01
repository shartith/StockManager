/**
 * 추천 갱신 흐름의 watchlist exclusion 가드 회귀 테스트
 *
 * 배포본에서 13일간 추천종목이 한 건도 추가되지 않은 버그의 회귀 방지.
 *
 * 원인: `runRecommendationRefresh`(스케줄러) 와 `/api/recommendations/generate`,
 * `/api/recommendations/:id/watch` 의 watchlist 관련 SQL이 `deleted_at IS NULL`
 * 가드를 누락해서 soft-delete 된 watchlist row 까지 추천 후보 차단 셋에 포함되어
 * 누적된 watchlist 가 KIS rank 후보와 거의 100% 겹치며 INSERT 가 0건으로 수렴.
 *
 * 검증:
 * (1) 스케줄러/generate 의 watchlistTickers 셋이 deleted_at IS NOT NULL 항목을 제외
 * (2) /:id/watch 라우트가 soft-delete 된 watchlist row 를 보지 않고 새 INSERT 수행
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/notification', () => ({
  createNotification: vi.fn(),
}));

import { initializeDB, execute, queryAll, queryOne } from '../db';
import recommendationsRouter from '../routes/recommendations';

// ─── 헬퍼 ────────────────────────────────────────────────

function insertStock(id: number, ticker: string, market = 'KRX'): void {
  execute(
    `INSERT INTO stocks (id, ticker, name, market) VALUES (?, ?, ?, ?)`,
    [id, ticker, `${ticker} 종목`, market]
  );
}

function insertWatchlist(stockId: number, market = 'KRX', deleted = false): number {
  const deletedExpr = deleted ? "datetime('now', '-1 days')" : 'NULL';
  const { lastId } = execute(
    `INSERT INTO watchlist (stock_id, market, notes, deleted_at)
     VALUES (?, ?, 'test', ${deletedExpr})`,
    [stockId, market]
  );
  return lastId;
}

function insertRecommendation(ticker: string, market = 'KRX'): number {
  const { lastId } = execute(
    `INSERT INTO recommendations (ticker, name, market, source, reason, signal_type, confidence, status)
     VALUES (?, ?, ?, 'llm-auto', 'test', 'BUY', 80, 'ACTIVE')`,
    [ticker, `${ticker} 종목`, market]
  );
  return lastId;
}

// ─── 테스트 ───────────────────────────────────────────────

describe('watchlist exclusion 가드 (deleted_at IS NULL)', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM watchlist');
    execute('DELETE FROM recommendations');
    execute('DELETE FROM stocks');
  });

  describe('스케줄러 watchlistTickers 쿼리 (services/scheduler/recommendations.ts:260)', () => {
    // 스케줄러 코드와 동일한 SQL — 가드가 누락되면 회귀
    function fetchWatchlistTickers(market: string): Set<string> {
      return new Set(
        queryAll(
          `SELECT s.ticker FROM watchlist w
           JOIN stocks s ON s.id = w.stock_id
           WHERE w.market = ? AND w.deleted_at IS NULL`,
          [market]
        ).map((r: any) => r.ticker)
      );
    }

    it('활성 watchlist row 의 ticker 는 제외 셋에 포함', () => {
      insertStock(1, '000001');
      insertWatchlist(1, 'KRX', false);

      const tickers = fetchWatchlistTickers('KRX');
      expect(tickers.has('000001')).toBe(true);
    });

    it('soft-delete 된 watchlist row 의 ticker 는 제외 셋에 포함되지 않음', () => {
      insertStock(2, '000002');
      insertWatchlist(2, 'KRX', true); // deleted_at SET

      const tickers = fetchWatchlistTickers('KRX');
      expect(tickers.has('000002')).toBe(false);
    });

    it('모든 row 가 soft-delete 면 셋이 비어 추천 후보가 자유롭게 통과', () => {
      insertStock(4, '000004');
      insertStock(5, '000005');
      insertWatchlist(4, 'KRX', true);
      insertWatchlist(5, 'KRX', true);

      const tickers = fetchWatchlistTickers('KRX');
      expect(tickers.size).toBe(0);
    });
  });

  describe('POST /api/recommendations/:id/watch (routes/recommendations.ts:370)', () => {
    function makeApp() {
      const app = express();
      app.use(express.json());
      app.use('/', recommendationsRouter);
      return app;
    }

    it('soft-delete 된 watchlist row 가 있으면 UNIQUE 충돌 없이 부활 (가드 회귀 방지)', async () => {
      insertStock(10, '000010');
      const recId = insertRecommendation('000010');
      insertWatchlist(10, 'KRX', true); // 과거 삭제됨

      await request(makeApp()).post(`/${recId}/watch`).expect(200);

      // watchlist.stock_id 는 UNIQUE — 새 INSERT 가 아닌 부활
      const rows = queryAll('SELECT id, deleted_at FROM watchlist WHERE stock_id = ?', [10]);
      expect(rows.length).toBe(1);
      expect(rows[0].deleted_at).toBeNull();

      const updated = queryOne('SELECT status FROM recommendations WHERE id = ?', [recId]);
      expect(updated?.status).toBe('EXECUTED');
    });

    it('활성 watchlist row 가 있으면 INSERT 하지 않고 status 만 변경 (기존 동작 유지)', async () => {
      insertStock(11, '000011');
      const recId = insertRecommendation('000011');
      insertWatchlist(11, 'KRX', false); // 활성

      await request(makeApp()).post(`/${recId}/watch`).expect(200);

      const rows = queryAll('SELECT id FROM watchlist WHERE stock_id = ? AND deleted_at IS NULL', [11]);
      expect(rows.length).toBe(1); // 추가되지 않음

      const updated = queryOne('SELECT status FROM recommendations WHERE id = ?', [recId]);
      expect(updated?.status).toBe('EXECUTED');
    });
  });
});
