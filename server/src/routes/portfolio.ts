import { Router, Request, Response } from 'express';
import { getPortfolioSummary, getPortfolioRiskContext } from '../services/calculator';
import { getMultipleStockPrices } from '../services/stockPrice';
import { queryAll } from '../db';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  try {
    // Fix #1: Only fetch prices for currently HELD stocks (qty > 0).
    // Previously this queried ALL rows in the stocks table — including
    // recommendations, watchlist, and historical entries — causing the
    // KIS API to be called 100+ times per page load.
    const heldStocks = queryAll(`
      SELECT s.ticker, s.market
      FROM stocks s
      WHERE s.id IN (
        SELECT stock_id FROM transactions
        GROUP BY stock_id
        HAVING SUM(CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END) > 0
      )
    `);
    const tickers = heldStocks.map((s: any) => s.ticker);
    const tickerMarkets = new Map<string, string>();
    heldStocks.forEach((s: any) => tickerMarkets.set(s.ticker, s.market || ''));
    let prices: Map<string, number> | undefined;

    if (tickers.length > 0) {
      try {
        prices = await getMultipleStockPrices(tickers, tickerMarkets);
      } catch {
        // 시세 조회 실패 시 시세 없이 반환
      }
    }

    const summary = await getPortfolioSummary(prices);

    // Fix #3: Single JOIN query instead of N separate queries for latest signals.
    if (summary.holdings.length > 0) {
      const stockIds = summary.holdings.map(h => h.stockId);
      const placeholders = stockIds.map(() => '?').join(',');
      const signalRows = queryAll(
        `SELECT s.stock_id, s.signal_type, s.confidence, s.created_at
         FROM trade_signals s
         INNER JOIN (
           SELECT stock_id, MAX(created_at) AS max_at
           FROM trade_signals
           WHERE stock_id IN (${placeholders})
           GROUP BY stock_id
         ) latest ON s.stock_id = latest.stock_id AND s.created_at = latest.max_at`,
        stockIds,
      );
      const signalByStock = new Map<number, { signal_type: string; confidence: number; created_at: string }>();
      for (const row of signalRows) {
        signalByStock.set(row.stock_id, row);
      }
      for (const h of summary.holdings) {
        const sig = signalByStock.get(h.stockId);
        (h as any).latestSignal = sig?.signal_type ?? null;
        (h as any).latestConfidence = sig?.confidence ?? null;
        (h as any).latestSignalAt = sig?.created_at ?? null;
      }
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: '포트폴리오 조회 실패' });
  }
}));

router.get('/insight', (_req: Request, res: Response) => {
  try {
    const context = getPortfolioRiskContext();
    res.json(context);
  } catch {
    res.json({ totalInvested: 0, holdingCount: 0, currentProfitLossPercent: 0, sectorConcentration: [], highCorrelationPairs: [], optimalWeights: [] });
  }
});

router.get('/history', (_req: Request, res: Response) => {
  const history = queryAll(`
    SELECT
      t.date,
      SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END) as buy_total,
      SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END) as sell_total,
      SUM(t.fee) as fees
    FROM transactions t
    GROUP BY t.date
    ORDER BY t.date ASC
  `);
  res.json(history);
});

export default router;
