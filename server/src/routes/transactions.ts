import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { createTransactionSchema } from '../schemas';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { stock_id, type, limit = '100', offset = '0' } = req.query;
  let query = `
    SELECT t.*, s.ticker, s.name as stock_name
    FROM transactions t
    JOIN stocks s ON s.id = t.stock_id
    WHERE t.deleted_at IS NULL
  `;
  const params: any[] = [];

  if (stock_id) { query += ' AND t.stock_id = ?'; params.push(Number(stock_id)); }
  if (type) { query += ' AND t.type = ?'; params.push(type); }

  let countQuery = `SELECT COUNT(*) as count FROM transactions WHERE deleted_at IS NULL`;
  const countParams: any[] = [];
  if (stock_id) { countQuery += ' AND stock_id = ?'; countParams.push(Number(stock_id)); }
  if (type) { countQuery += ' AND type = ?'; countParams.push(type); }

  query += ' ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const transactions = queryAll(query, params);
  const total = queryOne(countQuery, countParams);
  res.json({ transactions, total: total?.count ?? 0 });
});

router.post('/', validate(createTransactionSchema), asyncHandler(async (req: Request, res: Response) => {
  const { stock_id, type, quantity, price, fee, date, memo } = req.body;

  // SELL check must happen atomically with INSERT
  if (type === 'SELL') {
    const holding = queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'BUY' THEN quantity ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN quantity ELSE 0 END), 0) as qty
      FROM transactions WHERE stock_id = ? AND deleted_at IS NULL
    `, [stock_id]);
    if ((holding?.qty ?? 0) < quantity) {
      return res.status(400).json({ error: `보유 수량(${holding?.qty ?? 0})보다 많이 매도할 수 없습니다` });
    }
  }

  const result = execute(
    'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [stock_id, type, quantity, price, fee, date, memo]
  );

  const transaction = queryOne(`
    SELECT t.*, s.ticker, s.name as stock_name
    FROM transactions t JOIN stocks s ON s.id = t.stock_id
    WHERE t.id = ?
  `, [result.lastId]);
  logAudit('transactions', result.lastId, 'CREATE', null, transaction);
  res.status(201).json(transaction);
}));

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM transactions WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) return res.status(404).json({ error: '거래를 찾을 수 없습니다' });

  execute("UPDATE transactions SET deleted_at = datetime('now') WHERE id = ?", [id]);
  logAudit('transactions', id, 'DELETE', existing, null);
  res.json({ message: '삭제 완료' });
});

export default router;
