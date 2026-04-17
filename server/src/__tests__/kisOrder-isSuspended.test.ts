/**
 * kisOrder.ts — isSuspendedToday 단위 테스트 (UC-07)
 *
 * executeOrder 전체는 KIS API·apiQueue·portfolioManager 등 외부 의존이 커서
 * 통합 테스트가 어렵다. 대신 당일 거래정지 차단 로직(isSuspendedToday)을
 * 공개 API로 노출하고 순수 DB 조회 + 키워드 매칭 동작을 검증한다.
 *
 * 4/17 stock_id=289 SELL 28회 실패 같은 사건이 재발하지 않도록 보장.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute } from '../db';
import { isSuspendedToday } from '../services/kisOrder';

/** 특정 에러 메시지로 FAILED auto_trades 레코드 삽입 헬퍼 */
function insertFailedTrade(stockId: number, errorMessage: string, ageHours: number = 0): void {
  execute(
    `INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message, created_at)
     VALUES (?, 'SELL', 3, 100, 0, 'FAILED', ?, datetime('now', '-${ageHours} hours'))`,
    [stockId, errorMessage]
  );
}

describe('isSuspendedToday (UC-07: 거래정지 당일 차단)', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
  });

  beforeEach(() => {
    execute('DELETE FROM auto_trades');
  });

  describe('키워드 매칭', () => {
    it('이력 없으면 suspended=false', () => {
      const r = isSuspendedToday(100);
      expect(r.suspended).toBe(false);
      expect(r.reason).toBeUndefined();
    });

    it('APBK0066 에러 → suspended=true', () => {
      insertFailedTrade(
        101,
        'APBK0066: 거래정지종목(주식)은 취소주문만 가능(정정불가)합니다.'
      );
      const r = isSuspendedToday(101);
      expect(r.suspended).toBe(true);
      expect(r.reason).toContain('APBK0066');
    });

    it('"거래정지" 키워드 → suspended=true', () => {
      insertFailedTrade(102, '거래정지 중인 종목입니다');
      const r = isSuspendedToday(102);
      expect(r.suspended).toBe(true);
    });

    it('"매매정지" 키워드 → suspended=true', () => {
      insertFailedTrade(103, '매매정지 처분된 종목');
      const r = isSuspendedToday(103);
      expect(r.suspended).toBe(true);
    });

    it('"상장폐지" 키워드 → suspended=true', () => {
      insertFailedTrade(104, '상장폐지 예정 — 주문 불가');
      const r = isSuspendedToday(104);
      expect(r.suspended).toBe(true);
    });

    it('"정리매매" 키워드 → suspended=true', () => {
      insertFailedTrade(105, '정리매매 기간 중');
      const r = isSuspendedToday(105);
      expect(r.suspended).toBe(true);
    });

    it('무관한 에러 메시지는 통과', () => {
      insertFailedTrade(106, '주문가능 금액 부족');
      const r = isSuspendedToday(106);
      expect(r.suspended).toBe(false);
    });

    it('네트워크 에러 → 통과 (거래정지 아님)', () => {
      insertFailedTrade(107, 'Network timeout');
      const r = isSuspendedToday(107);
      expect(r.suspended).toBe(false);
    });
  });

  describe('날짜 경계', () => {
    it('25시간 전 이력(어제) → 자동 해제로 통과', () => {
      insertFailedTrade(200, 'APBK0066: 거래정지', 25);
      const r = isSuspendedToday(200);
      expect(r.suspended).toBe(false);
    });

    it('23시간 전 이력(오늘) → 차단 유지', () => {
      insertFailedTrade(201, 'APBK0066: 거래정지', 0.5); // 30분 전
      const r = isSuspendedToday(201);
      expect(r.suspended).toBe(true);
    });
  });

  describe('status 필터', () => {
    it('FILLED 주문은 suspended로 간주 안 함', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, error_message, created_at)
         VALUES (300, 'BUY', 'FILLED', 10, 100, 'APBK0066 (과거 메모)', datetime('now'))`
      );
      const r = isSuspendedToday(300);
      expect(r.suspended).toBe(false);
    });

    it('PENDING 주문도 suspended 판정 안 함', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, status, quantity, price, error_message, created_at)
         VALUES (301, 'BUY', 'PENDING', 10, 100, '거래정지 예정', datetime('now'))`
      );
      const r = isSuspendedToday(301);
      expect(r.suspended).toBe(false);
    });
  });

  describe('stock_id 격리', () => {
    it('다른 종목의 거래정지 이력은 영향 없음', () => {
      insertFailedTrade(400, 'APBK0066: 거래정지');
      const r = isSuspendedToday(999);
      expect(r.suspended).toBe(false);
    });

    it('여러 종목 각각 독립 판정', () => {
      insertFailedTrade(500, 'APBK0066: 거래정지');
      insertFailedTrade(501, '주문가능 금액 부족');
      expect(isSuspendedToday(500).suspended).toBe(true);
      expect(isSuspendedToday(501).suspended).toBe(false);
      expect(isSuspendedToday(502).suspended).toBe(false);
    });
  });

  describe('최신 이력 선택', () => {
    it('같은 종목 여러 실패 이력 중 가장 최근 메시지를 reason으로 반환', () => {
      insertFailedTrade(600, 'APBK0066: 거래정지 (오래된 메시지)', 3);
      insertFailedTrade(600, 'APBK0066: 매매정지 (최근 메시지)', 0.1);
      const r = isSuspendedToday(600);
      expect(r.suspended).toBe(true);
      expect(r.reason).toContain('최근 메시지');
    });
  });
});
