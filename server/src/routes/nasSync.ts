import { Router, Request, Response } from 'express';
import { runNasSync, validateNasPath, getSyncStatus } from '../services/nasSync';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  res.json(getSyncStatus());
});

router.post('/run', asyncHandler(async (_req: Request, res: Response) => {
  const result = await runNasSync();
  res.json(result);
}));

router.post('/validate', (req: Request, res: Response) => {
  const { path: nasPath } = req.body;
  if (!nasPath) return res.status(400).json({ error: 'path는 필수입니다' });
  const result = validateNasPath(nasPath);
  res.json(result);
});

export default router;
