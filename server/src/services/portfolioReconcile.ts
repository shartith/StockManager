/**
 * Bidirectional reconciliation between KIS account holdings and StockManager DB.
 *
 * Pure function with all DB I/O injected via the `deps` parameter so the
 * core decision logic (added / adjusted / removed / unchanged) can be unit
 * tested in isolation without a real database.
 *
 * v5.6.3: 잔고 차이를 메울 때 KIS 거래내역(inquire-daily-ccld) 의 실제 체결가
 * 를 우선 사용한다. 거래내역을 얻지 못한 경우만 KIS 가중평단(avg_price) 폴백.
 * 주문번호(odno)를 memo 에 기록해 중복 입력을 방지한다.
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
  market: 'KRX';
  quantity: number;
  avgPrice: number;
}

export interface SmHoldingRow {
  stock_id: number;
  ticker: string;
  market: string;
  current_qty: number;
}

/** KIS 거래내역 1건 (inquire-daily-ccld output1 의 정규화 형태). */
export interface KisTrade {
  ticker: string;
  /** KIS 주문번호 — DB 의 memo 에 기록되어 dedup 키로 쓰임. */
  odno: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  /** 실제 체결가 (체결단가 또는 평균체결단가). */
  price: number;
  /** YYYY-MM-DD. */
  date: string;
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
  /**
   * KIS 거래내역 조회 (optional). 제공되면 reconcile 이 잔고 차이를 메울 때
   * 우선 실제 체결가를 쓴다. 미제공 또는 빈 배열 시 avg_price 폴백.
   */
  fetchKisTrades?(ticker: string): KisTrade[];
  /**
   * 특정 stockId + odno 의 거래가 이미 DB 에 있는지 (optional).
   * 미제공 시 memo 안에 odno 가 있는지로 dedup (운영 DB 기본 동작).
   */
  hasTradeOdno?(stockId: number, odno: string): boolean;
}

/**
 * 거래내역의 trades 중 DB 에 없는 것만 추려 실제 체결가로 입력한다.
 * 입력된 BUY/SELL 의 순수 수량(BUY - SELL)을 반환 — 호출자가 남은 gap 을 판단하는 데 쓴다.
 */
function applyMissingTrades(
  stockId: number,
  trades: KisTrade[],
  type: 'BUY' | 'SELL',
  memoSource: string,
  memoTag: string,
  deps: ReconcileDeps,
): number {
  let netInserted = 0;
  for (const t of trades) {
    if (t.type !== type) continue;
    if (deps.hasTradeOdno && deps.hasTradeOdno(stockId, t.odno)) continue;
    const memo = `${memoSource} ${memoTag} odno=${t.odno}`;
    if (t.type === 'BUY') {
      deps.insertBuy(stockId, t.quantity, t.price, t.date, memo);
    } else {
      deps.insertSell(stockId, t.quantity, t.price, t.date, memo);
    }
    netInserted += t.quantity;
  }
  return netInserted;
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

    // 거래내역 우선 적용 — DB 와 KIS 어느 한쪽이라도 gap 이 있으면 실제 체결 기록을
    // 먼저 채워 정확한 단가를 확보한다. 거래내역으로 모두 메워지면 추가 작업 없음.
    // 이미 DB 에 있는 odno 는 hasTradeOdno 로 걸러져 중복 입력되지 않는다.
    const trades = deps.fetchKisTrades ? deps.fetchKisTrades(snap.ticker) : [];
    let tradeNetInserted = 0;
    if (trades.length > 0) {
      tradeNetInserted += applyMissingTrades(stockId, trades, 'BUY', memoSource, '(체결)', deps);
      tradeNetInserted -= applyMissingTrades(stockId, trades, 'SELL', memoSource, '(체결)', deps);
    }

    const newCurrentQty = currentQty + tradeNetInserted;
    const remainingDelta = snap.quantity - newCurrentQty;

    if (delta === 0 && trades.length === 0) {
      result.unchanged.push(snap.ticker);
      continue;
    }

    // 거래내역만으로 잔고가 맞춰진 경우
    if (remainingDelta === 0) {
      if (delta === 0) result.unchanged.push(snap.ticker);
      else if (currentQty === 0) result.added.push(snap.ticker);
      else result.adjusted.push({ ticker: snap.ticker, from: currentQty, to: snap.quantity, delta });
      continue;
    }

    // 거래내역 폴백: 잔고 gap 이 남았다 — avg_price 로 메움 (구버전 호환 동작).
    if (remainingDelta > 0) {
      const memoTag = currentQty === 0 && tradeNetInserted === 0 ? '(신규)' : '(추가매수 동기화)';
      deps.insertBuy(stockId, remainingDelta, snap.avgPrice, today, `${memoSource} ${memoTag}`);
      if (currentQty === 0) result.added.push(snap.ticker);
      else result.adjusted.push({ ticker: snap.ticker, from: currentQty, to: snap.quantity, delta });
    } else {
      deps.insertSell(stockId, Math.abs(remainingDelta), snap.avgPrice, today, `${memoSource} (부분매도 동기화)`);
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
