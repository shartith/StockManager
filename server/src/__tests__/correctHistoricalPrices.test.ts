/**
 * 과거 잘못된 KIS 동기화 트랜잭션 평단 보정 로직.
 *
 * pickBestMatch 의 후보 선택 규칙(같은 ticker+type+quantity → 가장 가까운 날짜)
 * 만 분리 검증한다 (KIS API 호출은 정합성 테스트의 범위 밖).
 */

import { describe, it, expect } from 'vitest';
import type { KisTrade } from '../services/portfolioReconcile';

// pickBestMatch 는 내부 함수라 동일 로직을 여기 재구현해 테스트한다.
// (서비스 코드는 fetchKisTradeHistory + DB query 결합이라 단위테스트가 무거워짐)
function pickBestMatch(
  tx: { ticker: string; type: 'BUY' | 'SELL'; quantity: number; date: string },
  trades: KisTrade[],
  usedOdnos: Set<string>,
): KisTrade | null {
  const candidates = trades.filter(
    t => t.ticker === tx.ticker && t.type === tx.type && t.quantity === tx.quantity && !usedOdnos.has(t.odno),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const txDate = new Date(tx.date).getTime();
  let best = candidates[0];
  let bestDist = Math.abs(new Date(best.date).getTime() - txDate);
  for (const c of candidates.slice(1)) {
    const dist = Math.abs(new Date(c.date).getTime() - txDate);
    if (dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

describe('correctHistoricalPrices — pickBestMatch', () => {
  const sampleTrades: KisTrade[] = [
    { ticker: '329180', odno: 'A', type: 'BUY', quantity: 1, price: 650_000, date: '2026-04-01' },
    { ticker: '329180', odno: 'B', type: 'BUY', quantity: 1, price: 690_000, date: '2026-04-15' },
    { ticker: '329180', odno: 'C', type: 'BUY', quantity: 2, price: 700_000, date: '2026-04-20' },
    { ticker: '005930', odno: 'D', type: 'SELL', quantity: 5, price: 70_000, date: '2026-05-01' },
  ];

  it('정확 매치 1개 → 그 거래 반환', () => {
    const tx = { ticker: '329180', type: 'BUY' as const, quantity: 2, date: '2026-04-20' };
    const m = pickBestMatch(tx, sampleTrades, new Set());
    expect(m?.odno).toBe('C');
  });

  it('정확 매치 0개 → null (ticker/type/qty 중 하나라도 다르면)', () => {
    const tx = { ticker: '329180', type: 'BUY' as const, quantity: 3, date: '2026-04-15' };
    expect(pickBestMatch(tx, sampleTrades, new Set())).toBeNull();

    const tx2 = { ticker: '329180', type: 'SELL' as const, quantity: 1, date: '2026-04-15' };
    expect(pickBestMatch(tx2, sampleTrades, new Set())).toBeNull();
  });

  it('정확 매치 여러 개 → 날짜가 가장 가까운 것 선택', () => {
    // qty=1 BUY 가 4/1, 4/15 두 건 — 4/14 와 가까운 4/15 가 선택돼야 함
    const tx = { ticker: '329180', type: 'BUY' as const, quantity: 1, date: '2026-04-14' };
    const m = pickBestMatch(tx, sampleTrades, new Set());
    expect(m?.odno).toBe('B');
    expect(m?.price).toBe(690_000);
  });

  it('usedOdnos 에 들어간 거래는 후보에서 제외', () => {
    // 'B' 가 이미 다른 tx 에 매칭됐다고 가정 → 4/14 와 가까워도 'A' 가 선택됨
    const tx = { ticker: '329180', type: 'BUY' as const, quantity: 1, date: '2026-04-14' };
    const m = pickBestMatch(tx, sampleTrades, new Set(['B']));
    expect(m?.odno).toBe('A');
  });

  it('현대중공업 690k 매수 케이스 — pchs_avg_pric 650k 와 다른 실제 체결가 식별', () => {
    // 과거 OLD reconcile 이 박은 행: avg_price 인 650k 로 들어가 있고 sync 날짜 4/16 으로 박혀있음
    const oldTx = { ticker: '329180', type: 'BUY' as const, quantity: 1, date: '2026-04-16' };
    const m = pickBestMatch(oldTx, sampleTrades, new Set());
    // 가장 가까운 날짜의 후보 → 4/15 B (690k) 가 선택됨 — 보정 후 평단이 정확해짐
    expect(m?.odno).toBe('B');
    expect(m?.price).toBe(690_000);
  });
});
