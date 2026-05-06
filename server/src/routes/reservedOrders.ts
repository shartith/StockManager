import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  listActive,
  listActiveByStock,
  findById,
  create,
  cancel,
} from '../services/reservedOrders';
import { queryOne, execute } from '../db';
import { validate } from '../middleware/validate';

const router = Router();

const createSchema = z.object({
  ticker: z.string().min(1).max(20),
  name: z.string().min(1).max(100).optional(),
  orderType: z.enum(['BUY', 'SELL']),
  targetPrice: z.number().positive(),
  condition: z.enum(['BELOW', 'ABOVE']),
  quantity: z.number().int().nonnegative().optional(),
  reason: z.string().max(200).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

/** 활성 예약 주문 전체 */
router.get('/', (_req: Request, res: Response) => {
  const items = listActive();
  res.json({ items, total: items.length });
});

/** 종목별 활성 예약 주문 */
router.get('/stock/:stockId', (req: Request, res: Response) => {
  const items = listActiveByStock(Number(req.params.stockId));
  res.json({ items });
});

/** 예약 주문 등록 */
router.post('/', validate(createSchema), (req: Request, res: Response) => {
  const { ticker, name, orderType, targetPrice, condition, quantity, reason, expiresAt } = req.body;

  // ticker → stockId (없으면 신규 등록)
  let stock = queryOne<{ id: number }>(
    'SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL',
    [ticker],
  );
  if (!stock) {
    if (!name) return res.status(400).json({ error: '신규 종목은 name 필수' });
    execute(
      'INSERT INTO stocks (ticker, name, market) VALUES (?, ?, ?)',
      [ticker, name, 'KRX'],
    );
    stock = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
    if (!stock) return res.status(500).json({ error: 'stock 등록 실패' });
  }

  const order = create({
    stockId: stock.id,
    ticker,
    market: 'KRX',
    orderType,
    targetPrice,
    condition,
    quantity: quantity ?? 0,
    reason,
    expiresAt: expiresAt ?? null,
  });
  res.json(order);
});

/** 예약 주문 단일 조회 */
router.get('/:id', (req: Request, res: Response) => {
  const order = findById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json(order);
});

/** 예약 주문 취소 */
router.delete('/:id', (req: Request, res: Response) => {
  const ok = cancel(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'not found or not active' });
  res.json({ message: 'cancelled' });
});

export default router;
