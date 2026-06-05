/**
 * v5.6.3 회귀 방지 — KIS 거래내역 기반 reconcile.
 *
 * 버그(v5.6.2 이전): balanceSync 가 KIS 잔고의 `pchs_avg_pric`(브로커 가중평단)
 * 을 그대로 BUY 가격으로 사용해, 사용자가 실제 매수한 단가(예: 690,000원)와
 * KIS 가 보여주는 가중평단(예: 650,000원)이 다를 때 DB 평단이 잘못 기록됨
 * (현대중공업 690k 매수 → 평단 650k 표시 케이스).
 *
 * 수정: reconcile 시 우선 KIS 거래내역(inquire-daily-ccld) API 로 실제 체결가
 * 를 가져와 BUY 를 입력. 주문번호(odno) 로 dedup. 거래내역을 얻지 못한 경우만
 * 기존 avg_price 폴백.
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

const TODAY = '2026-06-01';

function makeDeps(tradesByTicker: Record<string, KisTrade[]>): ReconcileDeps {
  return {
    ...dbReconcileDeps,
    fetchKisTrades(ticker: string) {
      return tradesByTicker[ticker] ?? [];
    },
  };
}

function getTransactions(stockId: number) {
  return queryAll<{
    type: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    memo: string;
    date: string;
  }>(
    `SELECT type, quantity, price, memo, date FROM transactions
     WHERE stock_id = ? AND deleted_at IS NULL ORDER BY id ASC`,
    [stockId],
  );
}

describe('portfolioReconcile — 거래내역 기반 실제 체결가 입력', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM transactions');
    execute('DELETE FROM stocks');
  });

  it('신규 종목 + 거래내역 1건 → 실제 체결가로 BUY 입력 (avg_price 무시)', () => {
    // KIS 잔고: 현대중공업 1주, 평단(브로커 가중) 650,000원
    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 1, avgPrice: 650_000 },
    ];
    // 그러나 실제 거래내역: 690,000원에 1주 체결
    const trades: Record<string, KisTrade[]> = {
      '329180': [
        { ticker: '329180', odno: 'ORD-001', type: 'BUY', quantity: 1, price: 690_000, date: '2026-06-01' },
      ],
    };

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps(trades));

    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    const tx = getTransactions(id);
    expect(tx).toHaveLength(1);
    expect(tx[0].type).toBe('BUY');
    expect(tx[0].quantity).toBe(1);
    expect(tx[0].price).toBe(690_000); // ★ 핵심: avg_price(650k)가 아니라 실제 체결가
    expect(tx[0].memo).toContain('ORD-001'); // 주문번호가 memo 에 기록됨
  });

  it('거래내역 여러 건 → 각각 실제 체결가로 BUY 입력', () => {
    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 3, avgPrice: 660_000 },
    ];
    const trades: Record<string, KisTrade[]> = {
      '329180': [
        { ticker: '329180', odno: 'A', type: 'BUY', quantity: 1, price: 650_000, date: '2026-05-30' },
        { ticker: '329180', odno: 'B', type: 'BUY', quantity: 1, price: 670_000, date: '2026-05-31' },
        { ticker: '329180', odno: 'C', type: 'BUY', quantity: 1, price: 690_000, date: '2026-06-01' },
      ],
    };

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps(trades));

    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    const tx = getTransactions(id);
    expect(tx).toHaveLength(3);
    expect(tx.map(t => t.price).sort()).toEqual([650_000, 670_000, 690_000]);
    // 가중평단 = (650+670+690)/3 = 670,000 (avgPrice 660,000 와는 다른 정확한 값)
  });

  it('거래내역이 비어있으면 avg_price 폴백 (기존 동작 유지)', () => {
    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 1, avgPrice: 650_000 },
    ];
    // fetchKisTrades 가 빈 배열 반환 — 거래내역이 너무 오래되어 조회 불가한 케이스
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps({}));

    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    const tx = getTransactions(id);
    expect(tx).toHaveLength(1);
    expect(tx[0].price).toBe(650_000); // 폴백
  });

  it('주문번호(odno) 중복 방지 — 두 번 가져와도 같은 거래는 한 번만 입력', () => {
    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 1, avgPrice: 690_000 },
    ];
    const trades: Record<string, KisTrade[]> = {
      '329180': [
        { ticker: '329180', odno: 'ORD-DUP', type: 'BUY', quantity: 1, price: 690_000, date: '2026-06-01' },
      ],
    };
    const deps = makeDeps(trades);

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', deps);
    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', deps); // 두 번째

    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    const tx = getTransactions(id);
    expect(tx).toHaveLength(1); // odno 'ORD-DUP' 한 번만
  });

  it('자동매매 BUY 가 이미 있는 odno 는 EOD reconcile 시 중복 입력되지 않는다 (회귀)', () => {
    // 자동매매 시나리오: kisOrder.ts 가 memo "자동매매 (KIS: 7777) / Top10 #N 신규 진입" 으로 박는다.
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['329180', 'HD현대중공업', 'KRX']);
    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, 'BUY', 1, 690_000, 0, '2026-06-01', '자동매매 (KIS: 7777) / Top10 #3 신규 진입'],
    );

    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 1, avgPrice: 690_000 },
    ];
    const trades: Record<string, KisTrade[]> = {
      '329180': [
        { ticker: '329180', odno: '7777', type: 'BUY', quantity: 1, price: 690_000, date: '2026-06-01' },
      ],
    };

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'EOD 자동 reconcile', makeDeps(trades));

    const tx = getTransactions(id);
    expect(tx).toHaveLength(1); // 자동매매 거래 1건만 — phantom 중복 없음
    expect(tx[0].memo).toContain('KIS: 7777'); // 원본 memo 유지
  });

  it('추가매수 동기화 — DB에 없는 odno 거래만 추가 입력 (실제 체결가)', () => {
    // 초기: DB 에 1주 690k 매수 기록 (사용자가 앱에서 직접 매수)
    execute('INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)', ['329180', 'HD현대중공업', 'KRX']);
    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['329180'])!.id;
    execute(
      'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, 'BUY', 1, 690_000, 0, '2026-05-30', 'manual odno=ORD-OLD'],
    );

    // KIS 잔고: 2주, 평단 670k (1주는 새로 670k 에 매수됨)
    const snap: KisHoldingSnapshot[] = [
      { ticker: '329180', name: 'HD현대중공업', market: 'KRX', quantity: 2, avgPrice: 670_000 },
    ];
    // 거래내역: 기존 ORD-OLD + 신규 ORD-NEW
    const trades: Record<string, KisTrade[]> = {
      '329180': [
        { ticker: '329180', odno: 'ORD-OLD', type: 'BUY', quantity: 1, price: 690_000, date: '2026-05-30' },
        { ticker: '329180', odno: 'ORD-NEW', type: 'BUY', quantity: 1, price: 650_000, date: '2026-06-01' },
      ],
    };

    reconcileMarket(snap, ['KRX'], 'KRX', TODAY, 'KIS 동기화', makeDeps(trades));

    const tx = getTransactions(id);
    expect(tx).toHaveLength(2);
    // 신규 한 건만 추가됨 — 실제 체결가 650,000 (avgPrice 670,000 아님)
    const newTx = tx.find(t => t.memo.includes('ORD-NEW'));
    expect(newTx).toBeDefined();
    expect(newTx!.price).toBe(650_000);
  });
});
