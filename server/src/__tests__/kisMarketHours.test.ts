/**
 * v6.1 시장 세션 + 거래소 라우팅 — 순수 함수 검증.
 *
 * 핵심 안전 규칙: 확장 세션(KRX 휴장)엔 NXT 로 라우팅돼야 하고, NXT 미설정이면
 * 항상 KRX(현행 검증 경로). 시간 판정이 어긋나면 "확장시간인데 KRX 주문 → 거부" 발생.
 */

import { describe, it, expect } from 'vitest';
import {
  getKstSession, resolveExchange, isExtendedSession, priceMarketDiv,
} from '../services/kisMarketHours';

/** KST 벽시계 시각 (KST = UTC+9). */
function kst(dateStr: string, hour: number, minute: number): Date {
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`));
}

describe('getKstSession — 세션 구간', () => {
  // 2026-06-11 = 목요일
  it('프리마켓 08:00~08:59', () => {
    expect(getKstSession(kst('2026-06-11', 8, 0))).toBe('pre');
    expect(getKstSession(kst('2026-06-11', 8, 59))).toBe('pre');
  });
  it('메인장 09:00~15:29', () => {
    expect(getKstSession(kst('2026-06-11', 9, 0))).toBe('main');
    expect(getKstSession(kst('2026-06-11', 15, 29))).toBe('main');
  });
  it('애프터마켓 15:30~19:59', () => {
    expect(getKstSession(kst('2026-06-11', 15, 30))).toBe('after');
    expect(getKstSession(kst('2026-06-11', 19, 59))).toBe('after');
  });
  it('휴장 — 20:00 이후·08:00 이전·주말', () => {
    expect(getKstSession(kst('2026-06-11', 20, 0))).toBe('closed');
    expect(getKstSession(kst('2026-06-11', 7, 59))).toBe('closed');
    expect(getKstSession(kst('2026-06-13', 10, 0))).toBe('closed'); // 토
    expect(getKstSession(kst('2026-06-14', 16, 0))).toBe('closed'); // 일
  });
  it('UTC 자정 경계 — KST 목 08:30 = UTC 수 23:30', () => {
    expect(getKstSession(new Date('2026-06-10T23:30:00Z'))).toBe('pre');
  });
});

describe('resolveExchange — 거래소 라우팅', () => {
  it('NXT 비활성이면 모든 세션 KRX (현행 검증 경로)', () => {
    expect(resolveExchange('main', false)).toBe('KRX');
    expect(resolveExchange('pre', false)).toBe('KRX');
    expect(resolveExchange('after', false)).toBe('KRX');
    expect(resolveExchange('closed', false)).toBe('KRX');
  });
  it('NXT 활성: 메인=SOR, 프리/애프터=NXT, 휴장=KRX', () => {
    expect(resolveExchange('main', true)).toBe('SOR');
    expect(resolveExchange('pre', true)).toBe('NXT');   // KRX 휴장 → NXT 로만 체결
    expect(resolveExchange('after', true)).toBe('NXT');
    expect(resolveExchange('closed', true)).toBe('KRX');
  });
});

describe('isExtendedSession / priceMarketDiv', () => {
  it('프리/애프터만 확장 세션', () => {
    expect(isExtendedSession('pre')).toBe(true);
    expect(isExtendedSession('after')).toBe(true);
    expect(isExtendedSession('main')).toBe(false);
    expect(isExtendedSession('closed')).toBe(false);
  });
  it('확장 세션 시세는 통합(UN), 그 외 KRX(J)', () => {
    expect(priceMarketDiv('pre')).toBe('UN');
    expect(priceMarketDiv('after')).toBe('UN');
    expect(priceMarketDiv('main')).toBe('J');
    expect(priceMarketDiv('closed')).toBe('J');
  });
});
