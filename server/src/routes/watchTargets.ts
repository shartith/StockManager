import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { listActive, upsert, remove, findByStockId } from '../services/watchTargets';
import { buildAutoList } from '../services/autoListBuilder';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

const addSchema = z.object({
  ticker: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  sector: z.string().optional(),
  reason: z.string().optional(),
});

/** 감시대상 조회. ?source=auto|manual 로 필터 가능. */
router.get('/', (req: Request, res: Response) => {
  const source = req.query.source as 'auto' | 'manual' | undefined;
  if (source && source !== 'auto' && source !== 'manual') {
    return res.status(400).json({ error: 'source must be auto|manual' });
  }
  const items = listActive(source);
  res.json({ items, total: items.length });
});

/** 수동 감시대상 추가 */
router.post('/manual', validate(addSchema), (req: Request, res: Response) => {
  const target = upsert({
    ticker: req.body.ticker,
    name: req.body.name,
    sector: req.body.sector,
    source: 'manual',
    reason: req.body.reason,
    expiresAt: null,
  });
  res.json(target);
});

/** 감시대상 제거 (ID 기준) */
router.delete('/:id', (req: Request, res: Response) => {
  const ok = remove(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ message: 'deleted' });
});

/** stock_id로 단일 조회 */
router.get('/by-stock/:stockId', (req: Request, res: Response) => {
  const target = findByStockId(Number(req.params.stockId));
  if (!target) return res.status(404).json({ error: 'not found' });
  res.json(target);
});

/** 자동목록 즉시 재빌드 (수동 트리거) */
router.post('/auto/rebuild', asyncHandler(async (_req: Request, res: Response) => {
  const result = await buildAutoList();
  res.json(result);
}));

export default router;
