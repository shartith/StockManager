import { Router, Request, Response } from 'express';
import { getPortfolioSummary, getPortfolioRiskContext } from '../services/calculator';
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

    // 각 보유 종목의 최근 신호 추가
    for (const h of summary.holdings) {
      const signal = queryAll(
        'SELECT signal_type, confidence, created_at FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 1',
        [h.stockId]
      );
      (h as any).latestSignal = signal[0]?.signal_type || null;
      (h as any).latestConfidence = signal[0]?.confidence || null;
      (h as any).latestSignalAt = signal[0]?.created_at || null;
    }

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: '포트폴리오 조회 실패' });
  }
});

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
