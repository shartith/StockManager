import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { createDividendSchema } from '../schemas';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { stock_id } = req.query;
  let query = `
    SELECT d.*, s.ticker, s.name as stock_name
    FROM dividends d
    JOIN stocks s ON s.id = d.stock_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (stock_id) { query += ' AND d.stock_id = ?'; params.push(Number(stock_id)); }
  query += ' ORDER BY d.date DESC';

  const dividends = queryAll(query, params);
  res.json(dividends);
});

router.post('/', validate(createDividendSchema), asyncHandler(async (req: Request, res: Response) => {
  const { stock_id, amount, date, memo } = req.body;

  const result = execute(
    'INSERT INTO dividends (stock_id, amount, date, memo) VALUES (?, ?, ?, ?)',
    [stock_id, amount, date, memo]
  );

  const dividend = queryOne(`
    SELECT d.*, s.ticker, s.name as stock_name
    FROM dividends d JOIN stocks s ON s.id = d.stock_id
    WHERE d.id = ?
  `, [result.lastId]);
  logAudit('dividends', result.lastId, 'CREATE', null, dividend);
  res.status(201).json(dividend);
}));

router.delete('/:id', (req: Request, res: Response) => {
  const existing = queryOne('SELECT * FROM dividends WHERE id = ?', [Number(req.params.id)]);
  if (!existing) return res.status(404).json({ error: '배당금 기록을 찾을 수 없습니다' });

  const result = execute('DELETE FROM dividends WHERE id = ?', [Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '배당금 기록을 찾을 수 없습니다' });
  logAudit('dividends', Number(req.params.id), 'DELETE', existing, null);
  res.json({ message: '삭제 완료' });
});

export default router;
