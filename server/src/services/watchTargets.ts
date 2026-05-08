/**
 * Watch Targets — 자동/수동 통합 감시대상.
 *
 * source='auto'  : autoListBuilder가 매일 아침 섹터 로테이션 기반으로 채움.
 *                  expires_at 24h, 다음날 새 빌드에서 갱신/제거.
 * source='manual': 사용자가 직접 추가. expires_at NULL = 영구.
 *
 * 매매 전략(dailyStrategy)은 source 구분 없이 ACTIVE 항목 모두 동일하게 처리.
 */

import { queryAll, queryOne, execute, withTransaction } from '../db';
import logger from '../logger';

export interface WatchTarget {
  id: number;
  stockId: number;
  ticker: string;
  name: string;
  sector: string;
  source: 'auto' | 'manual';
  category: string;
  reason: string;
  addedAt: string;
  expiresAt: string | null;
}

interface WatchTargetRow {
  id: number;
  stock_id: number;
  ticker: string;
  name: string;
  sector: string;
  source: 'auto' | 'manual';
  category: string;
  reason: string;
  added_at: string;
  expires_at: string | null;
}

function rowToTarget(row: WatchTargetRow): WatchTarget {
  return {
    id: row.id,
    stockId: row.stock_id,
    ticker: row.ticker,
    name: row.name,
    sector: row.sector,
    source: row.source,
    category: row.category,
    reason: row.reason,
    addedAt: row.added_at,
    expiresAt: row.expires_at,
  };
}

const ACTIVE_WHERE = `wt.deleted_at IS NULL
   AND (wt.expires_at IS NULL OR datetime(wt.expires_at) > datetime('now'))`;

/** 활성 감시대상 전체 조회 */
export function listActive(source?: 'auto' | 'manual'): WatchTarget[] {
  const params: unknown[] = [];
  let sql = `
    SELECT wt.id, wt.stock_id, s.ticker, s.name, s.sector,
           wt.source, wt.category, wt.reason, wt.added_at, wt.expires_at
    FROM watch_targets wt
    JOIN stocks s ON s.id = wt.stock_id
    WHERE ${ACTIVE_WHERE}
  `;
  if (source) {
    sql += ' AND wt.source = ?';
    params.push(source);
  }
  sql += ' ORDER BY wt.added_at DESC';
  const rows = queryAll<WatchTargetRow>(sql, params);
  return rows.map(rowToTarget);
}

/** stock_id로 활성 감시대상 조회 (없으면 null) */
export function findByStockId(stockId: number): WatchTarget | null {
  const row = queryOne<WatchTargetRow>(
    `SELECT wt.id, wt.stock_id, s.ticker, s.name, s.sector,
            wt.source, wt.category, wt.reason, wt.added_at, wt.expires_at
     FROM watch_targets wt
     JOIN stocks s ON s.id = wt.stock_id
     WHERE wt.stock_id = ? AND ${ACTIVE_WHERE}`,
    [stockId],
  );
  return row ? rowToTarget(row) : null;
}

/** ticker로 stock_id 찾고, 없으면 stocks 테이블에 신규 등록 */
function ensureStock(ticker: string, name: string, sector: string = ''): number {
  const existing = queryOne<{ id: number }>(
    'SELECT id FROM stocks WHERE ticker = ? AND deleted_at IS NULL',
    [ticker],
  );
  if (existing) return existing.id;

  execute(
    'INSERT INTO stocks (ticker, name, market, sector) VALUES (?, ?, ?, ?)',
    [ticker, name, 'KRX', sector],
  );
  const inserted = queryOne<{ id: number }>('SELECT id FROM stocks WHERE ticker = ?', [ticker]);
  if (!inserted) throw new Error(`stock insert failed: ${ticker}`);
  return inserted.id;
}

