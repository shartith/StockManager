import { Router, Request, Response } from 'express';
import { getPortfolioSummary } from '../services/calculator';
import { getMultipleStockPrices } from '../services/stockPrice';
import { queryAll } from '../db';

const router = Router();

router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const stocks = queryAll('SELECT ticker, market FROM stocks');
    const tickers = stocks.map((s: any) => s.ticker);
    const tickerMarkets = new Map<string, string>();
    stocks.forEach((s: any) => tickerMarkets.set(s.ticker, s.market || ''));
    let prices: Map<string, number> | undefined;

    if (tickers.length > 0) {
      try {
        prices = await getMultipleStockPrices(tickers, tickerMarkets);
      } catch {
        // 시세 조회 실패 시 시세 없이 반환
      }
    }

    const summary = await getPortfolioSummary(prices);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: '포트폴리오 조회 실패' });
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
