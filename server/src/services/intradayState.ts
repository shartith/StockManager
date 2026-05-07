/**
 * Intraday State — DB 영구화 in-memory state (v5.1.0).
 *
 * v5.0의 dailyStrategy는 peakPrice/openingPrice/todayBought를 process 메모리에 보관 →
 * 서버 재시작 시 모두 유실되어 트레일링 등이 reset됨. 이 모듈은 이 상태를
 * intraday_state 테이블에 영구화하고, trade_date 컬럼으로 자동 day-rollover.
 */

import { queryOne, execute } from '../db';
import logger from '../logger';

export interface IntradayRow {
  stockId: number;
  openingPrice: number | null;
  peakPrice: number | null;
  boughtToday: boolean;
  trailingActive: boolean;
  lastSellAt: string | null;
  tradeDate: string | null;
  // v5.4.0 Entry/Exit Plan 추적
  t1Target: number | null;
  t2Target: number | null;
  dynamicSL: number | null;
  t1Filled: boolean;
  slMovedToBE: boolean;
  entryAvgPrice: number | null;
}

interface RawRow {
  stock_id: number;
  opening_price: number | null;
  peak_price: number | null;
  bought_today: number;
  trailing_active: number;
  last_sell_at: string | null;
  trade_date: string | null;
  t1_target: number | null;
  t2_target: number | null;
  dynamic_sl: number | null;
  t1_filled: number | null;
  sl_moved_to_be: number | null;
  entry_avg_price: number | null;
}

function toState(r: RawRow): IntradayRow {
  return {
    stockId: r.stock_id,
    openingPrice: r.opening_price,
    peakPrice: r.peak_price,
    boughtToday: r.bought_today === 1,
    trailingActive: r.trailing_active === 1,
    lastSellAt: r.last_sell_at,
    tradeDate: r.trade_date,
    t1Target: r.t1_target,
    t2Target: r.t2_target,
    dynamicSL: r.dynamic_sl,
    t1Filled: r.t1_filled === 1,
    slMovedToBE: r.sl_moved_to_be === 1,
    entryAvgPrice: r.entry_avg_price,
  };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 오늘 날짜와 다른 경우 자동 만료 처리 후 row 반환. */
export function getState(stockId: number): IntradayRow | null {
  const row = queryOne<RawRow>(
    `SELECT * FROM intraday_state WHERE stock_id = ?`,
    [stockId],
  );
  if (!row) return null;
  // trade_date가 다르면 day-rollover: peak/opening/boughtToday/trailing 모두 reset.
  // last_sell_at은 유지 (날짜 무관 cooldown).
  if (row.trade_date !== todayStr()) {
    execute(
      `UPDATE intraday_state
         SET opening_price = NULL,
             peak_price = NULL,
             bought_today = 0,
             trailing_active = 0,
             t1_target = NULL,
             t2_target = NULL,
             dynamic_sl = NULL,
             t1_filled = 0,
             sl_moved_to_be = 0,
             entry_avg_price = NULL,
             trade_date = ?,
             updated_at = datetime('now')
       WHERE stock_id = ?`,
      [todayStr(), stockId],
    );
    return {
      stockId,
      openingPrice: null,
      peakPrice: null,
      boughtToday: false,
      trailingActive: false,
      lastSellAt: row.last_sell_at,
      tradeDate: todayStr(),
      t1Target: null,
      t2Target: null,
      dynamicSL: null,
      t1Filled: false,
      slMovedToBE: false,
      entryAvgPrice: null,
    };
  }
  return toState(row);
}

function upsertRow(stockId: number, patch: Partial<{
  opening_price: number | null;
  peak_price: number | null;
  bought_today: number;
  trailing_active: number;
  last_sell_at: string | null;
  t1_target: number | null;
  t2_target: number | null;
  dynamic_sl: number | null;
  t1_filled: number;
  sl_moved_to_be: number;
  entry_avg_price: number | null;
}>): void {
  // Ensure row exists
  execute(
    `INSERT OR IGNORE INTO intraday_state (stock_id, trade_date) VALUES (?, ?)`,
    [stockId, todayStr()],
  );
  const fields: string[] = [`trade_date = ?`, `updated_at = datetime('now')`];
  const params: unknown[] = [todayStr()];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    params.push(v);
  }
  params.push(stockId);
  execute(
    `UPDATE intraday_state SET ${fields.join(', ')} WHERE stock_id = ?`,
    params,
  );
}

