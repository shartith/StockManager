/**
 * 관심종목 + 추천종목 자동 정리
 *
 * v4.10.2: 조건 완화 + recommendation expiry를 LLM 무관하게 분리
 */

import { queryAll, queryOne, execute } from '../../db';
import { createNotification } from '../notification';
import logger from '../../logger';

// ─── Helpers ───────────────────────────────────────────────

/** 해당 종목이 현재 실보유(transactions 기준)인지 */
function isHoldingReal(stockId: number): boolean {
  const row = queryOne(
    `SELECT COALESCE(SUM(CASE WHEN type='BUY' THEN quantity ELSE -quantity END), 0) AS qty
     FROM transactions WHERE stock_id = ? AND deleted_at IS NULL`,
    [stockId],
  );
  return (row?.qty ?? 0) > 0;
}

// ─── 추천종목 만료 (LLM 무관) ───────────────────────────

export interface RecommendationCleanupResult {
  expired: number;
  purged: number;
}

/**
 * 추천종목 ACTIVE → EXPIRED 자동 전환 (v4.14.0: TOP 50 경쟁 구도).
 * LLM 사용 여부와 무관. 감점으로 음수가 되면 즉시 제거.
 *
 * 규칙:
 *   1. expires_at 경과 → EXPIRED
 *   2. score < 0 → **즉시 EXPIRED** (감점으로 음수 전환)
 *   3. confidence < 50 → **즉시 EXPIRED**
 *   4. 생성 5일 이상 + ACTIVE → EXPIRED (TOP 50 경쟁 기간 확대)
 *   5. 7일+ 지난 EXPIRED/DISMISSED → 실제 DELETE (용량 정리)
 */
export function expireStaleRecommendations(): RecommendationCleanupResult {
  let expired = 0;
  let purged = 0;

  // 1. expires_at 지난 ACTIVE
  const r1 = execute(
    `UPDATE recommendations
     SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime('now')
       AND (deleted_at IS NULL)`,
  );
  expired += r1.changes ?? 0;

  // 2. score < 0 — 즉시 만료 (감점으로 음수 전환 시 퇴출)
  const r2 = execute(
    `UPDATE recommendations
     SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND score < 0
       AND (deleted_at IS NULL)`,
  );
  expired += r2.changes ?? 0;

  // 3. confidence < 50 — 즉시 만료
  const r3 = execute(
    `UPDATE recommendations
     SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND confidence < 50
       AND (deleted_at IS NULL)`,
  );
  expired += r3.changes ?? 0;

  // 4. 생성 5일 이상 ACTIVE (TOP 50 경쟁 기간 확대: 3일 → 5일)
  const r4 = execute(
    `UPDATE recommendations
     SET status = 'EXPIRED'
     WHERE status = 'ACTIVE'
       AND created_at <= datetime('now', '-5 days')
       AND (deleted_at IS NULL)`,
  );
  expired += r4.changes ?? 0;

  // 5. 7일+ 지난 EXPIRED/DISMISSED → 실제 삭제 (기존 30일 → 7일)
  const r5 = execute(
    `DELETE FROM recommendations
     WHERE status IN ('EXPIRED', 'DISMISSED')
       AND created_at <= datetime('now', '-7 days')`,
  );
  purged += r5.changes ?? 0;

  if (expired > 0 || purged > 0) {
    logger.info({ expired, purged }, '추천종목 만료/정리 완료');
  }
  return { expired, purged };
}

// ─── 관심종목 자동 정리 (기존 + 완화) ───────────────────────

export interface WatchlistCleanupResult {
  removed: number;
  disabled: number;
  reasons: Array<{ ticker: string; reason: string }>;
}

