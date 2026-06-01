/**
 * Regression: 가져오기(KIS 잔고 동기화) 멱등성 — market 값 불일치로 인한 phantom BUY 방지.
 *
 * 버그(v5.4~v5.6): top10Strategy 가 종목을 market='KOSPI'/'KOSDAQ' 로 저장하는데
 * balanceSync.getCurrentSmHoldings 는 market IN ('KRX') 로만 보유분을 조회 →
 * KOSPI/KOSDAQ/'' 종목이 보유 0 으로 오인되어 가져오기/EOD reconcile 마다
 * 신규 BUY 가 누적(안 산 종목이 매수로 표시)되던 문제.
 *
 * 순수 로직(portfolioReconcile)은 deps mock 으로만 테스트돼 실제 SQL 의 market 필터가
 * 한 번도 검증되지 않았다. 이 테스트는 실제 dbReconcileDeps + in-memory DB 로 그 공백을 메운다.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// 운영 DB 파일과 격리: import 전에 in-memory 로 강제.
process.env.STOCK_MANAGER_DB_PATH = ':memory:';

import { initializeDB, execute, queryOne } from '../db';
import { dbReconcileDeps } from '../services/balanceSync';
import { reconcileMarket, type KisHoldingSnapshot } from '../services/portfolioReconcile';

const TODAY = '2026-06-01';

function seedStock(ticker: string, name: string, market: string): number {
  execute('INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)', [ticker, name, market, '']);
  const row = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  return row!.id;
}

function seedBuy(stockId: number, qty: number, price: number): void {
  execute(
    'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [stockId, 'BUY', qty, price, 0, TODAY, 'seed'],
  );
}

function buyCount(stockId: number): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) as n FROM transactions WHERE stock_id = ? AND type = 'BUY' AND deleted_at IS NULL",
    [stockId],
  )!.n;
}

function netQty(stockId: number): number {
  return queryOne<{ q: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type='BUY' THEN quantity ELSE -quantity END), 0) as q
     FROM transactions WHERE stock_id = ? AND deleted_at IS NULL`,
    [stockId],
  )!.q;
}

/** balanceSync 가 호출하는 형태 그대로 reconcile 1회 실행. */
function runImport(snapshots: KisHoldingSnapshot[]) {
  return reconcileMarket(snapshots, ['KRX'], 'KRX', TODAY, 'KIS 동기화', dbReconcileDeps);
}

describe('balanceSync reconcile — 가져오기 멱등성 (market 불일치 회귀)', () => {
  beforeAll(async () => {
    await initializeDB();
  });

  beforeEach(() => {
    execute('DELETE FROM transactions');
    execute('DELETE FROM stocks');
  });

  it.each(['KOSPI', 'KOSDAQ', ''])(
    "market=%s 보유 종목을 두 번 가져와도 BUY 가 중복되지 않는다",
    (market) => {
      const id = seedStock('005930', '삼성전자', market);
      seedBuy(id, 10, 70000); // 이미 10주 보유 (실제 포지션)

      const snap: KisHoldingSnapshot[] = [
        { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 10, avgPrice: 70000 },
      ];

      const first = runImport(snap);
      expect(first.added).toEqual([]); // 신규 BUY 가 박히면 안 됨
      expect(first.unchanged).toContain('005930');
      expect(buyCount(id)).toBe(1);
      expect(netQty(id)).toBe(10);

      const second = runImport(snap); // 두 번째 가져오기
      expect(second.added).toEqual([]);
      expect(second.unchanged).toContain('005930');
      expect(buyCount(id)).toBe(1); // 여전히 1건 — phantom BUY 없음
      expect(netQty(id)).toBe(10);
    },
  );

  it('실제 신규 종목은 처음 한 번만 BUY 로 등록되고 재가져오기 시 unchanged', () => {
    const snap: KisHoldingSnapshot[] = [
      { ticker: '000660', name: 'SK하이닉스', market: 'KRX', quantity: 5, avgPrice: 180000 },
    ];

    const first = runImport(snap);
    expect(first.added).toContain('000660');

    const id = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', ['000660'])!.id;
    expect(buyCount(id)).toBe(1);
    expect(netQty(id)).toBe(5);

    const second = runImport(snap);
    expect(second.added).toEqual([]);
    expect(second.unchanged).toContain('000660');
    expect(buyCount(id)).toBe(1);
    expect(netQty(id)).toBe(5);
  });

  it('KOSPI 종목 실제 추가매수(10→15)는 delta 5 만 조정으로 반영', () => {
    const id = seedStock('005930', '삼성전자', 'KOSPI');
    seedBuy(id, 10, 70000);

    const result = runImport([
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 15, avgPrice: 72000 },
    ]);

    expect(result.added).toEqual([]);
    expect(result.adjusted).toHaveLength(1);
    expect(result.adjusted[0]).toMatchObject({ ticker: '005930', from: 10, to: 15, delta: 5 });
    expect(netQty(id)).toBe(15); // 10 + 5, 중복 아님
  });
});
