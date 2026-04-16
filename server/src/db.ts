/**
 * v4.6.0: Migrated from sql.js (Wasm + full-DB snapshot writes) to
 * better-sqlite3 (native bindings, real disk-backed SQLite).
 *
 * Why: sql.js held the entire database in memory and the previous code
 * called fs.writeFileSync(full-DB-export) on every single execute(). For a
 * 5MB database that meant tens of milliseconds of event-loop blocking per
 * INSERT, multiplied by 50–100 INSERTs per autotrade cycle. Pages froze
 * during scheduler ticks.
 *
 * better-sqlite3 writes directly to the existing .db file via the native
 * SQLite engine. The on-disk format is the same as sql.js, so the existing
 * stock-manager.db is opened in place with no migration step.
 *
 * The public API (initializeDB, getDB, queryAll, queryOne, execute,
 * withTransaction, saveDB, logAudit) is preserved so the 46+ files that
 * import these helpers do not need to change.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

function getDbPath(): string {
  // STOCK_MANAGER_DB_PATH allows tests to inject ':memory:' for an isolated
  // in-memory better-sqlite3 instance. Evaluated lazily so tests can set
  // the env var after this module has been imported.
  if (process.env.STOCK_MANAGER_DB_PATH) return process.env.STOCK_MANAGER_DB_PATH;
  const dataDir = process.env.STOCK_MANAGER_DATA || path.join(__dirname, '../../data');
  return path.join(dataDir, 'stock-manager.db');
}

type Db = Database.Database;
let db: Db;

// Statement cache (defined here so initializeDB can clear it on re-init)
const stmtCache = new Map<string, Database.Statement>();

// Compatibility shim: legacy code uses `db.run(sql)` directly inside this
// file (the schema/seed setup below). better-sqlite3 uses `db.exec(sql)`
// for raw multi-statement SQL or `db.prepare(sql).run(params)` for
// parameterized statements. We expose a tiny wrapper so the existing
// schema setup keeps working unchanged.
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
  // Skip directory creation when using in-memory mode (tests)
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  // Reset prepared-statement cache between initializeDB() calls (important
  // for tests that re-init the DB across describe blocks).
  stmtCache.clear();

  // WAL gives us crash-safe writes + concurrent reads. NORMAL synchronous
  // is the standard performance/safety trade-off; FULL is overkill on a
  // single-writer local app.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  legacyDb = makeLegacyFacade(db);

  // Below uses the legacy facade so the existing schema/seed code paths
  // continue to call `db.run(...)` unchanged.
  const dbRun = (sql: string, params?: unknown[]) => legacyDb.run(sql, params);

  dbRun('PRAGMA foreign_keys = ON');

  dbRun(`
    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      market TEXT DEFAULT '',
      sector TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  dbRun(`
    CREATE TABLE IF NOT EXISTS dividends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      date TEXT NOT NULL,
      memo TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

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

  // 추천 종목
  dbRun(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'KRX',
      source TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      signal_type TEXT CHECK(signal_type IN ('BUY', 'SELL', 'HOLD')),
      confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'EXECUTED', 'EXPIRED', 'DISMISSED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )
  `);

  // 매매 신호
  dbRun(`
    CREATE TABLE IF NOT EXISTS trade_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      signal_type TEXT NOT NULL CHECK(signal_type IN ('BUY', 'SELL', 'HOLD')),
      source TEXT DEFAULT '',
      confidence REAL DEFAULT 0,
      indicators_json TEXT DEFAULT '{}',
      llm_reasoning TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // 자동매매 기록
  dbRun(`
    CREATE TABLE IF NOT EXISTS auto_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      signal_id INTEGER,
      order_type TEXT NOT NULL CHECK(order_type IN ('BUY', 'SELL')),
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL DEFAULT 0,
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SUBMITTED', 'FILLED', 'FAILED', 'CANCELLED')),
      kis_order_no TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
      FOREIGN KEY (signal_id) REFERENCES trade_signals(id)
    )
  `);

  // 뉴스 캐시
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

  // 관심 종목
  dbRun(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL UNIQUE,
      market TEXT NOT NULL DEFAULT 'KRX',
      notes TEXT DEFAULT '',
      auto_trade_enabled INTEGER DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // 추천 종목 스코어링 이력
  dbRun(`
    CREATE TABLE IF NOT EXISTS recommendation_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'KRX',
      score_type TEXT NOT NULL,
      score_value REAL NOT NULL,
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // recommendations 테이블에 score 컬럼 추가 (이미 존재하면 무시)
  try { dbRun('ALTER TABLE recommendations ADD COLUMN score REAL DEFAULT 0'); } catch {}
  try { dbRun('ALTER TABLE recommendations ADD COLUMN consecutive_buys INTEGER DEFAULT 0'); } catch {}

  // trade_signals에 성과 추적 플래그
  try { dbRun('ALTER TABLE trade_signals ADD COLUMN performance_tracked INTEGER DEFAULT 0'); } catch {}

  // auto_trades에 분할 매수 단계
  try { dbRun('ALTER TABLE auto_trades ADD COLUMN split_stage INTEGER DEFAULT 0'); } catch {}

  // stocks에 DART 고유번호
  try { dbRun('ALTER TABLE stocks ADD COLUMN dart_code TEXT'); } catch {}

  // stocks에 카테고리/태그
  try { dbRun('ALTER TABLE stocks ADD COLUMN category TEXT DEFAULT ""'); } catch {}

  // recommendations에 카테고리
  try { dbRun('ALTER TABLE recommendations ADD COLUMN category TEXT DEFAULT ""'); } catch {}

  // 시스템 이벤트 로그 (에러, 미대응 상황, 후속조치 필요 기록)
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

  // 예약 주문 (목표가 도달 시 자동 실행)
  dbRun(`
    CREATE TABLE IF NOT EXISTS reserved_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      market TEXT NOT NULL,
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

  // DART 공시 캐시
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

  // 신호 성과 추적
  dbRun(`
    CREATE TABLE IF NOT EXISTS signal_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      stock_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'KRX',
      signal_type TEXT NOT NULL,
      signal_confidence REAL NOT NULL,
      signal_price REAL NOT NULL,
      target_price REAL,
      stop_loss_price REAL,
      price_7d REAL,
      price_14d REAL,
      price_30d REAL,
      return_7d REAL,
      return_14d REAL,
      return_30d REAL,
      target_hit INTEGER DEFAULT 0,
      stop_loss_hit INTEGER DEFAULT 0,
      key_factors_json TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      evaluated_at DATETIME,
      FOREIGN KEY (signal_id) REFERENCES trade_signals(id),
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE
    )
  `);

  // 가중치 최적화 로그
  dbRun(`
    CREATE TABLE IF NOT EXISTS weight_optimization_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      score_type TEXT NOT NULL,
      old_weight REAL NOT NULL,
      new_weight REAL NOT NULL,
      reason TEXT DEFAULT '',
      correlation REAL DEFAULT 0,
      sample_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 백테스트 결과
  dbRun(`
    CREATE TABLE IF NOT EXISTS backtest_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ticker TEXT,
      market TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      strategy_config_json TEXT NOT NULL,
      total_trades INTEGER DEFAULT 0,
      winning_trades INTEGER DEFAULT 0,
      losing_trades INTEGER DEFAULT 0,
      total_return REAL DEFAULT 0,
      max_drawdown REAL DEFAULT 0,
      sharpe_ratio REAL,
      win_rate REAL DEFAULT 0,
      avg_win REAL DEFAULT 0,
      avg_loss REAL DEFAULT 0,
      profit_factor REAL,
      results_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 주간 학습 리포트
  dbRun(`
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report TEXT NOT NULL,
      stats_json TEXT DEFAULT '{}',
      weight_changes_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 알림
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

  // 매매 원칙 (14가지 Trading Rules)
  dbRun(`
    CREATE TABLE IF NOT EXISTS trading_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT NOT NULL CHECK(category IN ('TIME', 'VOLUME', 'VOLATILITY', 'CANDLE', 'SUPPORT')),
      is_enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      params_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 14가지 매매 원칙 초기 데이터
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('MORNING_SURGE_SELL', '아침 폭등 → 절량 매도', '아침 폭등 시 보유 종목 절량 매도', 'TIME', 1, 1, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('AFTERNOON_SURGE_NO_BUY', '오후 폭등 → 추격 매수 금지', '오후 폭등 시 추격 매수 금지', 'TIME', 1, 2, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('MORNING_DROP_NO_SELL', '아침 폭락 → 매도 금지', '아침 폭락 시 선부른 매도 금지', 'TIME', 1, 3, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('AFTERNOON_DROP_BUY_OPPORTUNITY', '오후 폭락 → 매수 기회', '오후 폭락 시 익일 저가 매수 기회', 'TIME', 1, 4, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('OPEN_SURGE_NO_BUY', '개장 급등 → 매수 금지', '개장 직후 급등 시 충동 매수 금지', 'TIME', 1, 5, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('PRECLOSE_SURGE_PARTIAL_SELL', '마감 전 급등 → 일부 익절', '장 마감 전 급등 시 일부 익절', 'TIME', 1, 6, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('LOW_VOLUME_SURGE_BUY', '저점+거래량 급증 → 매수', '저점 + 거래량 급증 시 과감 매수', 'VOLUME', 1, 7, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('HIGH_VOLUME_SURGE_SELL', '고점+거래량 급증 → 매도', '고점 + 거래량 급증 시 신속 매도', 'VOLUME', 1, 8, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('LOW_LOW_VOLUME_HOLD', '저점+거래량 감소 → 관망', '저점 + 거래량 감소 시 관망', 'VOLUME', 1, 9, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('HIGH_LOW_VOLUME_WAIT', '고점+거래량 감소 → 대기', '고점 + 거래량 감소 시 대기', 'VOLUME', 1, 10, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('SIDEWAYS_NO_TRADE', '횡보장 → 거래 중단', '횡보장 시 거래 중단', 'VOLATILITY', 1, 11, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('CANDLE_BUY_FILTER', '캔들 매수 필터', '음봉 매수 고려, 양봉 매수 금지', 'CANDLE', 1, 12, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('CANDLE_SELL_FILTER', '캔들 매도 필터', '양봉 일부 매도, 음봉 매도 금지', 'CANDLE', 1, 13, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('SUPPORT_BREAK_STOP_LOSS', '지지선 이탈 → 손절', '지지선 이탈 시 손절 필수', 'SUPPORT', 1, 14, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('SECTOR_HEADWIND', '섹터 역풍 감점', '섹터 로테이션 OUT일 때 매수 신뢰도 -20', 'VOLATILITY', 1, 15, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('BREADTH_DIVERGENCE', '시장 건전성 경고', '지수 상승 중 참여 종목 감소 시 HOLD 전환', 'VOLATILITY', 1, 16, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('SECTOR_TAILWIND', '섹터 순풍 가점', '상위 3 섹터 매수 신뢰도 +15', 'VOLATILITY', 1, 17, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('NARROW_LEADERSHIP', '협소 리더십 경고', '소수 섹터만 상승 시 비주도 섹터 매수 -15', 'VOLATILITY', 1, 18, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('POOR_QUOTE_QUALITY', '호가 품질 경고', '스프레드 > 0.5% 또는 호가 깊이 부족 시 매수 신뢰도 -20', 'VOLUME', 1, 19, '{}')`);
  // v4.11.0: 신규 룰
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('SIGNAL_COOLDOWN', '신호 쿨다운', '같은 종목 최근 30분 내 동일 BUY 신호 반복 방지 — 신뢰도 -50, 필요 시 HOLD 전환', 'TIME', 1, 20, '{}')`);
  dbRun(`INSERT OR IGNORE INTO trading_rules (rule_id, name, description, category, is_enabled, priority, params_json) VALUES ('RECENT_LOSS_PENALTY', '반복 손실 종목 패널티', '최근 5건 중 2건 이상 손실 확정된 종목 — 신뢰도 -30, 3건 이상 시 HOLD 전환', 'VOLATILITY', 1, 21, '{}')`);

  // --- Indexes ---
  dbRun('CREATE INDEX IF NOT EXISTS idx_transactions_stock_id ON transactions(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_trade_signals_stock_id ON trade_signals(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_trade_signals_created_at ON trade_signals(created_at)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_auto_trades_stock_id ON auto_trades(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_auto_trades_created_at ON auto_trades(created_at)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_news_cache_ticker ON news_cache(ticker)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_recommendations_ticker ON recommendations(ticker)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_watchlist_stock_id ON watchlist(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_system_events_resolved ON system_events(resolved)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_signal_performance_signal_id ON signal_performance(signal_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_reserved_orders_status ON reserved_orders(status)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_dart_disclosures_ticker ON dart_disclosures(ticker)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_recommendation_scores_ticker ON recommendation_scores(ticker)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_trading_rules_rule_id ON trading_rules(rule_id)');

  // --- Audit log table ---
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

  // --- Soft delete columns ---
  try { dbRun('ALTER TABLE stocks ADD COLUMN deleted_at DATETIME'); } catch {}
  try { dbRun('ALTER TABLE transactions ADD COLUMN deleted_at DATETIME'); } catch {}
  try { dbRun('ALTER TABLE watchlist ADD COLUMN deleted_at DATETIME'); } catch {}
  try { dbRun('ALTER TABLE recommendations ADD COLUMN deleted_at DATETIME'); } catch {}

  // --- v4.14.0: TOP 50 경쟁 구도 — 연속 HOLD/SELL 카운터 ---
  try { dbRun('ALTER TABLE recommendations ADD COLUMN consecutive_holds INTEGER DEFAULT 0'); } catch {}
  try { dbRun('ALTER TABLE recommendations ADD COLUMN consecutive_sells INTEGER DEFAULT 0'); } catch {}

  // --- v4.10.0: Paper Trading (가상매매) 테이블 ---
  // 추천 BUY 신호가 발생했지만 실매매가 안 된 종목을 자동 가상 매수/매도하여
  // 학습 데이터로 활용. transactions/auto_trades와 분리되어 실 매매 평균단가를
  // 오염시키지 않음.
  dbRun(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_id INTEGER NOT NULL,
      signal_id INTEGER,
      recommendation_id INTEGER,
      order_type TEXT NOT NULL CHECK(order_type IN ('BUY', 'SELL')),
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      fee REAL DEFAULT 0,
      pair_id INTEGER,
      reason TEXT DEFAULT '',
      pnl REAL,
      pnl_percent REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stock_id) REFERENCES stocks(id) ON DELETE CASCADE,
      FOREIGN KEY (signal_id) REFERENCES trade_signals(id),
      FOREIGN KEY (recommendation_id) REFERENCES recommendations(id)
    )
  `);
  dbRun('CREATE INDEX IF NOT EXISTS idx_paper_trades_stock ON paper_trades(stock_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_paper_trades_pair ON paper_trades(pair_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_paper_trades_signal ON paper_trades(signal_id)');
  dbRun('CREATE INDEX IF NOT EXISTS idx_paper_trades_created ON paper_trades(created_at)');

  // signal_performance에 paper 구분 + 링크 컬럼 추가 (정확도 평가 시 합산용)
  try { dbRun('ALTER TABLE signal_performance ADD COLUMN is_paper INTEGER DEFAULT 0'); } catch {}
  try { dbRun('ALTER TABLE signal_performance ADD COLUMN paper_trade_id INTEGER'); } catch {}

  // --- v4.10.0: market 코드 정규화 마이그레이션 ---
  // 'NASD' → 'NASDAQ', 'NYS' → 'NYSE', 'NAS' → 'NASDAQ', 'AMS' → 'AMEX' 통일
  try { dbRun("UPDATE stocks SET market='NASDAQ' WHERE UPPER(market) IN ('NASD', 'NAS')"); } catch {}
  try { dbRun("UPDATE stocks SET market='NYSE' WHERE UPPER(market) IN ('NYS')"); } catch {}
  try { dbRun("UPDATE stocks SET market='AMEX' WHERE UPPER(market) IN ('AMS')"); } catch {}
  try { dbRun("UPDATE stocks SET market='KRX' WHERE UPPER(market) IN ('KOSPI', 'KOSDAQ')"); } catch {}

  // No saveDB() needed at the end of initializeDB — better-sqlite3 writes
  // changes directly to the on-disk file as they happen.
  return db;
}

/**
 * Wrap a synchronous function in a SQLite transaction.
 * better-sqlite3's `db.transaction(fn)` returns a function that, when called,
 * runs `fn` inside BEGIN/COMMIT/ROLLBACK on the underlying SQLite connection.
 */
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