/** 관심종목 자동 정리 — 조건 완화 버전 */
export function cleanupWatchlist(): WatchlistCleanupResult {
  logger.info('[Scheduler] 관심종목 자동 정리 시작');
  const reasons: Array<{ ticker: string; reason: string }> = [];
  let removed = 0;
  let disabled = 0;

  // 추천 만료도 함께 처리 (LLM 무관)
  try {
    const recResult = expireStaleRecommendations();
    if (recResult.expired > 0 || recResult.purged > 0) {
      logger.info({ ...recResult }, '추천 만료 동시 처리');
    }
  } catch (err) {
    logger.error({ err }, 'expireStaleRecommendations failed');
  }

  // 규칙 1: 7일간 BUY 신호 없음 (v4.15.0: 3일→7일 — 시장 약세·LLM 장애 resilience)
  const noBuyItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.deleted_at IS NULL
      AND w.added_at <= datetime('now', '-7 days')
      AND EXISTS (
        SELECT 1 FROM trade_signals ts WHERE ts.stock_id = w.stock_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM trade_signals ts
        WHERE ts.stock_id = w.stock_id
          AND ts.signal_type = 'BUY'
          AND ts.created_at >= datetime('now', '-7 days')
      )
  `);

  const removedIds = new Set<number>();
  for (const item of noBuyItems) {
    if (isHoldingReal(item.stock_id)) continue;
    execute("UPDATE watchlist SET deleted_at = datetime('now') WHERE id = ?", [item.id]);
    removedIds.add(item.id);
    const reason = '7일간 매수 신호 없음';
    reasons.push({ ticker: item.ticker, reason });
    createNotification({
      type: 'WATCHLIST', title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: ${reason}`,
      ticker: item.ticker, actionUrl: '/watchlist',
    });
    removed++;
  }

  // 규칙 2: 최근 3개 신호 평균 신뢰도 40% 미만 → 자동매매 비활성화 (삭제 아님)
  const autoTradeItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.auto_trade_enabled = 1 AND w.deleted_at IS NULL
  `);

  for (const item of autoTradeItems) {
    const recentSignals = queryAll(
      'SELECT confidence FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 3',
      [item.stock_id],
    );
    if (recentSignals.length >= 3) {
      const avg = recentSignals.reduce((s: number, r: any) => s + Number(r.confidence), 0) / recentSignals.length;
      if (avg < 40) {
        execute('UPDATE watchlist SET auto_trade_enabled = 0 WHERE id = ?', [item.id]);
        createNotification({
          type: 'WATCHLIST', title: '자동매매 비활성화',
          message: `${item.ticker} ${item.name}: 최근 신뢰도 낮음 (평균 ${avg.toFixed(0)}%)`,
          ticker: item.ticker, actionUrl: '/watchlist',
        });
        disabled++;
      }
    }
  }

  // 규칙 3: 추천 저점수 (v4.15.0: 1일→3일 유예 + score < 40)
  const lowScoreItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name,
      (SELECT MAX(r.score) FROM recommendations r
       WHERE r.ticker = s.ticker
       ORDER BY r.created_at DESC LIMIT 1) AS latestScore
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.deleted_at IS NULL
      AND w.added_at <= datetime('now', '-3 days')
  `);

  for (const item of lowScoreItems) {
    if (removedIds.has(item.id)) continue;
    if (isHoldingReal(item.stock_id)) continue;
    // v4.17.1: 추천이 없는 종목(수동 관심 등록)은 이 규칙 대상 아님.
    // 기존은 null→0점으로 저점수 취급 → 수동 관심종목도 3일 후 전부 삭제되는 버그.
    if (item.latestScore == null) continue;
    const score = Number(item.latestScore);
    if (score >= 40) continue;
    execute("UPDATE watchlist SET deleted_at = datetime('now') WHERE id = ?", [item.id]);
    removedIds.add(item.id);
    const reason = `추천 점수 저조 (${score}점)`;
    reasons.push({ ticker: item.ticker, reason });
    createNotification({
      type: 'WATCHLIST', title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: ${reason}`,
      ticker: item.ticker, actionUrl: '/watchlist',
    });
    removed++;
  }

  // 규칙 4: 최근 5개 신호 평균 신뢰도 < 40% + 3일 유예 → 즉시 삭제 (v4.15.0: 1→3일)
  const lowConfidenceItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.deleted_at IS NULL
      AND w.added_at <= datetime('now', '-3 days')
  `);

  for (const item of lowConfidenceItems) {
    if (removedIds.has(item.id)) continue;
    if (isHoldingReal(item.stock_id)) continue;
    const recent = queryAll(
      'SELECT confidence FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 5',
      [item.stock_id],
    );
    if (recent.length < 5) continue;
    const avg = recent.reduce((s: number, r: any) => s + Number(r.confidence), 0) / recent.length;
    if (avg >= 40) continue;
    execute("UPDATE watchlist SET deleted_at = datetime('now') WHERE id = ?", [item.id]);
    removedIds.add(item.id);
    const reason = `평균 신뢰도 저하 (${avg.toFixed(0)}%)`;
    reasons.push({ ticker: item.ticker, reason });
    createNotification({
      type: 'WATCHLIST', title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: ${reason}`,
      ticker: item.ticker, actionUrl: '/watchlist',
    });
    removed++;
  }

  // 규칙 5: 최근 3개 신호가 모두 SELL/HOLD (BUY 없음) + 3일 유예 → 즉시 삭제 (v4.15.0: 1→3일)
  const noBuySignalItems = queryAll(`
    SELECT w.id, w.stock_id, s.ticker, s.name
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    WHERE w.deleted_at IS NULL
      AND w.added_at <= datetime('now', '-3 days')
  `);
  for (const item of noBuySignalItems) {
    if (removedIds.has(item.id)) continue;
    if (isHoldingReal(item.stock_id)) continue;
    const recent = queryAll(
      'SELECT signal_type FROM trade_signals WHERE stock_id = ? ORDER BY created_at DESC LIMIT 3',
      [item.stock_id],
    );
    if (recent.length < 3) continue;
    const hasBuy = recent.some((r: any) => r.signal_type === 'BUY');
    if (hasBuy) continue;
    execute("UPDATE watchlist SET deleted_at = datetime('now') WHERE id = ?", [item.id]);
    removedIds.add(item.id);
    const reason = '최근 3개 신호에 BUY 없음';
    reasons.push({ ticker: item.ticker, reason });
    createNotification({
      type: 'WATCHLIST', title: '관심종목 자동 제거',
      message: `${item.ticker} ${item.name}: ${reason}`,
      ticker: item.ticker, actionUrl: '/watchlist',
    });
    removed++;
  }

  logger.info(`[Scheduler] 관심종목 정리 완료: ${removed}개 제거, ${disabled}개 자동매매 비활성화`);
  return { removed, disabled, reasons };
}
