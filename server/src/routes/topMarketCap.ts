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
import { getPositionAverages } from '../services/positionAverage';
import { queryAll } from '../db';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

interface HoldingMap {
  [ticker: string]: { quantity: number; locked: boolean };
}

/**
 * 보유 수량은 반드시 엔진(positionAverage.getPositionAverages, fold+초과매도 클램프)과
 * 동일한 방식으로 계산할 것 — raw SUM(BUY-SELL)은 원장에 초과매도 기록이 있으면
 * 엔진과 다른 값을 내 "실제 보유 중인데 미보유로 표시" 같은 드리프트가 생긴다
 * (kisOrder.ts:736 참고, v6.1.3에서 동일 패턴의 getHoldingQuantity 제거됨).
 */
function getHoldingMap(): HoldingMap {
  const positions = getPositionAverages();
  const stocks = queryAll<{ id: number; ticker: string; locked: number }>(
    `SELECT id, ticker, COALESCE(locked, 0) as locked FROM stocks WHERE deleted_at IS NULL`,
  );
  const map: HoldingMap = {};
  for (const s of stocks) {
    const qty = positions.get(s.id)?.quantity ?? 0;
    if (qty > 0) {
      map[s.ticker] = { quantity: qty, locked: !!s.locked };
    }
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
