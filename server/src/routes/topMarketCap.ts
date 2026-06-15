/**
 * Top Market Cap REST API — KOSPI+KOSDAQ 통합 시총 Top 10.
 *
 *   GET /api/top-market-cap            — 캐시된 Top 10 (없거나 만료면 fresh fetch)
 *   GET /api/top-market-cap?refresh=1  — 강제 갱신
 *   POST /api/top-market-cap/rebalance — 수동 rebalance 실행 (운영자용)
 */

import { Router, Request, Response } from 'express';
import { fetchTop10, refreshTop10, type TopStock } from '../services/topMarketCap';
import { runRebalanceStrategy } from '../services/rebalanceStrategy';
import { queryAll } from '../db';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

interface HoldingMap {
  [ticker: string]: { quantity: number; locked: boolean };
}

function getHoldingMap(): HoldingMap {
  const rows = queryAll<{ ticker: string; qty: number; locked: number }>(`
    SELECT s.ticker,
           COALESCE(s.locked, 0) as locked,
           COALESCE(SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END), 0) as qty
    FROM stocks s
    JOIN transactions t ON t.stock_id = s.id
    WHERE s.deleted_at IS NULL AND t.deleted_at IS NULL
    GROUP BY s.id
    HAVING qty > 0
  `);
  const map: HoldingMap = {};
  for (const r of rows) {
    map[r.ticker] = { quantity: Number(r.qty) || 0, locked: !!r.locked };
  }
  return map;
}

interface DecoratedStock extends TopStock {
  held: boolean;
  heldQuantity: number;
}

interface TopMarketCapResponse {
  top10: DecoratedStock[];
  fetchedAt: string;
  source: string;
  heldNotInTop10: Array<{ ticker: string; quantity: number }>;
}

function decorate(top10: TopStock[], holdings: HoldingMap): DecoratedStock[] {
  return top10.map((s) => {
    const h = holdings[s.ticker];
    return {
      ...s,
      held: Boolean(h),
      heldQuantity: h?.quantity ?? 0,
    };
  });
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = force ? await refreshTop10() : await fetchTop10(false);
    const holdings = getHoldingMap();
    const top10Tickers = new Set(result.top10.map((s) => s.ticker));
    // 고정(잠금) 종목은 자동매매 매도 대상이 아니므로 "이탈 매도 후보" 경고에서 제외
    const heldNotInTop10 = Object.entries(holdings)
      .filter(([ticker, h]) => !top10Tickers.has(ticker) && !h.locked)
      .map(([ticker, h]) => ({ ticker, quantity: h.quantity }));

    const response: TopMarketCapResponse = {
      top10: decorate(result.top10, holdings),
      fetchedAt: result.fetchedAt,
      source: result.source,
      heldNotInTop10,
    };
    res.json(response);
  }),
);

router.post(
  '/rebalance',
  asyncHandler(async (req: Request, res: Response) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'manual';
    const result = await runRebalanceStrategy(`manual: ${reason}`);
    res.json(result);
  }),
);

export default router;
