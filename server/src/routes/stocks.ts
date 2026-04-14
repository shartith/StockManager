import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { createStockSchema, updateStockSchema } from '../schemas';
import { normalizeMarket } from '../services/marketNormalizer';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const stocks = queryAll('SELECT * FROM stocks WHERE deleted_at IS NULL ORDER BY ticker');
  res.json(stocks);
});

router.get('/:id', (req: Request, res: Response) => {
  const stock = queryOne('SELECT * FROM stocks WHERE id = ? AND deleted_at IS NULL', [Number(req.params.id)]);
  if (!stock) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });
  res.json(stock);
});

router.post('/', validate(createStockSchema), asyncHandler(async (req: Request, res: Response) => {
  const { ticker, name, sector } = req.body;
  const market = normalizeMarket(req.body.market);

  const existing = queryOne('SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL', [ticker]);
  if (existing) return res.status(409).json({ error: '이미 등록된 종목코드입니다' });

  const result = execute(
    'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
    [ticker, name, market, sector]
  );
  const stock = queryOne('SELECT * FROM stocks WHERE id = ?', [result.lastId]);
  logAudit('stocks', result.lastId, 'CREATE', null, stock);
  res.status(201).json(stock);
}));

router.put('/:id', validate(updateStockSchema), (req: Request, res: Response) => {
  const { ticker, name, sector } = req.body;
  const market = req.body.market ? normalizeMarket(req.body.market) : undefined;
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM stocks WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });

  execute(
    'UPDATE stocks SET ticker = ?, name = ?, market = ?, sector = ? WHERE id = ?',
    [ticker ?? existing.ticker, name ?? existing.name, market ?? existing.market, sector ?? existing.sector, id]
  );
  const stock = queryOne('SELECT * FROM stocks WHERE id = ?', [id]);
  logAudit('stocks', id, 'UPDATE', existing, stock);
  res.json(stock);
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM stocks WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });

  execute("UPDATE stocks SET deleted_at = datetime('now') WHERE id = ?", [id]);
  logAudit('stocks', id, 'DELETE', existing, null);
  res.json({ message: '삭제 완료' });
});

export default router;
