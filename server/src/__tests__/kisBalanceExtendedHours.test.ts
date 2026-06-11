/**
 * v6.0.8 장전·장후 확장 거래시간 보정 — 순수 함수 검증.
 *
 * 운영 요구: "장전이나 장후나 실시간으로 변경되는 시세(현재가/평가금액)가 반영되어야
 * 한다." inquire-balance 는 KRX 정규장 밖에서 KRX 종가/전일종가에 고정되므로,
 * NXT 프리마켓(08:00~)·애프터마켓(15:30~20:00) 동안 통합 시세 보정 창을 판정한다.
 */

import { describe, it, expect } from 'vitest';
import { isExtendedHoursKst, resolveProfitRate } from '../services/kisBalance';

/** KST 벽시계 시각으로 Date 생성 (KST = UTC+9). */
function kst(dateStr: string, hour: number, minute: number): Date {
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`));
}

describe('isExtendedHoursKst — 장전·장후 보정 창 판정', () => {
  // 2026-06-11 = 목요일
  it('장전 08:00~08:59 — 보정 ON (NXT 프리마켓/예상체결가)', () => {
    expect(isExtendedHoursKst(kst('2026-06-11', 8, 0))).toBe(true);
    expect(isExtendedHoursKst(kst('2026-06-11', 8, 48))).toBe(true); // 최초 신고 시각
    expect(isExtendedHoursKst(kst('2026-06-11', 8, 59))).toBe(true);
  });

  it('KRX 정규장 09:00~15:29 — 보정 OFF (prpr 자체가 실시간)', () => {
    expect(isExtendedHoursKst(kst('2026-06-11', 9, 0))).toBe(false);
    expect(isExtendedHoursKst(kst('2026-06-11', 12, 30))).toBe(false);
    expect(isExtendedHoursKst(kst('2026-06-11', 15, 29))).toBe(false);
  });

  it('장후 15:30~19:59 — 보정 ON (NXT 애프터마켓)', () => {
    expect(isExtendedHoursKst(kst('2026-06-11', 15, 30))).toBe(true);
    expect(isExtendedHoursKst(kst('2026-06-11', 16, 0))).toBe(true);
    expect(isExtendedHoursKst(kst('2026-06-11', 19, 59))).toBe(true);
  });

  it('20:00 이후·08:00 이전 — 보정 OFF (거래 없음)', () => {
    expect(isExtendedHoursKst(kst('2026-06-11', 20, 0))).toBe(false);
    expect(isExtendedHoursKst(kst('2026-06-11', 23, 30))).toBe(false);
    expect(isExtendedHoursKst(kst('2026-06-11', 7, 59))).toBe(false);
    expect(isExtendedHoursKst(kst('2026-06-11', 0, 30))).toBe(false);
  });

  it('주말은 항상 OFF', () => {
    expect(isExtendedHoursKst(kst('2026-06-13', 8, 30))).toBe(false);  // 토 장전
    expect(isExtendedHoursKst(kst('2026-06-13', 16, 0))).toBe(false);  // 토 장후
    expect(isExtendedHoursKst(kst('2026-06-14', 16, 0))).toBe(false);  // 일
  });

  it('UTC 경계 안전 — KST 목 08:30 = UTC 수 23:30 도 KST 기준으로 판정', () => {
    expect(isExtendedHoursKst(new Date('2026-06-10T23:30:00Z'))).toBe(true);
  });

  it('UTC 경계 안전 — KST 금 16:00(장후) = UTC 금 07:00', () => {
    expect(isExtendedHoursKst(new Date('2026-06-12T07:00:00Z'))).toBe(true);
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