/** 감시대상 추가 (수동/자동 공통). 동일 stock_id가 활성 상태면 source 변경/reason 갱신. */
export function upsert(args: {
  ticker: string;
  name: string;
  sector?: string;
  source: 'auto' | 'manual';
  category?: string;
  reason?: string;
  expiresAt?: string | null;
}): WatchTarget {
  const { ticker, name, sector = '', source, category = '', reason = '', expiresAt = null } = args;

  return withTransaction(() => {
    const stockId = ensureStock(ticker, name, sector);

    const existing = queryOne<WatchTargetRow>(
      `SELECT * FROM watch_targets WHERE stock_id = ? AND deleted_at IS NULL`,
      [stockId],
    );

    if (existing) {
      // 수동이 자동을 덮어쓰는 경우만 source 승격 (수동 우선)
      const newSource = existing.source === 'manual' ? 'manual' : source;
      execute(
        `UPDATE watch_targets
           SET source = ?, category = ?, reason = ?, expires_at = ?
         WHERE id = ?`,
        [newSource, category, reason, expiresAt, existing.id],
      );
      const refreshed = findByStockId(stockId);
      if (!refreshed) throw new Error('upsert refresh failed');
      return refreshed;
    }

    // active row 가 없는데 같은 stock_id 의 soft-deleted row 가 남아 있으면
    // UNIQUE(stock_id) 제약으로 INSERT 가 실패한다. 좀비 row 정리 후 신규 등록.
    execute(`DELETE FROM watch_targets WHERE stock_id = ?`, [stockId]);

    execute(
      `INSERT INTO watch_targets (stock_id, source, category, reason, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [stockId, source, category, reason, expiresAt],
    );
    const created = findByStockId(stockId);
    if (!created) throw new Error('upsert failed');
    return created;
  });
}

/** 감시대상 제거 (soft delete) */
export function remove(id: number): boolean {
  const result = execute(
    `UPDATE watch_targets SET deleted_at = datetime('now') WHERE id = ?`,
    [id],
  );
  return result.changes > 0;
}

/** 만료된 자동목록 정리 (expires_at < now AND source='auto').
 *  hard delete — UNIQUE(stock_id) 충돌 방지를 위해 좀비 row 를 남기지 않는다. */
export function purgeExpiredAuto(): number {
  const result = execute(
    `DELETE FROM watch_targets
     WHERE source = 'auto'
       AND expires_at IS NOT NULL
       AND datetime(expires_at) <= datetime('now')`,
  );
  if (result.changes > 0) {
    logger.info({ count: result.changes }, 'auto watch_targets expired');
  }
  return result.changes;
}

/** 자동목록 전체 교체 (autoListBuilder 호출 직전에 호출).
 *  기존 auto 항목 모두 soft delete → 새 항목 insert. manual은 보존. */
export function replaceAutoList(items: Array<{
  ticker: string;
  name: string;
  sector?: string;
  category?: string;
  reason?: string;
  expiresAt: string; // ISO datetime, 보통 다음날 09:00
}>): number {
  return withTransaction(() => {
    // 기존 auto 항목 hard delete.
    // watch_targets.stock_id 에 UNIQUE 제약이 걸려 있어 soft delete 만으로는
    // 같은 stock_id 재삽입이 UNIQUE constraint failed 로 막힌다. manual 은 보존.
    execute(`DELETE FROM watch_targets WHERE source = 'auto'`);

    let inserted = 0;
    for (const item of items) {
      try {
        const stockId = ensureStock(item.ticker, item.name, item.sector ?? '');
        // manual이 이미 있으면 자동으로 덮지 않음
        const existingManual = queryOne<{ id: number }>(
          `SELECT id FROM watch_targets
           WHERE stock_id = ? AND source = 'manual' AND deleted_at IS NULL`,
          [stockId],
        );
        if (existingManual) continue;

        execute(
          `INSERT INTO watch_targets (stock_id, source, category, reason, expires_at)
           VALUES (?, 'auto', ?, ?, ?)`,
          [stockId, item.category ?? '', item.reason ?? '', item.expiresAt],
        );
        inserted++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, ticker: item.ticker }, 'replaceAutoList item failed');
      }
    }
    logger.info({ inserted }, 'auto watch_targets replaced');
    return inserted;
  });
}
