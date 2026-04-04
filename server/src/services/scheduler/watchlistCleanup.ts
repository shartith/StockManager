/**
 * 관심종목 자동 정리
 */

import { queryAll, execute } from '../../db';
import { createNotification } from '../notification';
import logger from '../../logger';

/** 관심종목 자동 정리 */
export function cleanupWatchlist() {
  logger.info('[Scheduler] 관심종목 자동 정리 시작');
  let removed = 0;
  let disabled = 0;

  // 규칙 1: 30일간 BUY 신호 없는 종목 삭제
  // (신호가 1개 이상 존재하지만 최근 30일 내 BUY가 없는 경우)
  const noBuyItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.added_at <= datetime('now', '-30 days')
    AND EXISTS (
      SELECT 1 FROM trade_signals ts WHERE ts.stock_id = w.stock_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM trade_signals ts
      WHERE ts.stock_id = w.stock_id
      AND ts.signal_type = 'BUY'
      AND ts.created_at >= datetime('now', '-30 days')
    )
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.stock_id = w.stock_id
      GROUP BY t.stock_id
      HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
    )
  `);

  for (const item of noBuyItems) {
    execute('DELETE FROM watchlist WHERE id = ?', [item.id]);
    createNotification({
      type: 'WATCHLIST',
      title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: 30일간 매수 신호 없음`,
      ticker: item.ticker,
      actionUrl: '/watchlist',
    });
    logger.info(`[Scheduler] 관심종목 제거 (30일 BUY 없음): ${item.ticker}`);
    removed++;
  }

  // 규칙 2: 최근 3개 신호 평균 신뢰도 40% 미만 → 자동매매 비활성화
  const autoTradeItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.auto_trade_enabled = 1
  `);

  for (const item of autoTradeItems) {
    const recentSignals = queryAll(
      'SELECT confidence FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 3',
      [item.stock_id]
    );
    if (recentSignals.length >= 3) {
      const avgConfidence = recentSignals.reduce((sum: number, s: any) => sum + Number(s.confidence), 0) / recentSignals.length;
      if (avgConfidence < 40) {
        execute('UPDATE watchlist SET auto_trade_enabled = 0 WHERE id = ?', [item.id]);
        createNotification({
          type: 'WATCHLIST',
          title: '자동매매 비활성화',
          message: `${item.ticker} ${item.name}: 최근 신뢰도 낮음 (평균 ${avgConfidence.toFixed(0)}%)`,
          ticker: item.ticker,
          actionUrl: '/watchlist',
        });
        logger.info(`[Scheduler] 자동매매 비활성화 (신뢰도 ${avgConfidence.toFixed(0)}%): ${item.ticker}`);
        disabled++;
      }
    }
  }

  // 규칙 3: 추천 점수 0 이하 + 14일 이상 경과 → 삭제 (보유 종목 제외)
  const lowScoreItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name, r.score
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    LEFT JOIN recommendations r ON r.ticker = s.ticker AND r.market = w.market AND r.status = 'ACTIVE'
    WHERE w.added_at <= datetime('now', '-14 days')
    AND (r.score IS NULL OR r.score <= 0)
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.stock_id = w.stock_id
      GROUP BY t.stock_id
      HAVING SUM(CASE WHEN t.type = 'BUY' THEN t.quantity ELSE -t.quantity END) > 0
    )
  `);

  // 규칙 1에서 이미 삭제된 ID 제외
  const removedIds = new Set(noBuyItems.map((i: any) => i.id));
  for (const item of lowScoreItems) {
    if (removedIds.has(item.id)) continue;
    execute('DELETE FROM watchlist WHERE id = ?', [item.id]);
    createNotification({
      type: 'WATCHLIST',
      title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: 추천 점수 ${item.score ?? 0}점 이하`,
      ticker: item.ticker,
      actionUrl: '/watchlist',
    });
    logger.info(`[Scheduler] 관심종목 제거 (점수 ${item.score ?? 0}): ${item.ticker}`);
    removed++;
  }

  logger.info(`[Scheduler] 관심종목 정리 완료: ${removed}개 제거, ${disabled}개 자동매매 비활성화`);
}
