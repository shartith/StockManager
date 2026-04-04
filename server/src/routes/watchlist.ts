import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute, logAudit } from '../db';
import { validate } from '../middleware/validate';
import { createWatchlistSchema, updateWatchlistSchema } from '../schemas';

const router = Router();

/** 관심종목 목록 */
router.get('/', (req: Request, res: Response) => {
  const { market } = req.query;
  let sql = `
    SELECT w.*, s.ticker, s.name, s.market as stock_market, s.sector,
      (SELECT ts.signal_type FROM trade_signals ts WHERE ts.stock_id = w.stock_id ORDER BY ts.created_at DESC LIMIT 1) as latestSignal,
      (SELECT ts.confidence FROM trade_signals ts WHERE ts.stock_id = w.stock_id ORDER BY ts.created_at DESC LIMIT 1) as latestConfidence,
      (SELECT ts.created_at FROM trade_signals ts WHERE ts.stock_id = w.stock_id ORDER BY ts.created_at DESC LIMIT 1) as latestSignalAt
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.deleted_at IS NULL
  `;
  const params: any[] = [];
  if (market) { sql += ' AND w.market = ?'; params.push(market); }
  sql += ' ORDER BY w.added_at DESC';
  res.json(queryAll(sql, params));
});

/** 관심종목 추가 */
router.post('/', validate(createWatchlistSchema), (req: Request, res: Response) => {
  const { stock_id, market, notes, auto_trade_enabled } = req.body;

  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ? AND deleted_at IS NULL', [stock_id]);
  if (existing) return res.status(400).json({ error: '이미 관심종목에 등록되어 있습니다' });

  const stock = queryOne('SELECT market FROM stocks WHERE id = ?', [stock_id]);
  execute(
    'INSERT INTO watchlist (stock_id, market, notes, auto_trade_enabled) VALUES (?, ?, ?, ?)',
    [stock_id, market || stock?.market || 'KRX', notes, auto_trade_enabled ? 1 : 0]
  );
  logAudit('watchlist', stock_id, 'CREATE', null, { stock_id, market, notes, auto_trade_enabled });

  res.json({ message: '관심종목 추가 완료' });
});

/** 자동매매 토글 */
router.patch('/:id', validate(updateWatchlistSchema), (req: Request, res: Response) => {
  const { auto_trade_enabled, notes } = req.body;
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM watchlist WHERE id = ? AND deleted_at IS NULL', [id]);

  const updates: string[] = [];
  const params: any[] = [];

  if (auto_trade_enabled !== undefined) {
    updates.push('auto_trade_enabled = ?');
    params.push(auto_trade_enabled ? 1 : 0);
  }
  if (notes !== undefined) {
    updates.push('notes = ?');
    params.push(notes);
  }

  params.push(id);
  execute(`UPDATE watchlist SET ${updates.join(', ')} WHERE id = ?`, params);
  logAudit('watchlist', id, 'UPDATE', existing, req.body);
  res.json({ message: '업데이트 완료' });
});

/** 관심종목 삭제 (soft delete) */
router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM watchlist WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!existing) return res.status(404).json({ error: '관심종목을 찾을 수 없습니다' });

  execute("UPDATE watchlist SET deleted_at = datetime('now') WHERE id = ?", [id]);
  logAudit('watchlist', id, 'DELETE', existing, null);
  res.json({ message: '삭제 완��' });
});

export default router;