/**
 * Legacy no-op kept for backwards compatibility with the 40+ files that call
 * saveDB() after every mutation. With better-sqlite3, every db.prepare().run()
 * already persists synchronously to the underlying .db file via the SQLite
 * engine — there is no in-memory image to flush.
 */
export function saveDB(): void {
  // Intentionally empty — better-sqlite3 writes are already on disk.
}

/**
 * Legacy no-op (same reason as saveDB). Retained because some external
 * callers (NAS sync, graceful shutdown) explicitly demand a sync barrier.
 * better-sqlite3 honours WAL checkpoint via close()/pragma.
 */
export function flushDBSync(): void {
  if (!db) return;
  // Optional: force a WAL checkpoint so the .db file is consistent on disk.
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // ignore — pragma may fail under unusual states
  }
}

/** Test helper: dirty state has no meaning under direct-write better-sqlite3. */
export function _isDirty(): boolean {
  return false;
}

export function getDB(): Db {
  return db;
}

// ── Statement cache ──────────────────────────────────────────
// better-sqlite3's prepared statements are reusable. Caching them by SQL
// text gives a measurable speedup for hot paths (the same INSERT is fired
// hundreds of times per autotrade cycle). The Map itself is declared near
// the top of the file so initializeDB() can clear it on re-init.
function getStmt(sql: string): Database.Statement {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

// 헬퍼: SELECT 쿼리 (결과 배열 반환)
// Return type is `any[]` to preserve compatibility with the legacy sql.js
// helpers that the rest of the codebase relies on. Migrating to typed rows
// is a separate refactor.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = getStmt(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return stmt.all(...(params as any[])) as any[];
}

// 헬퍼: 단일 행 반환
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function queryOne(sql: string, params: any[] = []): any | null {
  const stmt = getStmt(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = stmt.get(...(params as any[]));
  return row ?? null;
}

// 헬퍼: INSERT/UPDATE/DELETE 실행
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function execute(sql: string, params: any[] = []): { changes: number; lastId: number } {
  const stmt = getStmt(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = stmt.run(...(params as any[]));
  return {
    changes: info.changes,
    lastId: Number(info.lastInsertRowid),
  };
}
