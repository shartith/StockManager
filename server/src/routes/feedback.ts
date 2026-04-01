/**
 * 피드백 루프 API
 * 성과 추적, 정확도 분석, 가중치 관리, 백테스트
 */

import { Router } from 'express';
import { getPerformanceSummary } from '../services/performanceTracker';
import { analyzeSignalAccuracy } from '../services/signalAnalyzer';
import { loadWeights, optimizeWeights, resetWeights } from '../services/weightOptimizer';
import { runBacktest, saveBacktestResult, BacktestConfig } from '../services/backtester';
import { queryAll } from '../db';

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
router.post('/backtest', (req, res) => {
  const config: BacktestConfig = req.body;
  if (!config.candles || config.candles.length < 60) {
    return res.status(400).json({ error: '최소 60개 캔들 데이터가 필요합니다' });
  }
  if (!config.name) {
    return res.status(400).json({ error: 'name은 필수입니다' });
  }
  if (!config.initialCapital || config.initialCapital <= 0) {
    return res.status(400).json({ error: 'initialCapital은 양수여야 합니다' });
  }

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

export default router;
