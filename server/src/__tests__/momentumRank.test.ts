/**
 * v6.0 모멘텀 랭킹 — 순수 함수(rankByMomentum) 검증.
 * fetchMomentumScores 는 네트워크 의존이라 제외, 랭킹 재정렬 로직만 검증.
 */

import { describe, it, expect } from 'vitest';
import { rankByMomentum } from '../services/momentumRank';
import type { TopStock } from '../services/topMarketCap';

function stock(ticker: string, rank: number): TopStock {
  return {
    rank,
    ticker,
    name: ticker,
    market: 'KOSPI',
    marketCapKrw: 0,
    marketCapEok: 0,
    marketCapHangeul: '',
    closePrice: 10000,
    fluctuationsRatio: 0,
  };
}

describe('rankByMomentum', () => {
  const universe = [stock('A', 1), stock('B', 2), stock('C', 3), stock('D', 4)];

  it('모멘텀 점수 내림차순으로 재랭킹 (시총 순위 무시)', () => {
    // 시총 1위 A 가 모멘텀은 꼴찌, 시총 4위 D 가 모멘텀 1위
    const scores = new Map([['A', -0.1], ['B', 0.05], ['C', 0.2], ['D', 0.5]]);
    const ranked = rankByMomentum(universe, scores);
    expect(ranked.map(s => s.ticker)).toEqual(['D', 'C', 'B', 'A']);
    expect(ranked.map(s => s.rank)).toEqual([1, 2, 3, 4]); // rank 재부여
  });

  it('점수 없는 종목은 맨 뒤로', () => {
    const scores = new Map([['A', 0.3], ['C', 0.1]]); // B, D 점수 없음
    const ranked = rankByMomentum(universe, scores);
    expect(ranked[0].ticker).toBe('A'); // 0.3 1위
    expect(ranked[1].ticker).toBe('C'); // 0.1 2위
    // B, D 는 -Infinity 취급 → 뒤쪽 (순서는 안정정렬 상 입력순 B 먼저)
    expect(ranked.slice(2).map(s => s.ticker).sort()).toEqual(['B', 'D']);
  });

  it('점수 맵이 비면 입력 그대로(시총 순서) 폴백', () => {
    const ranked = rankByMomentum(universe, new Map());
    expect(ranked.map(s => s.ticker)).toEqual(['A', 'B', 'C', 'D']);
    expect(ranked).toBe(universe); // 동일 참조 반환 (복사 안 함)
  });

  it('원본 universe 불변 (immutable)', () => {
    const scores = new Map([['A', -1], ['D', 1]]);
    const before = universe.map(s => s.ticker).join(',');
    rankByMomentum(universe, scores);
    expect(universe.map(s => s.ticker).join(',')).toBe(before); // 원본 순서 유지
    expect(universe[0].rank).toBe(1); // 원본 rank 도 그대로
  });

  it('모멘텀 1위가 매수 우선순위가 되도록 rank=1 부여', () => {
    const scores = new Map([['A', 0.01], ['B', 0.02], ['C', 0.99], ['D', 0.5]]);
    const ranked = rankByMomentum(universe, scores);
    const top1 = ranked.find(s => s.rank === 1);
    expect(top1!.ticker).toBe('C'); // 최고 모멘텀
  });
});
