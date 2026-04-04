/**
 * 피드백 루프 API
 * 성과 추적, 정확도 분석, 가중치 관리, 백테스트
 */

import { Router } from 'express';
import { getPerformanceSummary } from '../services/performanceTracker';
import { analyzeSignalAccuracy } from '../services/signalAnalyzer';
import { loadWeights, optimizeWeights, resetWeights } from '../services/weightOptimizer';
import { runBacktest, saveBacktestResult, BacktestConfig } from '../services/backtester';
import { exportStrategy, importStrategy, generateLoraDataset, getLoraDataCount, exportFullConfig, importFullConfig } from '../services/exportImport';
import { queryAll } from '../db';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { backtestSchema, configRestoreSchema, strategyImportSchema } from '../schemas';

const router = Router();

// 성과 요약
router.get('/performance', (req, res) => {
  const market = req.query.market as string | undefined;
  const days = Number(req.query.days) || 90;
  res.json(getPerformanceSummary(market, days));
});

// 신호 정확도 분석
router.get('/accuracy', (req, res) => {
  const days = Number(req.query.days) || 90;
  res.json(analyzeSignalAccuracy(days));
});

// 현재 가중치 조회
router.get('/weights', (_req, res) => {
  res.json(loadWeights());
});

// 가중치 수동 최적화 실행
router.post('/weights/optimize', (_req, res) => {
  const result = optimizeWeights();
  res.json(result);
});

// 가중치 초기화
router.post('/weights/reset', (_req, res) => {
  const weights = resetWeights();
  res.json({ message: '가중치가 초기화되었습니다', weights });
});

// 가중치 변경 이력
router.get('/weights/history', (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = queryAll(
    'SELECT * FROM weight_optimization_log ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json(rows);
});

// 백테스트 실행
router.post('/backtest', validate(backtestSchema), (req, res) => {
  const config: BacktestConfig = req.body;
  const result = runBacktest(config);
  const id = saveBacktestResult(config, result);
  res.json({ id, ...result });
});

// 백테스트 결과 목록
router.get('/backtest', (req, res) => {
  const limit = Number(req.query.limit) || 20;
  const rows = queryAll(
    'SELECT id, name, ticker, market, start_date, end_date, total_trades, total_return, max_drawdown, sharpe_ratio, win_rate, profit_factor, created_at FROM backtest_results ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json(rows);
});

// 백테스트 결과 상세
router.get('/backtest/:id', (req, res) => {
  const row = queryAll('SELECT * FROM backtest_results WHERE id = ?', [req.params.id]);
  if (row.length === 0) return res.status(404).json({ error: '결과를 찾을 수 없습니다' });

  const result = row[0];
  try {
    result.results_json = JSON.parse(result.results_json);
    result.strategy_config_json = JSON.parse(result.strategy_config_json);
  } catch { /* */ }
  res.json(result);
});

/** 주간 학습 리포트 조회 */
router.get('/weekly-reports', (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const { queryAll } = require('../db');
  const reports = queryAll(
    'SELECT id, report, stats_json, weight_changes_json, created_at FROM weekly_reports ORDER BY created_at DESC LIMIT ?',
    [limit]
  );
  res.json(reports.map((r: any) => {
    try { r.stats_json = JSON.parse(r.stats_json); } catch {}
    return r;
  }));
});

// ─── 전략 내보내기/가져오기 ─────────────────────────────────

/** 전체 설정 백업 (API 키 포함) */
router.get('/config/backup', (_req, res) => {
  try {
    const result = exportFullConfig();
    const fs = require('fs');
    const content = JSON.parse(fs.readFileSync(result.filePath, 'utf-8'));
    // Strip credentials from HTTP response to prevent exfiltration
    if (content.settings) {
      const { kisAppKey, kisAppSecret, dartApiKey, ...safeSettings } = content.settings;
      content.settings = {
        ...safeSettings,
        kisAppKey: kisAppKey ? '****' : '',
        kisAppSecret: kisAppSecret ? '****' : '',
        dartApiKey: dartApiKey ? '****' : '',
      };
    }
    res.json({ success: true, config: content });
  } catch (err: unknown) {
    res.status(500).json({ error: '백업 실패' });
  }
});

/** 전체 설정 복원 */
router.post('/config/restore', validate(configRestoreSchema), (req, res) => {
  try {
    const config = req.body;
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(require('os').tmpdir(), `restore-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config), 'utf-8');
    const result = importFullConfig(tmpFile);
    fs.unlinkSync(tmpFile);
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: '복원 실패' });
  }
});

/** 전략 내보내기 */
router.get('/strategy/export', (_req, res) => {
  try {
    const result = exportStrategy();
    const fs = require('fs');
    const content = JSON.parse(fs.readFileSync(result.filePath, 'utf-8'));
    // Do not expose internal filePath to client
    res.json({ success: true, strategy: content });
  } catch (err: unknown) {
    res.status(500).json({ error: '전략 내보내기 실패' });
  }
});

/** 전략 가져오기 (JSON body로 직접 전달) */
router.post('/strategy/import', validate(strategyImportSchema), (req, res) => {
  try {
    const strategy = req.body;

    // 임시 파일에 저장 후 import
    const fs = require('fs');
    const path = require('path');
    const tmpFile = path.join(require('os').tmpdir(), `strategy-import-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(strategy), 'utf-8');

    const result = importStrategy(tmpFile);
    fs.unlinkSync(tmpFile);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: '전략 가져오기 실패' });
  }
});

/** LoRA 데이터 상태 */
router.get('/lora/status', (_req, res) => {
  const count = getLoraDataCount();
  res.json({ count, required: 5000, ready: count >= 5000, percent: Math.round(count / 5000 * 100) });
});

/** LoRA 데이터 내보내기 */
router.get('/lora/export', (_req, res) => {
  try {
    const result = generateLoraDataset();
    if (result.filePath) {
      res.json({ success: true, count: result.count, message: result.message });
    } else {
      res.json({ success: false, count: result.count, message: result.message });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: 'LoRA 데이터 생성 실패' });
  }
});

export default router;
