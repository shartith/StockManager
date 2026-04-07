import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { getPortfolioHeatmap, getMarketHeatmap } from '../services/heatmapData';
import { getSectorRotationContext } from '../services/sectorMomentum';

const router = Router();

/** 포트폴리오 히트맵 */
router.get('/portfolio', asyncHandler(async (_req: Request, res: Response) => {
  const data = await getPortfolioHeatmap();
  res.json(data);
}));

/** 시장 히트맵 (KRX / US) */
router.get('/market', asyncHandler(async (req: Request, res: Response) => {
  const market = (req.query.market as string)?.toUpperCase();
  if (market !== 'KRX' && market !== 'US') {
    res.status(400).json({ error: 'market must be KRX or US' });
    return;
  }
  const data = await getMarketHeatmap(market);
  res.json(data);
}));

/** 섹터 로테이션 컨텍스트 */
router.get('/rotation', asyncHandler(async (req: Request, res: Response) => {
  const market = (req.query.market as string)?.toUpperCase();
  if (market !== 'KRX' && market !== 'US') {
    res.status(400).json({ error: 'market must be KRX or US' });
    return;
  }
  const ctx = await getSectorRotationContext(market);
  res.json(ctx);
}));

export default router;
