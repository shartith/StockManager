/**
 * 매도 수량 가드 — 장부 수량과 KIS 실잔고 불일치 방어 (삼성전자 사건 후속).
 *
 * 사건: DB 장부가 9주로 부풀려진 상태에서 실잔고 4주 계좌에 SELL 9 를 반복 제출
 * → APBK0400 거부 120여 회, 익절/트레일링 스톱 전부 불발.
 *
 * 계약:
 *   - 매도 수량은 항상 min(장부 수량, KIS 실잔고) 로 캡.
 *   - 실잔고 0 이면 주문 차단(blocked) — 강제 재동기화 트리거 대상.
 *   - 잔고 조회 실패(null)면 원 수량 유지 — 트레일링 스톱이 일시 조회 장애로
 *     멈추면 안 되므로 차단하지 않는다 (KIS 가 최종 판정).
 */

import { describe, it, expect } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { resolveSellQuantity, classifyFailure } from '../services/kisOrder';

describe('resolveSellQuantity — 매도 수량 캡', () => {
  it('장부(9) > 실잔고(4) → 4로 축소하고 clamped 표시', () => {
    const r = resolveSellQuantity(9, 4);
    expect(r).toEqual({ quantity: 4, clamped: true, blocked: false });
  });

  it('장부 == 실잔고 → 그대로 통과', () => {
    const r = resolveSellQuantity(4, 4);
    expect(r).toEqual({ quantity: 4, clamped: false, blocked: false });
  });

  it('장부(2) < 실잔고(4) → 요청 수량 유지 (초과 매도 금지)', () => {
    const r = resolveSellQuantity(2, 4);
    expect(r).toEqual({ quantity: 2, clamped: false, blocked: false });
  });

  it('실잔고 0 → 주문 차단(blocked)', () => {
    const r = resolveSellQuantity(9, 0);
    expect(r.blocked).toBe(true);
    expect(r.quantity).toBe(0);
  });

  it('잔고 조회 실패(null) → 원 수량 유지, 차단하지 않음', () => {
    const r = resolveSellQuantity(9, null);
    expect(r).toEqual({ quantity: 9, clamped: false, blocked: false });
  });
});

describe('classifyFailure — 주문가능수량 초과(APBK0400) 구조화', () => {
  it('APBK0400 은 QTY_EXCEEDED 로 분류된다', () => {
    expect(classifyFailure('APBK0400: 주문 가능한 수량을 초과했습니다.')).toBe('QTY_EXCEEDED');
  });

  it('메시지 본문만 있어도 QTY_EXCEEDED', () => {
    expect(classifyFailure('주문 가능한 수량을 초과했습니다.')).toBe('QTY_EXCEEDED');
  });

  it('기존 분류는 유지 — 거래정지/잔고부족', () => {
    expect(classifyFailure('APBK0066: 거래정지 종목입니다')).toBe('SUSPENDED');
    expect(classifyFailure('잔고부족')).toBe('INSUFFICIENT_FUNDS');
  });

  it('"수량 초과" 없는 일반 APBK 에러는 API_ERROR 유지', () => {
    expect(classifyFailure('APBK0506: 호가 단위 오류')).toBe('API_ERROR');
  });
});
