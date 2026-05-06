/**
 * marketNormalizer.ts — 시장 코드 정규화 유닛 테스트 (KRX 단일)
 */
import { describe, it, expect } from 'vitest';
import { normalizeMarket } from '../services/marketNormalizer';

describe('normalizeMarket', () => {
  it('KRX/KOSPI/KOSDAQ → KRX', () => {
    expect(normalizeMarket('KRX')).toBe('KRX');
    expect(normalizeMarket('KOSPI')).toBe('KRX');
    expect(normalizeMarket('KOSDAQ')).toBe('KRX');
    expect(normalizeMarket('kospi')).toBe('KRX');
  });

  it('빈 입력은 빈 문자열', () => {
    expect(normalizeMarket('')).toBe('');
    expect(normalizeMarket(null)).toBe('');
    expect(normalizeMarket(undefined)).toBe('');
  });

  it('알 수 없는 입력은 빈 문자열', () => {
    expect(normalizeMarket('XYZ')).toBe('');
    expect(normalizeMarket('NYSE')).toBe('');
    expect(normalizeMarket('NASDAQ')).toBe('');
  });
});
