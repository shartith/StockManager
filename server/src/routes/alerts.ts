import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const alerts = queryAll(`
    SELECT a.*, s.ticker, s.name as stock_name
    FROM alerts a
    JOIN stocks s ON s.id = a.stock_id
    ORDER BY a.created_at DESC
  `);
  res.json(alerts);
});

router.post('/', (req: Request, res: Response) => {
  const { stock_id, type, value } = req.body;
  if (!stock_id || !type || value === undefined) {
    return res.status(400).json({ error: '종목, 유형, 값은 필수입니다' });
  }
  if (!['PRICE_ABOVE', 'PRICE_BELOW', 'PROFIT_TARGET'].includes(type)) {
    return res.status(400).json({ error: '유효하지 않은 알림 유형입니다' });
  }

  const result = execute(
    'INSERT INTO alerts (stock_id, type, value) VALUES (?, ?, ?)',
    [stock_id, type, value]
  );

  const alert = queryOne(`
    SELECT a.*, s.ticker, s.name as stock_name
    FROM alerts a JOIN stocks s ON s.id = a.stock_id
    WHERE a.id = ?
  `, [result.lastId]);
  res.status(201).json(alert);
});

router.patch('/:id', (req: Request, res: Response) => {
  const { is_active } = req.body;
  const result = execute('UPDATE alerts SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
  const alert = queryOne(`
    SELECT a.*, s.ticker, s.name as stock_name
    FROM alerts a JOIN stocks s ON s.id = a.stock_id
    WHERE a.id = ?
  `, [Number(req.params.id)]);
  res.json(alert);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = execute('DELETE FROM alerts WHERE id = ?', [Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
  res.json({ message: '삭제 완료' });
});

export default router;
