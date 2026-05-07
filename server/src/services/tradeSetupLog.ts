/**
 * Trade Setup 사후 분석 로그.
 *
 * - recordSetupOnBuy: 매수 직후 features 저장
 * - recordResultOnSell: 매도 직후 result_rule + pnl 업데이트
 * - getSectorWinRate / getPatternWinRate: 누적 통계 (EOD report 등에서 사용)
 */

import { execute, queryAll, queryOne } from '../db';
import logger from '../logger';

export interface SetupFeatures {
  stockId: number;
  ticker: string;
  sector: string | null;
  boughtPrice: number;
  bullishPattern: string | null;
  rsi: number | null;
  volRatio: number | null;
  confidenceMultiplier: number;
  gainFromOpen: number;
  strategicCategory: string | null;
  reason: string;
}

export function recordSetupOnBuy(f: SetupFeatures): void {
  try {
    execute(
      `INSERT INTO trade_setups
        (stock_id, ticker, sector, bought_price, bullish_pattern, rsi, vol_ratio,
         confidence_multiplier, gain_from_open, strategic_category, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.stockId, f.ticker, f.sector ?? null, f.boughtPrice,
        f.bullishPattern ?? null, f.rsi ?? null, f.volRatio ?? null,
        f.confidenceMultiplier, f.gainFromOpen, f.strategicCategory ?? null, f.reason,
      ],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, ticker: f.ticker }, 'recordSetupOnBuy 실패 (룰 영향 없음)');
  }
}

export function recordResultOnSell(args: {
  stockId: number;
  rule: string;
  soldPrice: number;
}): void {
  try {
    // 동일 stock_id 의 가장 최근 sold_at IS NULL row 갱신
    const row = queryOne<{ id: number; bought_price: number }>(
      `SELECT id, bought_price FROM trade_setups
       WHERE stock_id = ? AND sold_at IS NULL
       ORDER BY bought_at DESC LIMIT 1`,
      [args.stockId],
    );
    if (!row) return;
    const pnlPct = ((args.soldPrice - row.bought_price) / row.bought_price) * 100;
    execute(
      `UPDATE trade_setups
         SET sold_at = datetime('now'),
             sold_price = ?,
             result_rule = ?,
             result_pnl_percent = ?
       WHERE id = ?`,
      [args.soldPrice, args.rule, pnlPct, row.id],
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, stockId: args.stockId }, 'recordResultOnSell 실패');
  }
}

export interface WinRateStat {
  group: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnL: number;
}

export function getSectorWinRate(days: number = 30): WinRateStat[] {
  const rows = queryAll<{
    sector: string; trades: number; wins: number; losses: number; avg_pnl: number;
  }>(
    `SELECT
       COALESCE(sector, '(unknown)') as sector,
       COUNT(*) as trades,
       SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN result_pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
       AVG(result_pnl_percent) as avg_pnl
     FROM trade_setups
     WHERE sold_at IS NOT NULL
       AND bought_at >= datetime('now', '-' || ? || ' days')
     GROUP BY sector
     ORDER BY trades DESC`,
    [days],
  );
  return rows.map(r => ({
    group: r.sector,
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
    avgPnL: r.avg_pnl ?? 0,
  }));
}

export function getPatternWinRate(days: number = 30): WinRateStat[] {
  const rows = queryAll<{
    pat: string; trades: number; wins: number; losses: number; avg_pnl: number;
  }>(
    `SELECT
       COALESCE(bullish_pattern, '(no-pattern)') as pat,
       COUNT(*) as trades,
       SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
       SUM(CASE WHEN result_pnl_percent <= 0 THEN 1 ELSE 0 END) as losses,
       AVG(result_pnl_percent) as avg_pnl
     FROM trade_setups
     WHERE sold_at IS NOT NULL
       AND bought_at >= datetime('now', '-' || ? || ' days')
     GROUP BY pat
     ORDER BY trades DESC`,
    [days],
  );
  return rows.map(r => ({
    group: r.pat,
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate: r.trades > 0 ? r.wins / r.trades : 0,
    avgPnL: r.avg_pnl ?? 0,
  }));
}
