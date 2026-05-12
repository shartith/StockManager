import { describe, it, expect } from 'vitest';
import { roundDownToTick } from '../services/kisOrder';

describe('roundDownToTick — 한국 주식 호가 단위 보정', () => {
  it('< 2,000원 → 1원 단위', () => {
    expect(roundDownToTick(1999)).toBe(1999);
    expect(roundDownToTick(1500.7)).toBe(1500);
  });

  it('2,000 ~ 5,000원 → 5원 단위', () => {
    expect(roundDownToTick(2003)).toBe(2000);
    expect(roundDownToTick(4998)).toBe(4995);
  });

  it('5,000 ~ 20,000원 → 10원 단위', () => {
    expect(roundDownToTick(5007)).toBe(5000);
    expect(roundDownToTick(19999)).toBe(19990);
  });

  it('20,000 ~ 50,000원 → 50원 단위', () => {
    expect(roundDownToTick(20049)).toBe(20000);
    expect(roundDownToTick(49999)).toBe(49950);
  });

  it('50,000 ~ 200,000원 → 100원 단위', () => {
    expect(roundDownToTick(106664)).toBe(106600); // SK텔레콤 v5.4 실패 케이스
    expect(roundDownToTick(199999)).toBe(199900);
  });

  it('200,000 ~ 500,000원 → 500원 단위', () => {
    expect(roundDownToTick(277605)).toBe(277500); // 삼성전자 -0.5%
    expect(roundDownToTick(414417)).toBe(414000); // 한미반도체 v5.4 실패 케이스
    expect(roundDownToTick(499999)).toBe(499500);
  });

  it('500,000원 이상 → 1,000원 단위', () => {
    expect(roundDownToTick(988035)).toBe(988000);  // 삼성전기 v5.4 실패 케이스
    expect(roundDownToTick(718390)).toBe(718000);  // HD현대중공업 v5.4 실패 케이스
    expect(roundDownToTick(1825825)).toBe(1825000); // SK하이닉스 -0.5%
  });

  it('경계값 정확', () => {
    expect(roundDownToTick(2000)).toBe(2000);   // 정확히 5원 단위 진입
    expect(roundDownToTick(5000)).toBe(5000);   // 정확히 10원 단위
    expect(roundDownToTick(20000)).toBe(20000);
    expect(roundDownToTick(50000)).toBe(50000);
    expect(roundDownToTick(200000)).toBe(200000);
    expect(roundDownToTick(500000)).toBe(500000);
  });

  it('0 또는 음수 → 0', () => {
    expect(roundDownToTick(0)).toBe(0);
    expect(roundDownToTick(-100)).toBe(0);
  });
});
