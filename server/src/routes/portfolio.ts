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

    // 정합성: 증권사 실계좌(getKisBalance)가 응답하면 그 실수치를 진실의 원천으로 사용.
    // v6.0.2: 헤드라인(평가금액/매입금액/손익) 덮어씀.
    // v6.0.4: 종목별 breakdown(수량/평단/현재가/손익)도 KIS 로 덮어씀 — 보유/거래 화면의
    //         평균단가가 KIS 매입평균(pchs_avg_pric)과 정확히 일치하도록.
    //         KIS 잔고에 없는 종목(드리프트)만 DB 계산값 유지.
    try {
      const kis = await getKisBalance();
      if (kis && kis.totalEvalAmount > 0) {
        summary.totalCurrentValue = kis.totalEvalAmount;
        summary.totalInvested = kis.totalPurchaseAmount || summary.totalInvested;
        summary.totalProfitLoss = kis.totalProfitLoss;
        summary.totalProfitLossPercent = kis.totalProfitLossRate;

        const kisByTicker = new Map(kis.holdings.map(h => [h.ticker, h]));
        summary.holdings = summary.holdings.map(h => {
          const k = kisByTicker.get(h.ticker);
          if (!k || k.quantity <= 0 || k.avgPrice <= 0) return h; // KIS 에 없으면 DB 폴백
          const totalCost = Math.round(k.avgPrice * k.quantity * 100) / 100;
          const currentValue = k.totalValue > 0 ? k.totalValue : Math.round(k.currentPrice * k.quantity);
          return {
            ...h,
            quantity: k.quantity,
            avgPrice: k.avgPrice,
            totalCost,
            currentPrice: k.currentPrice > 0 ? k.currentPrice : h.currentPrice,
            currentValue,
            profitLoss: Math.round((currentValue - totalCost) * 100) / 100,
            profitLossPercent: k.profitLossRate,
          };
        });

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
