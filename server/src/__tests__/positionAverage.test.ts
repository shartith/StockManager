/**
 * v6.0.4 포지션 평단가 — KIS 방식 이동평균 검증.
 *
 * 운영 버그 재현: "전체 기간 매수 평균"이 매도분에 오염돼 삼성전자 실제 매입평균
 * 309,500원이 277,250원으로 표시되던 문제. KIS 규칙(매도 시 평단 불변, 전량 매도
 * 시 리셋)대로 계산되는지 확인.
 */

import { describe, it, expect } from 'vitest';
import { foldPositionAverage, type PositionTx } from '../services/positionAverage';

const buy = (quantity: number, price: number): PositionTx => ({ type: 'BUY', quantity, price });
const sell = (quantity: number, price: number): PositionTx => ({ type: 'SELL', quantity, price });

describe('foldPositionAverage — KIS 방식 이동평균', () => {
  it('단일 매수 → 평단 = 매수가', () => {
    expect(foldPositionAverage([buy(1, 435_000)])).toEqual({ quantity: 1, avgPrice: 435_000 });
  });

  it('추가 매수 → 가중 이동평균', () => {
    // 1주 100,000 + 1주 120,000 = 평단 110,000
    const r = foldPositionAverage([buy(1, 100_000), buy(1, 120_000)]);
    expect(r.quantity).toBe(2);
    expect(r.avgPrice).toBe(110_000);
  });

  it('부분 매도 → 수량만 감소, 평단 불변 (KIS 규칙)', () => {
    const r = foldPositionAverage([buy(2, 100_000), buy(2, 120_000), sell(2, 150_000)]);
    expect(r.quantity).toBe(2);
    expect(r.avgPrice).toBe(110_000); // 매도가 150,000 은 평단에 영향 없음
  });

  it('전량 매도 → 포지션 리셋, 재매수 시 새 평단', () => {
    const r = foldPositionAverage([
      buy(8, 263_000),
      sell(8, 300_000),  // 전량 매도 → 리셋
      buy(1, 309_500),   // 새 포지션
    ]);
    expect(r.quantity).toBe(1);
    expect(r.avgPrice).toBe(309_500); // 과거 263,000 매수가 섞이면 안 됨
  });

  it('운영 버그 재현 — 삼성전자: 과거 매매가 현재 평단을 오염시키지 않는다', () => {
    // 실제 시나리오 근사: 5월 263,000원대 8주 매매 후, 6월 새 포지션
    const txs: PositionTx[] = [
      buy(5, 263_000), buy(3, 262_500),       // 5월 매수 8주
      sell(8, 270_000),                        // 전량 매도
      buy(2, 306_000),                         // 6월 신규 2주
      sell(2, 306_000),                        // 트레일링 매도 (전량)
      buy(1, 309_500),                         // 현재 1주
    ];
    const r = foldPositionAverage(txs);
    expect(r.quantity).toBe(1);
    expect(r.avgPrice).toBe(309_500); // KIS 매입평균과 일치 (구버전은 ~277,000 으로 오염)
  });

  it('보유량 초과 매도(데이터 드리프트) → 0 클램프 + 리셋', () => {
    const r = foldPositionAverage([buy(1, 100_000), sell(3, 90_000), buy(2, 50_000)]);
    expect(r.quantity).toBe(2);
    expect(r.avgPrice).toBe(50_000); // 음수 수량/엉뚱한 평단 없이 새 포지션
  });

  it('거래 없음 → 0/0', () => {
    expect(foldPositionAverage([])).toEqual({ quantity: 0, avgPrice: 0 });
  });

  it('소수 수량(분할 체결)도 정확히 가중', () => {
    const r = foldPositionAverage([buy(0.5, 100_000), buy(1.5, 200_000)]);
    expect(r.quantity).toBe(2);
    expect(r.avgPrice).toBe(175_000);
  });
});
