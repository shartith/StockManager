import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

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

router.post('/', (req: Request, res: Response) => {
  const { stock_id, amount, date, memo } = req.body;
  if (!stock_id || !amount || !date) {
    return res.status(400).json({ error: '종목, 금액, 날짜는 필수입니다' });
  }

  const result = execute(
    'INSERT INTO dividends (stock_id, amount, date, memo) VALUES (?, ?, ?, ?)',
    [stock_id, amount, date, memo || '']
  );

  const dividend = queryOne(`
    SELECT d.*, s.ticker, s.name as stock_name
    FROM dividends d JOIN stocks s ON s.id = d.stock_id
    WHERE d.id = ?
  `, [result.lastId]);
  res.status(201).json(dividend);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = execute('DELETE FROM dividends WHERE id = ?', [Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '배당금 기록을 찾을 수 없습니다' });
  res.json({ message: '삭제 완료' });
});

export default router;
