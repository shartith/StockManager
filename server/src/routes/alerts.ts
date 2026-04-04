import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { validate } from '../middleware/validate';
import { createAlertSchema, updateAlertSchema } from '../schemas';

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

router.post('/', validate(createAlertSchema), (req: Request, res: Response) => {
  const { stock_id, type, value } = req.body;

  const result = execute(
    'INSERT INTO alerts (stock_id, type, value) VALUES (?, ?, ?)',
    [stock_id, type, value]
  );

  const alert = queryOne(`
    SELECT a.*, s.ticker, s.name as stock_name
    FROM alerts a JOIN stocks s ON s.id = a.stock_id
    WHERE a.id = ?
  `, [result.lastId]);
  logAudit('alerts', result.lastId, 'CREATE', null, alert);
  res.status(201).json(alert);
});

router.patch('/:id', validate(updateAlertSchema), (req: Request, res: Response) => {
  const { is_active } = req.body;
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM alerts WHERE id = ?', [id]);

  const result = execute('UPDATE alerts SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, id]);
  if (result.changes === 0) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });

  const alert = queryOne(`
    SELECT a.*, s.ticker, s.name as stock_name
    FROM alerts a JOIN stocks s ON s.id = a.stock_id
    WHERE a.id = ?
  `, [id]);
  logAudit('alerts', id, 'UPDATE', existing, alert);
  res.json(alert);
});

router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM alerts WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });

  const result = execute('DELETE FROM alerts WHERE id = ?', [id]);
  if (result.changes === 0) return res.status(404).json({ error: '알림을 찾을 수 없습니다' });
  logAudit('alerts', id, 'DELETE', existing, null);
  res.json({ message: '삭제 완료' });
});

export default router;
