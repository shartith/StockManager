import { Router, Request, Response } from 'express';
import { getPortfolioSummary } from '../services/calculator';
import { getMultipleStockPrices } from '../services/stockPrice';
import { queryAll } from '../db';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

router.get('/summary', asyncHandler(async (_req: Request, res: Response) => {
  try {
    const heldStocks = queryAll<{ ticker: string; market: string }>(`
      SELECT s.ticker, s.market
      FROM stocks s
      WHERE s.deleted_at IS NULL
        AND s.id IN (
          SELECT stock_id FROM transactions
          WHERE deleted_at IS NULL
          GROUP BY stock_id
          HAVING SUM(CASE WHEN type = 'BUY' THEN quantity ELSE -quantity END) > 0
        )
    `);
    const tickers = heldStocks.map(s => s.ticker);
    const tickerMarkets = new Map<string, string>();
    heldStocks.forEach(s => tickerMarkets.set(s.ticker, s.market || ''));

    let prices: Map<string, number> | undefined;
    if (tickers.length > 0) {
      try {
        prices = await getMultipleStockPrices(tickers, tickerMarkets);
      } catch {}
    }

    const summary = getPortfolioSummary(prices);
    res.json(summary);
  } catch {
    res.status(500).json({ error: '포트폴리오 조회 실패' });
  }
}));

router.get('/history', (_req: Request, res: Response) => {
  const history = queryAll(`
    SELECT
      t.date,
      SUM(CASE WHEN t.type = 'BUY' THEN t.quantity * t.price ELSE 0 END) as buy_total,
      SUM(CASE WHEN t.type = 'SELL' THEN t.quantity * t.price ELSE 0 END) as sell_total,
      SUM(t.fee) as fees
    FROM transactions t
    WHERE t.deleted_at IS NULL
    GROUP BY t.date
    ORDER BY t.date ASC
  `);
  res.json(history);
});

export default router;
