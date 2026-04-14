/**
 * 가상매매(Paper Trading) API
 *
 * 자동으로 생성된 가상 포지션 조회 + 수동 매도 (긴급용) + 통계.
 * 정확도 평가는 signal_performance.is_paper로 자동 합산됨.
 */

import { Router, Request, Response } from 'express';
import { queryAll } from '../db';
import { asyncHandler } from '../middleware/errorHandler';
import {
  getPaperHoldings,
  getPaperSummary,
  executePaperSell,
} from '../services/paperTrading';
import { getMultipleStockPrices } from '../services/stockPrice';

const router = Router();

/** 현재 가상 보유 종목 + 미실현 P&L (현재가 fetch 후 주입) */
router.get('/holdings', asyncHandler(async (_req: Request, res: Response) => {
  const holdings = getPaperHoldings();
  if (holdings.length === 0) {
    res.json([]);
    return;
  }

  const tickers = holdings.map(h => h.ticker);
  const tickerMarkets = new Map(holdings.map(h => [h.ticker, h.market]));
  const prices = await getMultipleStockPrices(tickers, tickerMarkets);

  const enriched = holdings.map(h => {
    const cur = prices.get(h.ticker);
    if (cur && cur > 0) {
      const unrealizedPnL = (cur - h.avgPrice) * h.quantity;
      const unrealizedPnLPercent = ((cur - h.avgPrice) / h.avgPrice) * 100;
      return {
        ...h,
        currentPrice: cur,
        currentValue: cur * h.quantity,
        unrealizedPnL: Math.round(unrealizedPnL * 100) / 100,
        unrealizedPnLPercent: Math.round(unrealizedPnLPercent * 100) / 100,
      };
    }
    return { ...h, currentPrice: null };
  });

  res.json(enriched);
}));

/** 누적 통계 (오픈 포지션 / 실현 P&L / 승률 등) */
router.get('/summary', (_req: Request, res: Response) => {
  res.json(getPaperSummary());
});

/**
 * 전체 가상매매 history (BUY/SELL pair).
 * Transactions 화면에서 union 표시 + PortfolioHistoryChart에서 시계열 사용.
 */
router.get('/history', (_req: Request, res: Response) => {
  const rows = queryAll(`
    SELECT pt.id, pt.stock_id, pt.signal_id, pt.recommendation_id,
      pt.order_type, pt.quantity, pt.price, pt.fee, pt.pair_id,
      pt.reason, pt.pnl, pt.pnl_percent, pt.created_at,
      s.ticker, s.name, s.market, s.sector
    FROM paper_trades pt
    JOIN stocks s ON s.id = pt.stock_id
    ORDER BY pt.created_at DESC
    LIMIT 500
  `);
  res.json(rows);
});

/**
 * 가상매매 종목 수동 매도 (긴급 — 자동 sellRules 외 사용자 개입용)
 * Body: { currentPrice?: number } — 미공급 시 KIS에서 즉시 조회
 */
router.post('/sell/:stockId', asyncHandler(async (req: Request, res: Response) => {
  const stockId = Number(req.params.stockId);
  if (!Number.isFinite(stockId)) {
    res.status(400).json({ error: 'invalid stockId' });
    return;
  }

  let currentPrice = Number(req.body.currentPrice);
  if (!currentPrice || currentPrice <= 0) {
    // KIS에서 현재가 조회
    const holdings = getPaperHoldings();
    const target = holdings.find(h => h.stock_id === stockId);
    if (!target) {
      res.status(404).json({ error: '가상 보유 종목 아님' });
      return;
    }
    const prices = await getMultipleStockPrices([target.ticker], new Map([[target.ticker, target.market]]));
    currentPrice = prices.get(target.ticker) ?? 0;
  }

  const result = executePaperSell(stockId, currentPrice, 'MANUAL');
  res.json(result);
}));

export default router;
