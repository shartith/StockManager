/**
 * 회귀 방지 — 삼성전자 유령 매수 5주 사건 (2026-06-12 ~ 07-02).
 *
 * 사건 경위:
 *   1. KIS 거래내역 동기화가 추적 시작 전 보유분 5주의 매도(SELL 5)를 원장에 입력
 *      → 대응 매수 기록이 없어 원장 raw 합계가 -5로 뚫림.
 *   2. reconcile(balanceSync)은 raw SUM 으로 잔고 계산(-1주) → KIS 실잔고 4주와
 *      맞추려 "추가매수 동기화" 유령 BUY 5 삽입.
 *   3. 매매 엔진(positionAverage.foldPositionAverage)은 초과매도를 0으로 클램프
 *      → -5는 사라지고 유령 +5만 반영되어 보유 9주로 인식.
 *   4. 매도 주문이 항상 9주로 제출 → KIS 가 APBK0400 거부 → 3주간 120여 회 실패,
 *      +13% 수익 포지션이 -22%(고점 대비)까지 방치됨.
 *
 * 수정: reconcile 의 잔고 계산을 엔진과 동일한 fold(클램프) 방식으로 단일화.
 * 이 테스트는 "두 계산이 항상 같은 값을 보게 한다"는 계약을 고정한다.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute, queryOne, queryAll } from '../db';
import { dbReconcileDeps } from '../services/balanceSync';
import {
  reconcileMarket,
  type KisHoldingSnapshot,
  type KisTrade,
  type ReconcileDeps,
} from '../services/portfolioReconcile';
import { foldPositionAverage, type PositionTx } from '../services/positionAverage';

const TODAY = '2026-06-15';

function seedStock(ticker: string, name: string): number {
  execute('INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)', [ticker, name, 'KRX', '']);
  return queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker])!.id;
}

function seedTx(stockId: number, type: 'BUY' | 'SELL', qty: number, price: number, date: string, memo = 'seed'): void {
  execute(
    'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [stockId, type, qty, price, 0, date, memo],
  );
}

/** 엔진(positionAverage)이 보는 보유 수량 — fold 방식. */
function engineQty(stockId: number): number {
  const txs = queryAll<PositionTx>(
    `SELECT type, quantity, price FROM transactions
     WHERE stock_id = ? AND deleted_at IS NULL ORDER BY date, id`,
    [stockId],
  );
  return foldPositionAverage(txs).quantity;
}

function phantomBuyCount(stockId: number): number {
  return queryOne<{ n: number }>(
    `SELECT COUNT(*) as n FROM transactions
     WHERE stock_id = ? AND deleted_at IS NULL AND memo LIKE '%추가매수 동기화%'`,
    [stockId],
  )!.n;
}

function makeDeps(tradesByTicker: Record<string, KisTrade[]>): ReconcileDeps {
  return {
    ...dbReconcileDeps,
    fetchKisTrades(ticker: string) {
      return tradesByTicker[ticker] ?? [];
    },
  };
}

describe('reconcile 유령 매수 회귀 — 원장 초과매도(추적 전 보유분 매도) 시나리오', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM transactions');
    execute('DELETE FROM stocks');
  });

  /** 삼성전자 6/15 상태 재현: 자동매매 순보유 4주 + KIS 거래내역에 추적 전 물량 매도 기록. */
  function seedSamsungScenario(): { id: number; trades: KisTrade[] } {
    const id = seedStock('005930', '삼성전자');
    // 자동매매 체결분 (fold = 4주)
    seedTx(id, 'BUY', 1, 277000, '2026-05-13', '자동매매 (KIS: 0020843200)');
    seedTx(id, 'BUY', 1, 273000, '2026-05-20', '자동매매 (KIS: 0011187500)');
    seedTx(id, 'SELL', 2, 306000, '2026-06-08', '자동매매 (KIS: 0014654800)');
    seedTx(id, 'BUY', 1, 297500, '2026-06-11', '자동매매 (KIS: 0010333600)');
    seedTx(id, 'BUY', 1, 324000, '2026-06-12', '자동매매 (KIS: 0005336100)');
    seedTx(id, 'BUY', 1, 333500, '2026-06-12', '자동매매 (KIS: 0012045200)');
    seedTx(id, 'BUY', 1, 336000, '2026-06-15', '자동매매 (KIS: 0018934900)');

    // KIS 거래내역(90일): 5/7 에 추적 시작 전 보유분 5주가 매도된 기록 포함.
    // BUY 3 / SELL 3 / SELL 5 → raw 합계 -5, fold 합계 0 (클램프).
    const trades: KisTrade[] = [
      { ticker: '005930', odno: '0018613000', type: 'BUY', quantity: 3, price: 263000, date: '2026-05-07' },
      { ticker: '005930', odno: '0018732200', type: 'SELL', quantity: 3, price: 262500, date: '2026-05-07' },
      { ticker: '005930', odno: '0013512200', type: 'SELL', quantity: 5, price: 263000, date: '2026-05-07' },
    ];
    return { id, trades };
  }

  it('KIS 실잔고 4주와 엔진 계산이 일치하면 유령 매수를 삽입하지 않는다', () => {
    const { id, trades } = seedSamsungScenario();
    expect(engineQty(id)).toBe(4); // 전제: 엔진은 4주로 본다

    const snap: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 4, avgPrice: 322750 },
    ];
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps({ '005930': trades }));

    // 핵심 계약: 유령 매수 없음 + 엔진이 보는 수량 == KIS 실잔고
    expect(phantomBuyCount(id)).toBe(0);
    expect(engineQty(id)).toBe(4);
  });

  it('재실행해도 멱등 — 유령 매수가 누적되지 않는다', () => {
    const { id, trades } = seedSamsungScenario();
    const snap: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 4, avgPrice: 322750 },
    ];
    const deps = makeDeps({ '005930': trades });

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', deps);
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', deps);
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', deps);

    expect(phantomBuyCount(id)).toBe(0);
    expect(engineQty(id)).toBe(4);
  });

  it('이미 유령 매수로 부풀려진 원장(9주)은 KIS 실잔고(4주)로 자동 치유된다', () => {
    const { id, trades } = seedSamsungScenario();
    // 과거 버그가 남긴 유령 매수 5주 → 엔진은 9주로 오인
    seedTx(id, 'BUY', 5, 322750, TODAY, 'KIS 동기화 (추가매수 동기화)');
    expect(engineQty(id)).toBe(9);

    const snap: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 4, avgPrice: 322750 },
    ];
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps({ '005930': trades }));

    expect(engineQty(id)).toBe(4); // 부분매도 동기화로 4주 수렴
  });

  it('진짜 추가매수(거래내역 미포착)는 계속 보정된다 — 기존 동작 보존', () => {
    const id = seedStock('000660', 'SK하이닉스');
    seedTx(id, 'BUY', 5, 180000, '2026-06-01');

    const snap: KisHoldingSnapshot[] = [
      { ticker: '000660', name: 'SK하이닉스', market: 'KRX', quantity: 8, avgPrice: 182000 },
    ];
    const result = reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps({}));

    expect(result.adjusted).toHaveLength(1);
    expect(engineQty(id)).toBe(8);
  });
});
