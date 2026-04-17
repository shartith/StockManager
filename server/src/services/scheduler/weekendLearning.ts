/**
 * 주말 학습: 성과 평가 + 가중치 최적화 + 리포트 생성
 */

import { queryAll, queryOne, execute } from '../../db';
import { getSettings } from '../settings';
import { evaluatePendingPerformance } from '../performanceTracker';
import { optimizeWeights, loadWeights } from '../weightOptimizer';
import { runBacktest, runABCompare, saveBacktestResult, collectBacktestCandidates } from '../backtester';
import { createNotification } from '../notification';
import { getLoraDataCount, generateLoraDataset } from '../exportImport';
import logger from '../../logger';
import { fetchCandleData } from './helpers';

/** 주말 학습: 성과 평가 + 가중치 최적화 + 리포트 생성 */
export async function runWeekendLearning() {
  logger.info('[Scheduler] 주말 학습 시작');
  const settings = getSettings(); // v4.19.0: 백테스트 블록과 LLM 리포트 모두 사용

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

  // 2.5 백테스트 루프 (v4.17.0) — 대상 확대 + DB 저장.
  //   이전: 최근 7일 체결 종목 5개, 결과 텍스트만
  //   현재: 체결 + 관심종목 + 활성 추천 상위 → 최대 30종목, DB 저장
  //   저장된 결과는 Protection(BacktestReject)·scoring 가점에서 참조.
  let backtestSummary = '';
  let backtestStats = { evaluated: 0, profitable: 0, unprofitable: 0 };
  try {
    const candidates = collectBacktestCandidates(30);
    logger.info(`[Scheduler] 주말 백테스트 대상: ${candidates.length}종목`);

    // v4.19.0: 통계 유의성 임계값을 settings로 override 가능.
    // 기본 5 (v4.17.0 유지). 데이터 축적 시 사용자가 30 등으로 상향 권장.
    const minTradesForSave = (settings as any).backtestMinTradesForSave ?? 5;

    const btResults: string[] = [];
    for (const t of candidates) {
      try {
        const candles = await fetchCandleData(t.ticker, t.market === 'KRX' ? 'KRX' : 'NYSE');
        if (!candles || candles.length < 60) continue;

        const config = {
          name: `weekly-${t.ticker}-${new Date().toISOString().slice(0, 10)}`,
          ticker: t.ticker,
          market: t.market as 'KRX' | 'NYSE' | 'NASDAQ',
          candles,
          initialCapital: 2_000_000,
        };
        const result = runBacktest(config);

        // 통계적 유의성 최소 거래 수 충족 시만 저장
        if (result.totalTrades >= minTradesForSave) {
          saveBacktestResult(config, result);
          backtestStats.evaluated++;
          if ((result.profitFactor ?? 0) >= 1.0) backtestStats.profitable++;
          else backtestStats.unprofitable++;
        }

        // 상위 5개만 리포트에 포함
        if (btResults.length < 5) {
          btResults.push(`${t.ticker}: PF ${result.profitFactor?.toFixed(2) ?? 'n/a'}, 승률 ${result.winRate}%, 수익 ${result.totalReturn.toFixed(1)}%`);
        }
      } catch (err) { logger.error({ err, ticker: t.ticker }, 'Weekend backtest failed for ticker'); }
    }
    backtestSummary = `백테스트 ${backtestStats.evaluated}건 저장 (수익 ${backtestStats.profitable} / 손실 ${backtestStats.unprofitable})`;
    if (btResults.length > 0) backtestSummary += ` — ${btResults.join(' | ')}`;

    // A/B 전략 비교 (현재 가중치 vs 균등 가중치) — 최근 체결 종목 중 첫 번째로 샘플
    const tradedFirst = queryOne(
      `SELECT s.ticker, s.market FROM auto_trades at
       JOIN stocks s ON s.id = at.stock_id
       WHERE at.status = 'FILLED' AND at.created_at >= datetime('now', '-7 days')
         AND s.deleted_at IS NULL
       LIMIT 1`
    );
    if (tradedFirst) {
      const currentWeights = loadWeights();
      const equalWeights: any = {};
      for (const key of Object.keys(currentWeights)) equalWeights[key] = 1.0;

      const candles = await fetchCandleData(tradedFirst.ticker, tradedFirst.market === 'KRX' ? 'KRX' : 'NYSE');
      if (candles && candles.length >= 60) {
        const abResult = runABCompare(candles, tradedFirst.ticker, currentWeights, equalWeights, '최적화 전략', '기본 전략');
        backtestSummary += ` | A/B(${tradedFirst.ticker}): ${abResult.winner === 'A' ? '최적화 승' : abResult.winner === 'B' ? '기본 승' : '무승부'}`;
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
