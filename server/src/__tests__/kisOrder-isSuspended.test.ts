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
import { isSuspendedToday, classifyFailure } from '../services/kisOrder';

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

  // v4.18.0: 구조화된 failure_reason='SUSPENDED' 우선 매칭
  describe('failure_reason 구조화 컬럼 (v4.18.0)', () => {
    it('failure_reason=SUSPENDED 이면 error_message 키워드 없어도 차단', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message, failure_reason, created_at)
         VALUES (700, 'SELL', 3, 100, 0, 'FAILED', 'Generic error text', 'SUSPENDED', datetime('now'))`
      );
      const r = isSuspendedToday(700);
      expect(r.suspended).toBe(true);
    });

    it('failure_reason=NETWORK 이면 차단 안 함', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message, failure_reason, created_at)
         VALUES (701, 'SELL', 3, 100, 0, 'FAILED', 'Timeout', 'NETWORK', datetime('now'))`
      );
      const r = isSuspendedToday(701);
      expect(r.suspended).toBe(false);
    });

    it('failure_reason 빈 값이지만 error_message에 APBK0066 있으면 backward compat로 차단', () => {
      execute(
        `INSERT INTO auto_trades (stock_id, order_type, quantity, price, fee, status, error_message, failure_reason, created_at)
         VALUES (702, 'SELL', 3, 100, 0, 'FAILED', 'APBK0066: 거래정지', '', datetime('now'))`
      );
      const r = isSuspendedToday(702);
      expect(r.suspended).toBe(true);
    });
  });
});

// ─── classifyFailure (v4.18.0) ────────────────────────────

describe('classifyFailure (v4.18.0: 에러 메시지 → FailureReason enum)', () => {
  it('APBK0066 → SUSPENDED', () => {
    expect(classifyFailure('APBK0066: 거래정지종목은 취소주문만 가능')).toBe('SUSPENDED');
  });

  it('"거래정지" 한글 키워드 → SUSPENDED', () => {
    expect(classifyFailure('거래정지 기간')).toBe('SUSPENDED');
  });

  it('"매매정지" → SUSPENDED', () => {
    expect(classifyFailure('매매정지 처분')).toBe('SUSPENDED');
  });

  it('"상장폐지" → SUSPENDED', () => {
    expect(classifyFailure('상장폐지 예정')).toBe('SUSPENDED');
  });

  it('"정리매매" → SUSPENDED', () => {
    expect(classifyFailure('정리매매 기간 중')).toBe('SUSPENDED');
  });

  it('"주문가능" → INSUFFICIENT_FUNDS', () => {
    expect(classifyFailure('주문가능 금액 부족')).toBe('INSUFFICIENT_FUNDS');
  });

  it('"잔고부족" → INSUFFICIENT_FUNDS', () => {
    expect(classifyFailure('잔고부족으로 주문 불가')).toBe('INSUFFICIENT_FUNDS');
  });

  it('"스프레드" → WIDE_SPREAD', () => {
    expect(classifyFailure('스프레드 과대 — 주문 취소')).toBe('WIDE_SPREAD');
  });

  it('"호가 깊이" → LOW_LIQUIDITY', () => {
    expect(classifyFailure('호가 깊이 부족')).toBe('LOW_LIQUIDITY');
  });

  it('"포지션 규칙" → POSITION_LIMIT', () => {
    expect(classifyFailure('포지션 규칙: 종목당 20% 초과')).toBe('POSITION_LIMIT');
  });

  it('"현재가 조회 실패" → QUOTE_FETCH_FAIL', () => {
    expect(classifyFailure('현재가 조회 실패')).toBe('QUOTE_FETCH_FAIL');
  });

  it('"Protection" → PROTECTION_BLOCKED', () => {
    expect(classifyFailure('StoplossGuard: 전체 매수 차단')).toBe('PROTECTION_BLOCKED');
  });

  it('"timeout" → NETWORK', () => {
    expect(classifyFailure('Request timeout')).toBe('NETWORK');
  });

  it('"ECONNREFUSED" → NETWORK', () => {
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1')).toBe('NETWORK');
  });

  it('기타 APBK 에러 코드 → API_ERROR', () => {
    expect(classifyFailure('APBK9999: 기타 에러')).toBe('API_ERROR');
  });

  it('빈 문자열 → UNKNOWN', () => {
    expect(classifyFailure('')).toBe('UNKNOWN');
  });

  it('분류 불가 메시지 → UNKNOWN', () => {
    expect(classifyFailure('알 수 없는 에러')).toBe('UNKNOWN');
  });
});
