/**
 * 성과 추적기
 * 매매 신호 발생 후 7/14/30일 실제 가격 변동을 추적하여
 * LLM 예측 정확도를 측정한다.
 */

import { queryAll, queryOne, execute } from '../db';
import { getCurrentPrice } from './kisOrder';
import logger from '../logger';

/** 신호를 성과 추적 대상으로 등록 */
export function registerSignalForTracking(signalId: number) {
  const signal = queryOne(
    `SELECT ts.*, s.ticker, s.market
     FROM trade_signals ts
     JOIN stocks s ON s.id = ts.stock_id
     WHERE ts.id = ?`,
    [signalId]
  );
  if (!signal) return;

  // 이미 등록됐는지 체크
  const existing = queryOne('SELECT id FROM signal_performance WHERE signal_id = ?', [signalId]);
  if (existing) return;

  // indicators_json에서 현재가와 목표가/손절가 추출
  let signalPrice = 0;
  let targetPrice: number | null = null;
  let stopLossPrice: number | null = null;
  let keyFactors: string[] = [];

  try {
    const indicators = JSON.parse(signal.indicators_json || '{}');
    signalPrice = indicators.indicators?.currentPrice || 0;
    targetPrice = indicators.targetPrice || null;
    stopLossPrice = indicators.stopLossPrice || null;
    keyFactors = indicators.keyFactors || [];
  } catch { /* */ }

  if (signalPrice <= 0) return; // 가격 정보 없으면 스킵

  execute(
    `INSERT INTO signal_performance
     (signal_id, stock_id, ticker, market, signal_type, signal_confidence, signal_price, target_price, stop_loss_price, key_factors_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [signalId, signal.stock_id, signal.ticker, signal.market,
     signal.signal_type, signal.confidence, signalPrice,
     targetPrice, stopLossPrice, JSON.stringify(keyFactors)]
  );

  execute('UPDATE trade_signals SET performance_tracked = 1 WHERE id = ?', [signalId]);
}

/** 미평가 성과 데이터를 업데이트 (7/14/30일 후 가격 체크) */
export async function evaluatePendingPerformance() {
  logger.info('PerformanceTracker: starting evaluation');

  // 7일 경과 + 미평가
  const need7d = queryAll(
    `SELECT * FROM signal_performance
     WHERE price_7d IS NULL AND created_at <= datetime('now', '-7 days')
     LIMIT 50`
  );

  // 14일 경과 + 미평가
  const need14d = queryAll(
    `SELECT * FROM signal_performance
     WHERE price_14d IS NULL AND price_7d IS NOT NULL AND created_at <= datetime('now', '-14 days')
     LIMIT 50`
  );

  // 30일 경과 + 미평가
  const need30d = queryAll(
    `SELECT * FROM signal_performance
     WHERE price_30d IS NULL AND price_14d IS NOT NULL AND created_at <= datetime('now', '-30 days')
     LIMIT 50`
  );

  let updated = 0;

  for (const sp of need7d) {
    try {
      const price = await getCurrentPrice(sp.ticker, sp.market);
      if (price && price > 0) {
        const returnPct = ((price - sp.signal_price) / sp.signal_price) * 100;
        const targetHit = sp.target_price && price >= sp.target_price ? 1 : 0;
        const stopHit = sp.stop_loss_price && price <= sp.stop_loss_price ? 1 : 0;

        execute(
          `UPDATE signal_performance SET price_7d = ?, return_7d = ?, target_hit = CASE WHEN ? = 1 THEN 1 ELSE target_hit END,
           stop_loss_hit = CASE WHEN ? = 1 THEN 1 ELSE stop_loss_hit END, evaluated_at = datetime('now') WHERE id = ?`,
          [price, returnPct, targetHit, stopHit, sp.id]
        );
        updated++;
      }
    } catch (err) { logger.error({ err, ticker: sp.ticker }, 'PerformanceTracker 7d evaluation error'); }
    await sleep(200);
  }

  for (const sp of need14d) {
    try {
      const price = await getCurrentPrice(sp.ticker, sp.market);
      if (price && price > 0) {
        const returnPct = ((price - sp.signal_price) / sp.signal_price) * 100;
        const targetHit = sp.target_price && price >= sp.target_price ? 1 : 0;
        const stopHit = sp.stop_loss_price && price <= sp.stop_loss_price ? 1 : 0;

        execute(
          `UPDATE signal_performance SET price_14d = ?, return_14d = ?, target_hit = CASE WHEN ? = 1 THEN 1 ELSE target_hit END,
           stop_loss_hit = CASE WHEN ? = 1 THEN 1 ELSE stop_loss_hit END, evaluated_at = datetime('now') WHERE id = ?`,
          [price, returnPct, targetHit, stopHit, sp.id]
        );
        updated++;
      }
    } catch (err) { logger.error({ err, ticker: sp.ticker }, 'PerformanceTracker 14d evaluation error'); }
    await sleep(200);
  }

  for (const sp of need30d) {
    try {
      const price = await getCurrentPrice(sp.ticker, sp.market);
      if (price && price > 0) {
        const returnPct = ((price - sp.signal_price) / sp.signal_price) * 100;
        execute(
          `UPDATE signal_performance SET price_30d = ?, return_30d = ?, evaluated_at = datetime('now') WHERE id = ?`,
          [price, returnPct, sp.id]
        );
        updated++;
      }
    } catch (err) { logger.error({ err, ticker: sp.ticker }, 'PerformanceTracker 30d evaluation error'); }
    await sleep(200);
  }

  logger.info({ updated }, 'PerformanceTracker: evaluation complete');
}

/** 성과 요약 통계 */
export function getPerformanceSummary(market?: string, days = 90): any {
  const marketFilter = market ? 'AND market = ?' : '';
  const params: any[] = [days];
  if (market) params.push(market);

  const stats = queryOne(`
    SELECT
      COUNT(*) as total_signals,
      SUM(CASE WHEN signal_type = 'BUY' THEN 1 ELSE 0 END) as buy_count,
      SUM(CASE WHEN signal_type = 'SELL' THEN 1 ELSE 0 END) as sell_count,
      SUM(CASE WHEN signal_type = 'BUY' AND return_7d > 0 THEN 1 ELSE 0 END) as buy_win_7d,
      SUM(CASE WHEN signal_type = 'BUY' AND return_7d IS NOT NULL THEN 1 ELSE 0 END) as buy_evaluated_7d,
      AVG(CASE WHEN signal_type = 'BUY' AND return_7d IS NOT NULL THEN return_7d END) as avg_buy_return_7d,
      AVG(CASE WHEN signal_type = 'BUY' AND return_14d IS NOT NULL THEN return_14d END) as avg_buy_return_14d,
      AVG(CASE WHEN signal_type = 'BUY' AND return_30d IS NOT NULL THEN return_30d END) as avg_buy_return_30d,
      SUM(CASE WHEN target_hit = 1 THEN 1 ELSE 0 END) as target_hits,
      SUM(CASE WHEN stop_loss_hit = 1 THEN 1 ELSE 0 END) as stop_loss_hits
    FROM signal_performance
    WHERE created_at >= datetime('now', '-' || ? || ' days') ${marketFilter}
  `, params);

  const buyWinRate7d = stats?.buy_evaluated_7d > 0
    ? Math.round((stats.buy_win_7d / stats.buy_evaluated_7d) * 100) : null;

  return {
    totalSignals: stats?.total_signals || 0,
    buyCount: stats?.buy_count || 0,
    sellCount: stats?.sell_count || 0,
    buyWinRate7d,
    avgBuyReturn7d: stats?.avg_buy_return_7d ? Math.round(stats.avg_buy_return_7d * 100) / 100 : null,
    avgBuyReturn14d: stats?.avg_buy_return_14d ? Math.round(stats.avg_buy_return_14d * 100) / 100 : null,
    avgBuyReturn30d: stats?.avg_buy_return_30d ? Math.round(stats.avg_buy_return_30d * 100) / 100 : null,
    targetHitRate: stats?.total_signals > 0 ? Math.round((stats.target_hits / stats.total_signals) * 100) : null,
    stopLossHitRate: stats?.total_signals > 0 ? Math.round((stats.stop_loss_hits / stats.total_signals) * 100) : null,
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
