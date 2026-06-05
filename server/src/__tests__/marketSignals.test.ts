/**
 * v5.7.0 marketSignals — 순수 헬퍼 함수 검증.
 * KOSPI/Yahoo 네트워크 호출이 들어가는 함수는 별도 fetch mocking 이 필요해 여기서는 제외.
 */

import { describe, it, expect } from 'vitest';
import { simpleMovingAverage } from '../services/marketSignals';

describe('simpleMovingAverage', () => {
  it('윈도우보다 적은 데이터 → null', () => {
    expect(simpleMovingAverage([1, 2, 3], 5)).toBeNull();
    expect(simpleMovingAverage([], 1)).toBeNull();
  });

  it('정확히 윈도우 크기 → 전체 평균', () => {
    expect(simpleMovingAverage([10, 20, 30, 40, 50], 5)).toBe(30);
  });

  it('윈도우보다 많은 데이터 → 마지막 N 개로만 계산', () => {
    // 마지막 5개: [3,4,5,6,7] → 평균 5
    expect(simpleMovingAverage([1, 2, 3, 4, 5, 6, 7], 5)).toBe(5);
  });

  it('5일선 < 20일선 시그널 — 하락 추세 데이터', () => {
    // 30봉치 — 점진적 하락
    const closes = Array.from({ length: 30 }, (_, i) => 3000 - i * 5);
    const ma5 = simpleMovingAverage(closes, 5);
    const ma20 = simpleMovingAverage(closes, 20);
    expect(ma5).not.toBeNull();
    expect(ma20).not.toBeNull();
    expect(ma5!).toBeLessThan(ma20!); // 단기선이 장기선 아래 — 약세 시그널
  });

  it('5일선 > 20일선 — 상승 추세', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 2500 + i * 10);
    const ma5 = simpleMovingAverage(closes, 5);
    const ma20 = simpleMovingAverage(closes, 20);
    expect(ma5!).toBeGreaterThan(ma20!);
  });
});
