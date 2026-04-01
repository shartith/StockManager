import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const stocks = queryAll('SELECT * FROM stocks ORDER BY ticker');
  res.json(stocks);
});

router.get('/:id', (req: Request, res: Response) => {
  const stock = queryOne('SELECT * FROM stocks WHERE id = ?', [Number(req.params.id)]);
  if (!stock) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });
  res.json(stock);
});

router.post('/', (req: Request, res: Response) => {
  const { ticker, name, market, sector } = req.body;
  if (!ticker || !name) return res.status(400).json({ error: '종목코드와 이름은 필수입니다' });

  try {
    const existing = queryOne('SELECT id FROM stocks WHERE ticker = ?', [ticker.toUpperCase()]);
    if (existing) return res.status(409).json({ error: '이미 등록된 종목코드입니다' });

    const result = execute(
      'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
      [ticker.toUpperCase(), name, market || '', sector || '']
    );
    const stock = queryOne('SELECT * FROM stocks WHERE id = ?', [result.lastId]);
    res.status(201).json(stock);
  } catch {
    res.status(500).json({ error: '종목 등록 실패' });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  const { ticker, name, market, sector } = req.body;
  const id = Number(req.params.id);
  const existing = queryOne('SELECT * FROM stocks WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });

  execute(
    'UPDATE stocks SET ticker = ?, name = ?, market = ?, sector = ? WHERE id = ?',
    [ticker ?? existing.ticker, name ?? existing.name, market ?? existing.market, sector ?? existing.sector, id]
  );
  const stock = queryOne('SELECT * FROM stocks WHERE id = ?', [id]);
  res.json(stock);
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = execute('DELETE FROM stocks WHERE id = ?', [Number(req.params.id)]);
  if (result.changes === 0) return res.status(404).json({ error: '종목을 찾을 수 없습니다' });
  res.json({ message: '삭제 완료' });
});

export default router;
