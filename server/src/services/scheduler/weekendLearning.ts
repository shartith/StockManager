/**
 * 주말 학습: 성과 평가 + 가중치 최적화 + 리포트 생성
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { evaluatePendingPerformance } from '../performanceTracker';
import { optimizeWeights, loadWeights } from '../weightOptimizer';
import { runBacktest, runABCompare } from '../backtester';
import { createNotification } from '../notification';
import { getLoraDataCount, generateLoraDataset } from '../exportImport';
import logger from '../../logger';
import { fetchCandleData } from './helpers';

/** 주말 학습: 성과 평가 + 가중치 최적화 + 리포트 생성 */
export async function runWeekendLearning() {
  logger.info('[Scheduler] 주말 학습 시작');

  // 1. 미평가 신호 성과 평가
  try { await evaluatePendingPerformance(); } catch (err) { logger.error({ err }, 'Weekend evaluatePendingPerformance failed'); }

  // 2. 가중치 최적화
  let weightChanges = '';
  try {
    const result = optimizeWeights();
    if (result.adjusted.length > 0) {
      weightChanges = result.adjusted.map((a: any) => `${a.type}: ${a.oldWeight.toFixed(2)}→${a.newWeight.toFixed(2)}`).join(', ');
    }
  } catch (err) { logger.error({ err }, 'Weekend optimizeWeights failed'); }

  // 2.5 이번 주 매매 종목 백테스트
  let backtestSummary = '';
  try {
    const tradedTickers = queryAll(
      "SELECT DISTINCT s.ticker, s.market FROM auto_trades at JOIN stocks s ON s.id = at.stock_id WHERE at.status = 'FILLED' AND at.created_at >= datetime('now', '-7 days')"
    );
    const btResults: string[] = [];
    for (const t of tradedTickers.slice(0, 5)) {
      try {
        const candles = await fetchCandleData(t.ticker, t.market === 'KRX' ? 'KRX' : 'NYSE');
        if (candles && candles.length >= 60) {
          const result = runBacktest({ name: `auto-${t.ticker}`, ticker: t.ticker, candles, initialCapital: 2000000 });
          btResults.push(`${t.ticker}: 승률 ${(result.winRate * 100).toFixed(0)}%, 수익률 ${result.totalReturn.toFixed(1)}%`);
        }
      } catch (err) { logger.error({ err, ticker: t.ticker }, 'Weekend backtest failed for ticker'); }
    }
    if (btResults.length > 0) backtestSummary = btResults.join(' | ');

    // A/B 전략 비교 (현재 가중치 vs 균등 가중치)
    if (tradedTickers.length > 0) {
      const currentWeights = loadWeights();
      const equalWeights: any = {};
      for (const key of Object.keys(currentWeights)) equalWeights[key] = 1.0;

      const firstTicker = tradedTickers[0];
      const candles = await fetchCandleData(firstTicker.ticker, firstTicker.market === 'KRX' ? 'KRX' : 'NYSE');
      if (candles && candles.length >= 60) {
        const abResult = runABCompare(candles, firstTicker.ticker, currentWeights, equalWeights, '최적화 전략', '기본 전략');
        backtestSummary += ` | A/B비교(${firstTicker.ticker}): ${abResult.winner === 'A' ? '최적화 승' : abResult.winner === 'B' ? '기본 승' : '무승부'}`;
        logger.info(`[Scheduler] A/B 백테스트: ${abResult.summary}`);
      }
    }
  } catch (err) { logger.error({ err }, 'Weekend backtest/AB compare failed'); }

  // 3. 주간 통계 수집
  const weekStats: any = {
    totalSignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE created_at >= datetime('now', '-7 days')")?.cnt || 0,
    buySignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE signal_type='BUY' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    sellSignals: queryOne("SELECT COUNT(*) as cnt FROM trade_signals WHERE signal_type='SELL' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    tradesExecuted: queryOne("SELECT COUNT(*) as cnt FROM auto_trades WHERE status='FILLED' AND created_at >= datetime('now', '-7 days')")?.cnt || 0,
    avgConfidence: queryOne("SELECT AVG(confidence) as avg FROM trade_signals WHERE created_at >= datetime('now', '-7 days')")?.avg || 0,
    weightChanges,
    backtestSummary,
  };

  // 4. LLM으로 학습 리포트 생성 (callLlm 헬퍼 사용 — 통일된 mutex/retry/timeout 공유)
  const settings = getSettings();
  let report = `주간 요약: 신호 ${weekStats.totalSignals}건 (BUY ${weekStats.buySignals}/SELL ${weekStats.sellSignals}), 체결 ${weekStats.tradesExecuted}건, 평균신뢰도 ${Math.round(weekStats.avgConfidence)}%`;

  if (settings.llmEnabled) {
    try {
      const system = '당신은 한국 주식 자동매매 시스템의 성과를 분석하는 전문 애널리스트입니다.';
      const prompt = `이번 주 자동매매 트레이딩 결과를 분석하고 다음 주 전략을 제안하세요:
- 총 매매 신호: ${weekStats.totalSignals}건 (BUY ${weekStats.buySignals}건, SELL ${weekStats.sellSignals}건)
- 실제 체결: ${weekStats.tradesExecuted}건
- 평균 신뢰도: ${Math.round(weekStats.avgConfidence)}%
- 가중치 변경: ${weekStats.weightChanges || '없음'}

3~5문장으로 이번 주 성과를 평가하고, 다음 주 개선할 점 3가지를 제안하세요.`;

      const { callLlm } = await import('../llm');
      const text = await callLlm(settings.llmModel, settings.llmUrl, prompt, system, 800, settings.llmApiKey);
      if (text.trim()) report = text.trim();
    } catch (err) { logger.error({ err }, 'Weekend learning report generation failed'); }
  }

  // 5. DB 저장 + 알림
  execute('INSERT INTO weekly_reports (report, stats_json, weight_changes_json) VALUES (?, ?, ?)',
    [report, JSON.stringify(weekStats), weekStats.weightChanges]);

  createNotification({
    type: 'LEARNING' as any, title: '주간 학습 완료',
    message: report.slice(0, 200) + (report.length > 200 ? '...' : ''),
    actionUrl: '/feedback',
  });

  // 6. LoRA 학습 데이터 자동 체크/생성
  const loraCount = getLoraDataCount();
  if (loraCount >= 5000) {
    try {
      const loraResult = generateLoraDataset();
      logger.info(`[Scheduler] ${loraResult.message}`);
      createNotification({
        type: 'LEARNING' as any,
        title: 'LoRA 학습 데이터 생성',
        message: `${loraResult.count}건의 학습 데이터가 생성되었습니다. ${loraResult.filePath}`,
        actionUrl: '/feedback',
      });
    } catch (err) { logger.error({ err }, 'LoRA dataset generation failed'); }
  } else {
    logger.info(`[Scheduler] LoRA 학습 데이터: ${loraCount}/5,000건 (${Math.round(loraCount / 5000 * 100)}%)`);
  }

  logger.info('[Scheduler] 주말 학습 완료');
}
