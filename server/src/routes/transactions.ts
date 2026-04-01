import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { stock_id, type, limit = '100', offset = '0' } = req.query;
  let query = `
    SELECT t.*, s.ticker, s.name as stock_name
    FROM transactions t
    JOIN stocks s ON s.id = t.stock_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (stock_id) { query += ' AND t.stock_id = ?'; params.push(Number(stock_id)); }
  if (type) { query += ' AND t.type = ?'; params.push(type); }

  let countQuery = `SELECT COUNT(*) as count FROM transactions WHERE 1=1`;
  const countParams: any[] = [];
  if (stock_id) { countQuery += ' AND stock_id = ?'; countParams.push(Number(stock_id)); }
  if (type) { countQuery += ' AND type = ?'; countParams.push(type); }

  query += ' ORDER BY t.date DESC, t.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const transactions = queryAll(query, params);
  const total = queryOne(countQuery, countParams);
  res.json({ transactions, total: total?.count ?? 0 });
});

router.post('/', (req: Request, res: Response) => {
  const { stock_id, type, quantity, price, fee, date, memo } = req.body;
  if (!stock_id || !type || !quantity || price === undefined || !date) {
    return res.status(400).json({ error: '필수 항목을 입력해주세요' });
  }
  if (!['BUY', 'SELL'].includes(type)) {
    return res.status(400).json({ error: '거래 유형은 BUY 또는 SELL이어야 합니다' });
  }

  if (type === 'SELL') {
    const holding = queryOne(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'BUY' THEN quantity ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN quantity ELSE 0 END), 0) as qty
      FROM transactions WHERE stock_id = ?
    `, [stock_id]);
    if ((holding?.qty ?? 0) < quantity) {
      return res.status(400).json({ error: `보유 수량(${holding?.qty ?? 0})보다 많이 매도할 수 없습니다` });
    }
  }

  const result = execute(
    'INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [stock_id, type, quantity, price, fee || 0, date, memo || '']
  );

  const transaction = queryOne(`
    SELECT t.*, s.ticker, s.name as stock_name
    FROM transactions t JOIN stocks s ON s.id = t.stock_id
    WHERE t.id = ?
  `, [result.lastId]);
  res.status(201).json(transaction);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = execute('DELETE FROM transactions WHERE id = ?', [Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '거래를 찾을 수 없습니다' });
  res.json({ message: '삭제 완료' });
});

export default router;
