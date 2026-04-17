/**
 * watchlistCleanup.ts — 자동 정리 규칙 통합 테스트 (UC-12)
 *
 * 5가지 watchlist 정리 규칙 + 4가지 recommendations 만료 규칙을
 * :memory: DB에 seed → 호출 → 후상태 assert 방식으로 검증한다.
 *
 * 4/16 watchlist 25건 일괄 삭제 같은 공격적 cleanup의 정확성 보장.
 * v4.15.0 완화 (3→7일, 1→3일 유예) 반영.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

// notification 서비스 mock (알림 발송 부작용 제거)
vi.mock('../services/notification', () => ({
  createNotification: vi.fn(),
}));

import { initializeDB, execute, queryOne, queryAll } from '../db';
import {
  cleanupWatchlist,
  expireStaleRecommendations,
} from '../services/scheduler/watchlistCleanup';

// ─── 헬퍼 ────────────────────────────────────────────────

function insertStock(id: number, ticker: string): void {
  execute(
    `INSERT INTO stocks (id, ticker, name, market) VALUES (?, ?, ?, 'KRX')`,
    [id, ticker, `${ticker} 종목`]
  );
}

function insertWatchlist(stockId: number, ageDays: number, autoTradeEnabled = 0): number {
  const { lastId } = execute(
    `INSERT INTO watchlist (stock_id, market, notes, auto_trade_enabled, added_at)
     VALUES (?, 'KRX', 'test', ?, datetime('now', '-${ageDays} days'))`,
    [stockId, autoTradeEnabled]
  );
  return lastId;
}

function insertSignal(
  stockId: number,
  signalType: 'BUY' | 'SELL' | 'HOLD',
  confidence: number,
  ageDays: number
): void {
  execute(
    `INSERT INTO trade_signals (stock_id, signal_type, source, confidence, created_at)
     VALUES (?, ?, 'test', ?, datetime('now', '-${ageDays} days'))`,
    [stockId, signalType, confidence]
  );
}

function insertRecommendation(
  ticker: string,
  opts: {
    score?: number;
    confidence?: number;
    ageDays?: number;
    expiresInDays?: number;
    status?: 'ACTIVE' | 'EXPIRED' | 'DISMISSED' | 'EXECUTED';
  } = {}
): number {
  const { score = 50, confidence = 70, ageDays = 0, expiresInDays = 3, status = 'ACTIVE' } = opts;
  const { lastId } = execute(
    `INSERT INTO recommendations
       (ticker, name, market, score, confidence, status, expires_at, created_at)
     VALUES (?, ?, 'KRX', ?, ?, ?, datetime('now', '+${expiresInDays} days'), datetime('now', '-${ageDays} days'))`,
    [ticker, `${ticker}이름`, score, confidence, status]
  );
  return lastId;
}

function insertTransaction(stockId: number, type: 'BUY' | 'SELL', quantity: number): void {
  execute(
    `INSERT INTO transactions (stock_id, type, quantity, price, fee, date)
     VALUES (?, ?, ?, 100, 0, date('now'))`,
    [stockId, type, quantity]
  );
}

// ─── 테스트 ───────────────────────────────────────────────

describe('cleanupWatchlist (UC-12: watchlist/추천 자동 정리)', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM watchlist');
    execute('DELETE FROM trade_signals');
    execute('DELETE FROM recommendations');
    execute('DELETE FROM stocks');
    execute('DELETE FROM transactions');
  });

  // ─── 규칙 1: 7일간 BUY 신호 없음 (v4.15.0: 3→7일 완화) ───

  describe('규칙 1: 7일간 BUY 신호 없음', () => {
    it('watchlist 등록 8일 지났고 BUY 신호 없으면 삭제', () => {
      insertStock(1, '000001');
      insertWatchlist(1, 8);
      insertSignal(1, 'HOLD', 50, 5); // 5일 전 HOLD만
      insertSignal(1, 'SELL', 50, 2);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 1');
      expect(row?.deleted_at).toBeTruthy();
    });

    it('5일 전 등록(7일 유예 중)은 삭제 안 함', () => {
      insertStock(2, '000002');
      insertWatchlist(2, 5);
      insertSignal(2, 'HOLD', 50, 1);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 2');
      expect(row?.deleted_at).toBeNull();
    });

    it('8일 지났지만 5일 전에 BUY 신호가 있었으면 유지', () => {
      insertStock(3, '000003');
      insertWatchlist(3, 8);
      insertSignal(3, 'BUY', 70, 5); // 7일 이내 BUY 있음

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 3');
      expect(row?.deleted_at).toBeNull();
    });

    it('trade_signals가 전혀 없으면 삭제 안 함 (EXISTS 가드)', () => {
      insertStock(4, '000004');
      insertWatchlist(4, 10);
      // 신호 전혀 없음

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 4');
      expect(row?.deleted_at).toBeNull();
    });
  });

  // ─── 실보유 종목 보호 ───

  describe('실보유 종목 보호 (isHoldingReal 가드)', () => {
    it('보유 중인 종목은 어떤 규칙으로도 삭제 안 함', () => {
      insertStock(10, '000010');
      insertWatchlist(10, 30); // 한 달된 watchlist
      insertSignal(10, 'SELL', 20, 1);
      insertSignal(10, 'HOLD', 20, 1);
      insertSignal(10, 'HOLD', 20, 1);
      insertTransaction(10, 'BUY', 100); // 보유 중

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 10');
      expect(row?.deleted_at).toBeNull();
    });

    it('매도 완료(순 수량 0)면 보호 해제되어 규칙 적용', () => {
      insertStock(11, '000011');
      insertWatchlist(11, 10);
      insertSignal(11, 'HOLD', 20, 1);
      insertSignal(11, 'HOLD', 20, 1);
      insertSignal(11, 'HOLD', 20, 1);
      insertTransaction(11, 'BUY', 100);
      insertTransaction(11, 'SELL', 100); // 순 수량 0

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 11');
      expect(row?.deleted_at).toBeTruthy();
    });
  });

  // ─── 규칙 2: 자동매매 비활성화 (신뢰도 저하) ───

  describe('규칙 2: 자동매매 비활성화', () => {
    it('최근 3개 신호 avg confidence < 40 → auto_trade_enabled=0', () => {
      insertStock(20, '000020');
      insertWatchlist(20, 1, 1); // auto_trade ON
      insertSignal(20, 'HOLD', 30, 0);
      insertSignal(20, 'HOLD', 20, 0);
      insertSignal(20, 'HOLD', 10, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT auto_trade_enabled, deleted_at FROM watchlist WHERE stock_id = 20');
      expect(row?.auto_trade_enabled).toBe(0);
      // 삭제는 별도 규칙 — auto_trade 비활성화만
    });

    it('avg confidence ≥ 40 이면 유지', () => {
      insertStock(21, '000021');
      insertWatchlist(21, 1, 1);
      insertSignal(21, 'BUY', 60, 0);
      insertSignal(21, 'BUY', 50, 0);
      insertSignal(21, 'HOLD', 40, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT auto_trade_enabled FROM watchlist WHERE stock_id = 21');
      expect(row?.auto_trade_enabled).toBe(1);
    });
  });

  // ─── 규칙 3: 추천 저점수 (3일 유예) ───

  describe('규칙 3: 추천 점수 저조', () => {
    it('4일 전 등록 + 추천 score 30 → 삭제', () => {
      insertStock(30, '000030');
      insertWatchlist(30, 4);
      insertRecommendation('000030', { score: 30 });
      insertSignal(30, 'BUY', 70, 0); // 규칙 1 회피용 (BUY 있음)

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 30');
      expect(row?.deleted_at).toBeTruthy();
    });

    it('score ≥ 40이면 유지', () => {
      insertStock(31, '000031');
      insertWatchlist(31, 4);
      insertRecommendation('000031', { score: 50 });
      insertSignal(31, 'BUY', 70, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 31');
      expect(row?.deleted_at).toBeNull();
    });

    it('2일 전 등록(3일 유예 중)은 저점수여도 유지', () => {
      insertStock(32, '000032');
      insertWatchlist(32, 2); // 2일 전 — 유예 기간
      insertRecommendation('000032', { score: 20 });
      insertSignal(32, 'BUY', 70, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 32');
      expect(row?.deleted_at).toBeNull();
    });
  });

  // ─── 규칙 5: 최근 3신호에 BUY 없음 ───

  describe('규칙 5: 최근 3개 신호에 BUY 없음', () => {
    it('4일 전 등록 + 최근 3신호가 HOLD/SELL/HOLD → 삭제', () => {
      insertStock(50, '000050');
      insertWatchlist(50, 4);
      insertSignal(50, 'BUY', 60, 10); // 오래된 BUY (최근 3개에 없음)
      insertSignal(50, 'HOLD', 50, 0);
      insertSignal(50, 'SELL', 50, 0);
      insertSignal(50, 'HOLD', 50, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 50');
      expect(row?.deleted_at).toBeTruthy();
    });

    it('최근 3개 중 1개라도 BUY면 유지', () => {
      insertStock(51, '000051');
      insertWatchlist(51, 4);
      insertSignal(51, 'HOLD', 50, 0);
      insertSignal(51, 'BUY', 60, 0); // 최근 BUY 있음
      insertSignal(51, 'HOLD', 50, 0);

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 51');
      expect(row?.deleted_at).toBeNull();
    });

    it('신호 3개 미만이면 판정 skip (유지)', () => {
      insertStock(52, '000052');
      insertWatchlist(52, 4);
      insertSignal(52, 'HOLD', 50, 0);
      insertSignal(52, 'HOLD', 50, 0);
      // 2개만

      cleanupWatchlist();

      const row = queryOne('SELECT deleted_at FROM watchlist WHERE stock_id = 52');
      expect(row?.deleted_at).toBeNull();
    });
  });
});

// ─── expireStaleRecommendations ─────────────────────────

describe('expireStaleRecommendations', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM recommendations');
  });

  it('expires_at 지난 ACTIVE → EXPIRED', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at)
       VALUES ('A1', 'A', 'KRX', 80, 70, 'ACTIVE', datetime('now', '-1 days'))`
    );

    const result = expireStaleRecommendations();

    expect(result.expired).toBeGreaterThan(0);
    const row = queryOne(`SELECT status FROM recommendations WHERE ticker = 'A1'`);
    expect(row?.status).toBe('EXPIRED');
  });

  it('score < 0 → 즉시 EXPIRED', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at)
       VALUES ('A2', 'A', 'KRX', -10, 70, 'ACTIVE', datetime('now', '+5 days'))`
    );

    expireStaleRecommendations();

    const row = queryOne(`SELECT status FROM recommendations WHERE ticker = 'A2'`);
    expect(row?.status).toBe('EXPIRED');
  });

  it('confidence < 50 → EXPIRED', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at)
       VALUES ('A3', 'A', 'KRX', 80, 40, 'ACTIVE', datetime('now', '+5 days'))`
    );

    expireStaleRecommendations();

    const row = queryOne(`SELECT status FROM recommendations WHERE ticker = 'A3'`);
    expect(row?.status).toBe('EXPIRED');
  });

  it('생성 5일+ ACTIVE → EXPIRED', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at, created_at)
       VALUES ('A4', 'A', 'KRX', 80, 70, 'ACTIVE', datetime('now', '+10 days'), datetime('now', '-6 days'))`
    );

    expireStaleRecommendations();

    const row = queryOne(`SELECT status FROM recommendations WHERE ticker = 'A4'`);
    expect(row?.status).toBe('EXPIRED');
  });

  it('7일+ EXPIRED는 물리 삭제', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at, created_at)
       VALUES ('A5', 'A', 'KRX', 80, 70, 'EXPIRED', datetime('now', '-8 days'), datetime('now', '-8 days'))`
    );

    const result = expireStaleRecommendations();

    expect(result.purged).toBeGreaterThan(0);
    const row = queryOne(`SELECT id FROM recommendations WHERE ticker = 'A5'`);
    // queryOne은 결과 없을 때 null 반환 (undefined 아님)
    expect(row).toBeNull();
  });

  it('정상 ACTIVE(score ≥ 0, confidence ≥ 50, 5일 이내)는 유지', () => {
    execute(
      `INSERT INTO recommendations (ticker, name, market, score, confidence, status, expires_at, created_at)
       VALUES ('A6', 'A', 'KRX', 80, 70, 'ACTIVE', datetime('now', '+10 days'), datetime('now', '-2 days'))`
    );

    expireStaleRecommendations();

    const row = queryOne(`SELECT status FROM recommendations WHERE ticker = 'A6'`);
    expect(row?.status).toBe('ACTIVE');
  });
});
