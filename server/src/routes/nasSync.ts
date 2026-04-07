import { Router, Request, Response } from 'express';
import { runNasSync, validateNasPath, getSyncStatus } from '../services/nasSync';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

router.get('/status', (_req: Request, res: Response) => {
  res.json(getSyncStatus());
});

/**
 * POST /api/nas-sync/run
 *
 * Default behavior: NAS-style sync (secrets MASKED) — for external/shared storage.
 * To create a local backup with secrets included for restore, use /backup instead
 * or pass `{ "includeSecrets": true }` in the request body.
 */
router.post('/run', asyncHandler(async (req: Request, res: Response) => {
  const includeSecrets = req.body?.includeSecrets === true;
  const result = await runNasSync({ includeSecrets });
  res.json(result);
}));

/**
 * POST /api/nas-sync/backup
 *
 * Local backup mode: secrets are INCLUDED in the settings snapshot so the
 * user can recover full configuration after a brew upgrade or reinstall.
 * The user explicitly invokes this from the "로컬 백업" button.
 */
router.post('/backup', asyncHandler(async (_req: Request, res: Response) => {
  const result = await runNasSync({ includeSecrets: true });
  res.json(result);
}));

router.post('/validate', (req: Request, res: Response) => {
  const { path: nasPath } = req.body;
  if (!nasPath) return res.status(400).json({ error: 'path는 필수입니다' });
  const result = validateNasPath(nasPath);
  res.json(result);
});

export default router;
