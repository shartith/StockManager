import { Router, Request, Response } from 'express';
import { queryAll, queryOne, execute } from '../db';
import { getAllRules } from '../services/tradingRules';
import { validate } from '../middleware/validate';
import { updateTradingRuleSchema } from '../schemas';

const router = Router();

// 규칙 목록 조회
router.get('/', (_req: Request, res: Response) => {
  const rules = getAllRules();
  res.json(rules);
});

// 개별 규칙 업데이트
router.patch('/:ruleId', validate(updateTradingRuleSchema), (req: Request, res: Response) => {
  const { ruleId } = req.params;
  const { is_enabled, params_json } = req.body;

  const existing = queryOne('SELECT * FROM trading_rules WHERE rule_id = ?', [ruleId]);
  if (!existing) {
    res.status(404).json({ error: '규칙을 찾을 수 없습니다' });
    return;
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (is_enabled !== undefined) {
    updates.push('is_enabled = ?');
    params.push(is_enabled ? 1 : 0);
  }
  if (params_json !== undefined) {
    updates.push('params_json = ?');
    params.push(JSON.stringify(params_json));
  }

  if (updates.length > 0) {
    params.push(ruleId);
    execute(`UPDATE trading_rules SET ${updates.join(', ')} WHERE rule_id = ?`, params);
  }

  res.json({ message: '규칙 업데이트 완료' });
});

// 규칙 적용 이력 (trade_signals에서 규칙이 적용된 기록 조회)
router.get('/history', (req: Request, res: Response) => {
  const limit = Number(req.query.limit) || 50;
  const signals = queryAll(
    `SELECT ts.*, s.ticker, s.name as stock_name
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.indicators_json LIKE '%triggeredRules%'
     ORDER BY ts.created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json(signals);
});

export default router;
