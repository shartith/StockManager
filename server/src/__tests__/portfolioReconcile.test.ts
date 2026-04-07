/**
 * v4.5.1: KIS bidirectional reconcile logic
 *
 * Verifies the pure decision logic of reconcileMarket() against an
 * in-memory mock of the SM holdings store. Covers all five branches:
 * added / adjusted-up / adjusted-down / unchanged / removed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  reconcileMarket,
  type KisHoldingSnapshot,
  type SmHoldingRow,
  type ReconcileDeps,
} from '../services/portfolioReconcile';

interface InsertedTx {
  stockId: number;
  type: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  date: string;
  memo: string;
}

function makeMockDeps(initialHoldings: SmHoldingRow[]): ReconcileDeps & {
  inserted: InsertedTx[];
  newStocks: { ticker: string; name: string; market: string; id: number }[];
} {
  const holdings = [...initialHoldings];
  const inserted: InsertedTx[] = [];
  const newStocks: { ticker: string; name: string; market: string; id: number }[] = [];
  let nextId = 1000;

  return {
    inserted,
    newStocks,
    getCurrentSmHoldings(_markets) {
      return [...holdings];
    },
    findStockId(ticker) {
      const existing = holdings.find(h => h.ticker === ticker);
      if (existing) return existing.stock_id;
      const created = newStocks.find(s => s.ticker === ticker);
      return created?.id ?? null;
    },
    insertStock(ticker, name, market) {
      const id = nextId++;
      newStocks.push({ ticker, name, market, id });
      return id;
    },
    insertBuy(stockId, quantity, price, date, memo) {
      inserted.push({ stockId, type: 'BUY', quantity, price, date, memo });
    },
    insertSell(stockId, quantity, price, date, memo) {
      inserted.push({ stockId, type: 'SELL', quantity, price, date, memo });
    },
    getLastBuyPrice(stockId) {
      // Return last recorded buy from inserted, or 100 as fallback
      const buys = inserted.filter(t => t.stockId === stockId && t.type === 'BUY');
      return buys.length > 0 ? buys[buys.length - 1].price : 100;
    },
  };
}

const TODAY = '2026-04-07';
const KRX_MARKETS = ['KRX'] as const;

describe('reconcileMarket — added (new holdings)', () => {
  it('inserts new stock and BUY transaction when KIS has it but SM does not', () => {
    const deps = makeMockDeps([]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 10, avgPrice: 70000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.added).toEqual(['005930']);
    expect(result.adjusted).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);

    expect(deps.newStocks).toHaveLength(1);
    expect(deps.newStocks[0].ticker).toBe('005930');

    expect(deps.inserted).toHaveLength(1);
    expect(deps.inserted[0]).toMatchObject({
      type: 'BUY',
      quantity: 10,
      price: 70000,
      date: TODAY,
    });
    expect(deps.inserted[0].memo).toContain('신규');
  });

  it('handles multiple new tickers in one reconcile', () => {
    const deps = makeMockDeps([]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 10, avgPrice: 70000 },
      { ticker: '000660', name: 'SK하이닉스', market: 'KRX', quantity: 5, avgPrice: 130000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.added.sort()).toEqual(['000660', '005930']);
    expect(deps.inserted.filter(t => t.type === 'BUY')).toHaveLength(2);
  });
});

describe('reconcileMarket — adjusted (qty diff)', () => {
  it('emits BUY for partial qty increase (adjusted up)', () => {
    const deps = makeMockDeps([
      { stock_id: 100, ticker: '005930', market: 'KRX', current_qty: 10 },
    ]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 15, avgPrice: 71000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.added).toEqual([]);
    expect(result.adjusted).toEqual([
      { ticker: '005930', from: 10, to: 15, delta: 5 },
    ]);
    expect(result.removed).toEqual([]);

    expect(deps.inserted).toEqual([
      expect.objectContaining({
        stockId: 100,
        type: 'BUY',
        quantity: 5,
        price: 71000,
        memo: expect.stringContaining('추가매수'),
      }),
    ]);
  });

  it('emits SELL for partial qty decrease (adjusted down)', () => {
    const deps = makeMockDeps([
      { stock_id: 100, ticker: '005930', market: 'KRX', current_qty: 20 },
    ]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 8, avgPrice: 72000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.adjusted).toEqual([
      { ticker: '005930', from: 20, to: 8, delta: -12 },
    ]);
    expect(deps.inserted).toEqual([
      expect.objectContaining({
        stockId: 100,
        type: 'SELL',
        quantity: 12,
        memo: expect.stringContaining('부분매도'),
      }),
    ]);
  });
});

describe('reconcileMarket — unchanged', () => {
  it('produces no transactions when qty matches exactly', () => {
    const deps = makeMockDeps([
      { stock_id: 100, ticker: '005930', market: 'KRX', current_qty: 10 },
    ]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 10, avgPrice: 70000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.unchanged).toEqual(['005930']);
    expect(result.added).toEqual([]);
    expect(result.adjusted).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(deps.inserted).toEqual([]);
  });
});

describe('reconcileMarket — removed (full sell)', () => {
  it('emits full SELL when SM has stock but KIS does not', () => {
    const deps = makeMockDeps([
      { stock_id: 100, ticker: '008350', market: 'KRX', current_qty: 91 },
    ]);
    const snapshots: KisHoldingSnapshot[] = []; // KIS empty

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.removed).toEqual([
      { ticker: '008350', quantity: 91 },
    ]);
    expect(result.added).toEqual([]);
    expect(result.adjusted).toEqual([]);

    expect(deps.inserted).toEqual([
      expect.objectContaining({
        stockId: 100,
        type: 'SELL',
        quantity: 91,
        price: 100, // mock fallback last buy price
        memo: expect.stringContaining('전량매도'),
      }),
    ]);
  });

  it('removes only the missing tickers (not all)', () => {
    const deps = makeMockDeps([
      { stock_id: 100, ticker: '005930', market: 'KRX', current_qty: 10 },
      { stock_id: 101, ticker: '008350', market: 'KRX', current_qty: 91 }, // missing
      { stock_id: 102, ticker: '251340', market: 'KRX', current_qty: 147 }, // missing
    ]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '005930', name: '삼성전자', market: 'KRX', quantity: 10, avgPrice: 70000 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'sync', deps);

    expect(result.unchanged).toEqual(['005930']);
    expect(result.removed.map(r => r.ticker).sort()).toEqual(['008350', '251340']);
    expect(deps.inserted.filter(t => t.type === 'SELL')).toHaveLength(2);
  });
});

describe('reconcileMarket — combined real-world scenario', () => {
  it('handles the v4.5.1 user portfolio mismatch in one call', () => {
    // Real scenario from stock-data analysis:
    // SM had: 애드바이오텍 101주 (over by 51), 남선알미늄 91주 (extra),
    //         KODEX 인버스 147주 (extra), 1Q미국우주항공 29주, 유니슨 1주
    // KIS had: 애드바이오텍 50주, 1Q미국우주항공 29주, 유니슨 1주
    const deps = makeMockDeps([
      { stock_id: 90, ticker: '179530', market: 'KRX', current_qty: 101 },  // 애드바이오텍
      { stock_id: 36, ticker: '008350', market: 'KRX', current_qty: 91 },   // 남선알미늄
      { stock_id: 45, ticker: '251340', market: 'KRX', current_qty: 147 },  // KODEX 인버스
      { stock_id: 1,  ticker: '0131V0', market: 'KRX', current_qty: 29 },   // 1Q미국우주항공
      { stock_id: 5,  ticker: '018000', market: 'KRX', current_qty: 1 },    // 유니슨
    ]);
    const snapshots: KisHoldingSnapshot[] = [
      { ticker: '179530', name: '애드바이오텍', market: 'KRX', quantity: 50, avgPrice: 2929 },
      { ticker: '0131V0', name: '1Q미국우주항공', market: 'KRX', quantity: 29, avgPrice: 12564 },
      { ticker: '018000', name: '유니슨', market: 'KRX', quantity: 1, avgPrice: 1535 },
    ];

    const result = reconcileMarket(snapshots, KRX_MARKETS, 'KRX', TODAY, 'KIS 동기화', deps);

    // 애드바이오텍: 51주 매도 동기화
    expect(result.adjusted).toEqual([
      { ticker: '179530', from: 101, to: 50, delta: -51 },
    ]);
    // 1Q + 유니슨: 변경 없음
    expect(result.unchanged.sort()).toEqual(['0131V0', '018000']);
    // 남선알미늄 + KODEX: 전량 매도
    expect(result.removed.map(r => r.ticker).sort()).toEqual(['008350', '251340']);
    expect(result.added).toEqual([]);

    // 총 3건의 SELL 거래 생성 (51 + 91 + 147)
    const sells = deps.inserted.filter(t => t.type === 'SELL');
    expect(sells).toHaveLength(3);
    expect(sells.find(s => s.quantity === 51)?.memo).toContain('부분매도');
    expect(sells.find(s => s.quantity === 91)?.memo).toContain('전량매도');
    expect(sells.find(s => s.quantity === 147)?.memo).toContain('전량매도');
  });
});
