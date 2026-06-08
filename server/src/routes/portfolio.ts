import { Router, Request, Response } from 'express';
import { getPortfolioSummary } from '../services/calculator';
import { getMultipleStockPrices } from '../services/stockPrice';
import { getKisBalance } from '../services/kisBalance';
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

    // 헤드라인 정합성: 증권사 실계좌(getKisBalance)가 응답하면 그 실수치를 진실의 원천으로
    // 사용해 평가금액/매입금액/손익을 덮어쓴다. (DB 추정치가 실계좌와 어긋나는 문제 해소)
    // 종목별 breakdown(holdings)은 DB 그대로 두되, 합계는 증권사 기준으로 표시.
    try {
      const kis = await getKisBalance();
      if (kis && kis.totalEvalAmount > 0) {
        summary.totalCurrentValue = kis.totalEvalAmount;
        summary.totalInvested = kis.totalPurchaseAmount || summary.totalInvested;
        summary.totalProfitLoss = kis.totalProfitLoss;
        summary.totalProfitLossPercent = kis.totalProfitLossRate;
        (summary as typeof summary & { source?: string; stale?: boolean }).source = 'kis';
        (summary as typeof summary & { source?: string; stale?: boolean }).stale = kis.stale ?? false;
      } else {
        (summary as typeof summary & { source?: string }).source = 'db-estimate';
      }
    } catch {
      (summary as typeof summary & { source?: string }).source = 'db-estimate';
    }

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
