/**
 * Bidirectional reconciliation between KIS account holdings and StockManager DB.
 *
 * Pure function with all DB I/O injected via the `deps` parameter so the
 * core decision logic (added / adjusted / removed / unchanged) can be unit
 * tested in isolation without a real database.
 *
 * Behaviour matrix:
 *   KIS qty | SM qty   | Action
 *   --------|----------|-------------------------------------
 *     N > 0 | 0        | BUY N shares (added)
 *     N     | M (N>M)  | BUY (N-M) shares (adjusted)
 *     N     | M (N<M)  | SELL (M-N) shares (adjusted)
 *     N     | N        | nothing (unchanged)
 *     0     | M > 0    | SELL M shares (removed)
 */

export interface KisHoldingSnapshot {
  ticker: string;
  name: string;
  market: 'KRX' | 'NASDAQ' | 'NYSE' | 'AMEX';
  quantity: number;
  avgPrice: number;
}

export interface SmHoldingRow {
  stock_id: number;
  ticker: string;
  market: string;
  current_qty: number;
}

export interface SyncResult {
  added: string[];
  adjusted: { ticker: string; from: number; to: number; delta: number }[];
  removed: { ticker: string; quantity: number }[];
  unchanged: string[];
}

/**
 * Dependency-injected I/O surface so reconcile can run against a mock store
 * in tests and against the real DB in production.
 */
export interface ReconcileDeps {
  /** List currently-held SM rows for the given markets (qty > 0). */
  getCurrentSmHoldings(markets: readonly string[]): SmHoldingRow[];
  /** Look up an existing stock by ticker; return its id or null. */
  findStockId(ticker: string): number | null;
  /** Insert a new stock row, return its new id. */
  insertStock(ticker: string, name: string, market: string): number;
  /** Insert a BUY transaction. */
  insertBuy(stockId: number, quantity: number, price: number, date: string, memo: string): void;
  /** Insert a SELL transaction. */
  insertSell(stockId: number, quantity: number, price: number, date: string, memo: string): void;
  /** Find the price of the most recent BUY for a stock (used as fallback for forced SELLs). */
  getLastBuyPrice(stockId: number): number;
}

/**
 * Reconcile a market's KIS snapshot against current SM holdings.
 * Mutating side effects (insertStock / insertBuy / insertSell) go through
 * `deps`. Returns a structured summary the caller can echo to the client.
 */
export function reconcileMarket(
  snapshots: KisHoldingSnapshot[],
  markets: readonly string[],
  defaultMarket: string,
  today: string,
  memoSource: string,
  deps: ReconcileDeps,
): SyncResult {
  const result: SyncResult = { added: [], adjusted: [], removed: [], unchanged: [] };
  const kisMap = new Map<string, KisHoldingSnapshot>();
  for (const s of snapshots) kisMap.set(s.ticker, s);

  const smHoldings = deps.getCurrentSmHoldings(markets);

  // 1. KIS holdings → new / adjusted / unchanged
  for (const snap of snapshots) {
    let stockId = deps.findStockId(snap.ticker);
    if (stockId === null) {
      stockId = deps.insertStock(snap.ticker, snap.name, snap.market || defaultMarket);
    }

    const smHolding = smHoldings.find(h => h.ticker === snap.ticker);
    const currentQty = smHolding?.current_qty ?? 0;
    const delta = snap.quantity - currentQty;

    if (delta === 0) {
      result.unchanged.push(snap.ticker);
      continue;
    }

    if (currentQty === 0) {
      deps.insertBuy(stockId, snap.quantity, snap.avgPrice, today, `${memoSource} (신규)`);
      result.added.push(snap.ticker);
    } else if (delta > 0) {
      deps.insertBuy(stockId, delta, snap.avgPrice, today, `${memoSource} (추가매수 동기화)`);
      result.adjusted.push({ ticker: snap.ticker, from: currentQty, to: snap.quantity, delta });
    } else {
      deps.insertSell(stockId, Math.abs(delta), snap.avgPrice, today, `${memoSource} (부분매도 동기화)`);
      result.adjusted.push({ ticker: snap.ticker, from: currentQty, to: snap.quantity, delta });
    }
  }

  // 2. SM holdings missing from KIS → forced full SELL
  for (const sm of smHoldings) {
    if (kisMap.has(sm.ticker)) continue;
    if (sm.current_qty <= 0) continue;

    const sellPrice = deps.getLastBuyPrice(sm.stock_id);
    deps.insertSell(sm.stock_id, sm.current_qty, sellPrice, today, `${memoSource} (전량매도 동기화)`);
    result.removed.push({ ticker: sm.ticker, quantity: sm.current_qty });
  }

  return result;
}
