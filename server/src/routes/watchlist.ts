import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

const router = Router();

/** 관심종목 목록 */
router.get('/', (req: Request, res: Response) => {
  const { market } = req.query;
  let sql = `
    SELECT w.*, s.ticker, s.name, s.market as stock_market, s.sector
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
  `;
  const params: any[] = [];
  if (market) { sql += ' WHERE w.market = ?'; params.push(market); }
  sql += ' ORDER BY w.added_at DESC';
  res.json(queryAll(sql, params));
});

/** 관심종목 추가 */
router.post('/', (req: Request, res: Response) => {
  const { stock_id, market, notes, auto_trade_enabled } = req.body;
  if (!stock_id) return res.status(400).json({ error: 'stock_id는 필수입니다' });

  const existing = queryOne('SELECT id FROM watchlist WHERE stock_id = ?', [stock_id]);
  if (existing) return res.status(400).json({ error: '이미 관심종목에 등록되어 있습니다' });

  const stock = queryOne('SELECT market FROM stocks WHERE id = ?', [stock_id]);
  execute(
    'INSERT INTO watchlist (stock_id, market, notes, auto_trade_enabled) VALUES (?, ?, ?, ?)',
    [stock_id, market || stock?.market || 'KRX', notes || '', auto_trade_enabled ? 1 : 0]
  );

  res.json({ message: '관심종목 추가 완료' });
});

/** 자동매매 토글 */
router.patch('/:id', (req: Request, res: Response) => {
  const { auto_trade_enabled, notes } = req.body;
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

  if (updates.length === 0) return res.status(400).json({ error: '변경할 항목이 없습니다' });

  params.push(Number(req.params.id));
  execute(`UPDATE watchlist SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: '업데이트 완료' });
});

/** 관심종목 삭제 */
router.delete('/:id', (req: Request, res: Response) => {
  execute('DELETE FROM watchlist WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: '삭제 완료' });
});

export default router;
