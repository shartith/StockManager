/**
 * marketNormalizer.ts — 시장 코드 정규화 유닛 테스트
 */
import { describe, it, expect } from 'vitest';
import { normalizeMarket, isOverseasMarket } from '../services/marketNormalizer';

describe('normalizeMarket', () => {
  it('KRX/KOSPI/KOSDAQ → KRX', () => {
    expect(normalizeMarket('KRX')).toBe('KRX');
    expect(normalizeMarket('KOSPI')).toBe('KRX');
    expect(normalizeMarket('KOSDAQ')).toBe('KRX');
    expect(normalizeMarket('kospi')).toBe('KRX');
  });

  it('NASDAQ alias 통일', () => {
    expect(normalizeMarket('NASDAQ')).toBe('NASDAQ');
    expect(normalizeMarket('NASD')).toBe('NASDAQ');
    expect(normalizeMarket('NAS')).toBe('NASDAQ');
    expect(normalizeMarket('nasdaq')).toBe('NASDAQ');
  });

  it('NYSE alias 통일', () => {
    expect(normalizeMarket('NYSE')).toBe('NYSE');
    expect(normalizeMarket('NYS')).toBe('NYSE');
    expect(normalizeMarket('New York')).toBe('NYSE');
  });

  it('AMEX alias 통일', () => {
    expect(normalizeMarket('AMEX')).toBe('AMEX');
    expect(normalizeMarket('AMS')).toBe('AMEX');
  });

  it('빈 입력은 빈 문자열', () => {
    expect(normalizeMarket('')).toBe('');
    expect(normalizeMarket(null)).toBe('');
    expect(normalizeMarket(undefined)).toBe('');
  });

  it('알 수 없는 입력은 대문자 그대로', () => {
    expect(normalizeMarket('XYZ')).toBe('XYZ');
  });
});

describe('isOverseasMarket', () => {
  it('KRX는 false', () => {
    expect(isOverseasMarket('KRX')).toBe(false);
    expect(isOverseasMarket('KOSPI')).toBe(false);
  });

  it('NYSE/NASDAQ/AMEX는 true', () => {
    expect(isOverseasMarket('NYSE')).toBe(true);
    expect(isOverseasMarket('NASDAQ')).toBe(true);
    expect(isOverseasMarket('NASD')).toBe(true);
    expect(isOverseasMarket('AMEX')).toBe(true);
  });

  it('빈 값은 false', () => {
    expect(isOverseasMarket('')).toBe(false);
    expect(isOverseasMarket(null)).toBe(false);
  });
});
