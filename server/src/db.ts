/**
 * v5.0.0: 심플 매매 전략으로 전환. 학습 인프라 (paper_trades / signal_performance /
 * trade_signals / recommendation_scores / weight_optimization_log /
 * weekly_reports / backtest_results / trading_rules) 전체 제거.
 * 추천 + 관심 → 단일 watch_targets 테이블로 통합.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

function getDbPath(): string {
  if (process.env.STOCK_MANAGER_DB_PATH) return process.env.STOCK_MANAGER_DB_PATH;
  const dataDir = process.env.STOCK_MANAGER_DATA || path.join(__dirname, '../../data');
  return path.join(dataDir, 'stock-manager.db');
}

type Db = Database.Database;
let db: Db;

const stmtCache = new Map<string, Database.Statement>();

interface LegacyRunFacade {
  run(sql: string, params?: unknown[]): void;
}

function makeLegacyFacade(database: Db): LegacyRunFacade {
  return {
    run(sql: string, params?: unknown[]): void {
      if (params && params.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        database.prepare(sql).run(...(params as any[]));
      } else {
        database.exec(sql);
      }
    },
  };
}

let legacyDb: LegacyRunFacade;

export async function initializeDB(): Promise<Db> {
  const dbPath = getDbPath();
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  stmtCache.clear();

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  legacyDb = makeLegacyFacade(db);
  const dbRun = (sql: string, params?: unknown[]) => legacyDb.run(sql, params);

  dbRun('PRAGMA foreign_keys = ON');

  // ── Core: 종목 + 거래 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      market TEXT DEFAULT 'KRX',
      sector TEXT DEFAULT '',
      category TEXT DEFAULT '',
      dart_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME
    )
  `);

  dbRun(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('BUY', 'SELL')),
      quantity REAL NOT NULL CHECK(quantity > 0),
      price REAL NOT NULL CHECK(price >= 0),
      fee REAL DEFAULT 0,
      date TEXT NOT NULL,
      memo TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── Watch targets: auto + manual 통합 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS watch_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source IN ('auto', 'manual')),
      category TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      deleted_at DATETIME,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── 자동매매 기록 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS auto_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      order_type TEXT NOT NULL CHECK(order_type IN ('BUY', 'SELL')),
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SUBMITTED', 'FILLED', 'FAILED', 'CANCELLED')),
      kis_order_no TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      failure_reason TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── 예약 주문 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS reserved_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'KRX',
      order_type TEXT NOT NULL CHECK(order_type IN ('BUY', 'SELL')),
      target_price REAL NOT NULL,
      condition TEXT NOT NULL CHECK(condition IN ('BELOW', 'ABOVE')),
      quantity INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'EXECUTED', 'CANCELLED', 'EXPIRED')),
      reason TEXT DEFAULT '',
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── 알림 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT DEFAULT '',
      ticker TEXT DEFAULT '',
      market TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0,
      action_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── 시스템 이벤트 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT DEFAULT '',
      ticker TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      resolved_at DATETIME,
      resolution TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── DART 공시 캐시 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS dart_disclosures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER,
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      report_date TEXT NOT NULL,
      disclosure_type TEXT DEFAULT '',
      url TEXT DEFAULT '',
      is_important INTEGER DEFAULT 0,
      notified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── 뉴스 캐시 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS news_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      source_url TEXT DEFAULT '',
      sentiment TEXT DEFAULT '' CHECK(sentiment IN ('', 'POSITIVE', 'NEGATIVE', 'NEUTRAL')),
      ai_summary TEXT DEFAULT '',
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── 가격 알림 ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('PRICE_ABOVE', 'PRICE_BELOW', 'PROFIT_TARGET')),
      value REAL NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── Intraday strategy state (v5.1.0) ──
  // dailyStrategy의 in-memory 상태를 영구화: 시초가 baseline, 트레일링 high water mark,
  // 당일 매수 여부, 매도 후 cooldown용 시각.
  dbRun(`
    CREATE TABLE IF NOT EXISTS intraday_state (
      stock_id INTEGER PRIMARY KEY,
      opening_price REAL,
      peak_price REAL,
      bought_today INTEGER DEFAULT 0,
      trailing_active INTEGER DEFAULT 0,
      last_sell_at DATETIME,
      trade_date TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // ── Audit log ──
  dbRun(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL CHECK(action IN ('CREATE', 'UPDATE', 'DELETE', 'RESTORE')),
      old_value TEXT,
      new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Indexes ──
  dbRun('CREATE INDEX IF NOT EXISTS idx_transactions_stock_id ON transactions(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_auto_trades_stock_id ON auto_trades(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_auto_trades_created_at ON auto_trades(created_at)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_news_cache_ticker ON news_cache(ticker)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_watch_targets_source ON watch_targets(source)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_watch_targets_stock ON watch_targets(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_system_events_resolved ON system_events(resolved)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_reserved_orders_status ON reserved_orders(status)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_dart_disclosures_ticker ON dart_disclosures(ticker)');

  // ── v5.0.0 마이그레이션: 학습 인프라 + 분리된 추천/관심 테이블 → watch_targets 통합 ──

  // 1) 기존 watchlist 데이터를 watch_targets(manual)로 이관 (있으면)
  try {
    dbRun(`
      INSERT OR IGNORE INTO watch_targets (stock_id, source, reason, added_at)
      SELECT stock_id, 'manual', COALESCE(notes, ''), added_at
      FROM watchlist
      WHERE deleted_at IS NULL
    `);
  } catch {}

  // 2) 학습/구버전/배당 테이블 일괄 제거
  for (const t of [
    'paper_trades',
    'signal_performance',
    'trade_signals',
    'recommendation_scores',
    'recommendations',
    'watchlist',
    'weight_optimization_log',
    'weekly_reports',
    'backtest_results',
    'trading_rules',
    'dividends',
  ]) {
    try { dbRun(`DROP TABLE IF EXISTS ${t}`); } catch {}
  }

  // 3) market 코드 정규화 (KRX 단일)
  try { dbRun("UPDATE stocks SET market='KRX' WHERE UPPER(market) IN ('KOSPI', 'KOSDAQ')"); } catch {}
  try { dbRun("DELETE FROM stocks WHERE UPPER(market) IN ('NYSE', 'NASDAQ', 'NASD', 'NYS', 'AMEX', 'AMS')"); } catch {}

  return db;
}

export function getDB(): Db {
  if (!db) throw new Error('DB not initialized');
  return db;
}

function getStmt(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

export function queryAll<T = Record<string, any>>(sql: string, params: unknown[] = []): T[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getStmt(sql).all(...(params as any[])) as T[];
}

export function queryOne<T = Record<string, any>>(sql: string, params: unknown[] = []): T | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = getStmt(sql).get(...(params as any[])) as T | undefined;
  return row ?? null;
}

export function execute(sql: string, params: unknown[] = []): { lastId: number; changes: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = getStmt(sql).run(...(params as any[]));
  return { lastId: Number(info.lastInsertRowid), changes: info.changes };
}

export function withTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

export function logAudit(entityType: string, entityId: number | null, action: string, oldValue?: unknown, newValue?: unknown): void {
  db.prepare(
    'INSERT INTO audit_log (entity_type, entity_id, action, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
  ).run(
    entityType,
    entityId,
    action,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
  );
}

// Backwards-compat: kept for legacy callers; better-sqlite3 persists immediately.
export function saveDB(): void {
  // no-op
}