/** 시초가(09:00 open) baseline을 기록. 이미 있으면 무시. */
export function setOpeningPriceIfMissing(stockId: number, price: number): void {
  const cur = getState(stockId);
  if (cur && cur.openingPrice !== null && cur.openingPrice > 0) return;
  upsertRow(stockId, { opening_price: price });
}

/** 매수 시점에 호출 — peak 초기화 + boughtToday=1. */
export function markBought(stockId: number, price: number): void {
  upsertRow(stockId, {
    peak_price: price,
    bought_today: 1,
    trailing_active: 0,
  });
}

/** peak 갱신. 현재가가 기존보다 높으면 update. trailing_active 활성 여부도 반영. */
export function updatePeak(stockId: number, currentPrice: number, activateTrailing: boolean): number {
  const cur = getState(stockId);
  const existingPeak = cur?.peakPrice ?? currentPrice;
  const peak = Math.max(existingPeak, currentPrice);
  const patch: any = { peak_price: peak };
  // sticky: 이미 활성됐으면 그대로, 처음 활성 시점만 1로 변경.
  if (activateTrailing && !cur?.trailingActive) {
    patch.trailing_active = 1;
  }
  upsertRow(stockId, patch);
  return peak;
}

/** 매도 시점 — peak/trailing 정리 + last_sell_at 기록. boughtToday는 유지(EOD reconcile용). */
export function markSold(stockId: number): void {
  upsertRow(stockId, {
    peak_price: null,
    trailing_active: 0,
    last_sell_at: new Date().toISOString(),
  });
}

/** 재진입 cooldown 체크 — 매도 후 minutes 경과 안 됐으면 true. */
export function isInCooldown(stockId: number, minutes: number): boolean {
  const cur = getState(stockId);
  if (!cur || !cur.lastSellAt) return false;
  const lastSellTs = new Date(cur.lastSellAt).getTime();
  const elapsedMin = (Date.now() - lastSellTs) / 60_000;
  return elapsedMin < minutes;
}

/** boughtToday만 따로 조회 (EOD force close에서 사용). */
export function isBoughtToday(stockId: number): boolean {
  const cur = getState(stockId);
  return !!cur?.boughtToday;
}

/**
 * Entry/Exit Plan 저장 — 매수 직후 호출. T1/T2/dynamicSL 동시 기록.
 * entryAvgPrice 는 평단 기준 (매수 후 lot tracking 으로 계산된 값).
 */
export function setEntryExitPlan(stockId: number, args: {
  t1Target: number;
  t2Target: number;
  dynamicSL: number;
  entryAvgPrice: number;
}): void {
  upsertRow(stockId, {
    t1_target: args.t1Target,
    t2_target: args.t2Target,
    dynamic_sl: args.dynamicSL,
    entry_avg_price: args.entryAvgPrice,
    t1_filled: 0,
    sl_moved_to_be: 0,
  });
}

/** T1 부분 익절 체결 — 이후 잔여 매도/트레일에서 t1Filled=true 상태로 분기. */
export function markT1Filled(stockId: number): void {
  upsertRow(stockId, { t1_filled: 1 });
}

/** SL 을 매수가(BE) 로 이동 — 무손실 보호 잠금. */
export function moveSLToBE(stockId: number): void {
  const cur = getState(stockId);
  if (!cur || !cur.entryAvgPrice) return;
  upsertRow(stockId, {
    dynamic_sl: cur.entryAvgPrice,
    sl_moved_to_be: 1,
  });
}

/** 자동매매 시작 시점에 호출 — 보유 종목들의 boughtToday 상태를 transactions와 동기화. */
export function syncTodayFromTransactions(): void {
  const today = todayStr();
  // 오늘 매수 거래가 있는 stock_id 모두 boughtToday=1로
  const rows = execute(
    `INSERT OR REPLACE INTO intraday_state (stock_id, bought_today, trade_date, updated_at)
     SELECT DISTINCT t.stock_id, 1, ?, datetime('now')
     FROM transactions t
     WHERE t.type = 'BUY'
       AND date(t.date) = date(?)
       AND t.deleted_at IS NULL`,
    [today, today],
  );
  if (rows.changes > 0) {
    logger.debug({ rows: rows.changes }, 'intraday_state synced from transactions');
  }
}
