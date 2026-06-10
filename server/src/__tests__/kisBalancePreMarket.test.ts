/**
 * v6.0.6 장전 보정 — 순수 함수 검증.
 *
 * 운영 신고: 8:48(장전)에 KIS 앱과 시스템 평가금액이 어긋남 + 헤드라인 0.00% 표시.
 * inquire-balance 가 개장 전 전일종가 기준인 것이 원인 — 보정 창 판정과
 * 손익률 폴백이 정확한지 확인.
 */

import { describe, it, expect } from 'vitest';
import { isPreMarketKst, resolveProfitRate } from '../services/kisBalance';

/** KST 벽시계 시각으로 Date 생성 (KST = UTC+9). */
function kst(dateStr: string, hour: number, minute: number): Date {
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`));
}

describe('isPreMarketKst — 장전(08:00~09:00 KST) 창 판정', () => {
  // 2026-06-11 = 목요일
  it('평일 08:00~08:59 는 장전', () => {
    expect(isPreMarketKst(kst('2026-06-11', 8, 0))).toBe(true);
    expect(isPreMarketKst(kst('2026-06-11', 8, 48))).toBe(true); // 신고 시각
    expect(isPreMarketKst(kst('2026-06-11', 8, 59))).toBe(true);
  });

  it('09:00 정각(개장)부터는 장전 아님 — 실시간가로 자동 일치', () => {
    expect(isPreMarketKst(kst('2026-06-11', 9, 0))).toBe(false);
    expect(isPreMarketKst(kst('2026-06-11', 12, 30))).toBe(false);
  });

  it('07:59 이전은 장전 보정 안 함', () => {
    expect(isPreMarketKst(kst('2026-06-11', 7, 59))).toBe(false);
    expect(isPreMarketKst(kst('2026-06-11', 0, 30))).toBe(false);
  });

  it('주말은 항상 false', () => {
    expect(isPreMarketKst(kst('2026-06-13', 8, 30))).toBe(false); // 토
    expect(isPreMarketKst(kst('2026-06-14', 8, 30))).toBe(false); // 일
  });

  it('UTC 자정 경계(KST 09:00 = UTC 00:00) 요일 계산이 안전', () => {
    // KST 목요일 08:30 = UTC 수요일 23:30 — KST 기준 요일/시각으로 판정돼야 함
    expect(isPreMarketKst(new Date('2026-06-10T23:30:00Z'))).toBe(true);
  });
});

describe('resolveProfitRate — 손익률 폴백', () => {
  it('KIS 가 정상 수익률을 주면 그대로 사용', () => {
    expect(resolveProfitRate(-5.85, -236_805, 4_049_700)).toBe(-5.85);
  });

  it('운영 버그 재현 — KIS 0% + 손실 있음 → 직접 계산 (-5.85%)', () => {
    expect(resolveProfitRate(0, -236_805, 4_049_700)).toBe(-5.85);
  });

  it('손익 0 이면 0 유지 (나누기/노이즈 없음)', () => {
    expect(resolveProfitRate(0, 0, 4_049_700)).toBe(0);
  });

  it('매입금 0 이면 폴백 불가 — 원값 유지', () => {
    expect(resolveProfitRate(0, -1000, 0)).toBe(0);
  });
});
