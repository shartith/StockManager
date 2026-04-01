import initSqlJs from 'sql.js';
type SqlJsDatabase = any;
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.STOCK_MANAGER_DATA || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'stock-manager.db');

let db: SqlJsDatabase;

export async function initializeDB(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      market TEXT DEFAULT '',
      sector TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
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

  db.run(`
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

  db.run(`
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
  db.run(`
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
  db.run(`
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
  db.run(`
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
  db.run(`
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
  db.run(`
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
  db.run(`
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
  try { db.run('ALTER TABLE recommendations ADD COLUMN score REAL DEFAULT 0'); } catch {}
  try { db.run('ALTER TABLE recommendations ADD COLUMN consecutive_buys INTEGER DEFAULT 0'); } catch {}

  // trade_signals에 성과 추적 플래그
  try { db.run('ALTER TABLE trade_signals ADD COLUMN performance_tracked INTEGER DEFAULT 0'); } catch {}

  // 신호 성과 추적
  db.run(`
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
  db.run(`
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
  db.run(`
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

  // 알림
  db.run(`
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

  saveDB();
  return db;
}

export function saveDB() {
  if (!db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

export function getDB(): SqlJsDatabase {
  return db;
}

// 헬퍼: SELECT 쿼리 (결과 배열 반환)
export function queryAll(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// 헬퍼: 단일 행 반환
export function queryOne(sql: string, params: any[] = []): any | null {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// 헬퍼: INSERT/UPDATE/DELETE 실행
export function execute(sql: string, params: any[] = []): { changes: number; lastId: number } {
  db.run(sql, params);
  const changes = db.getRowsModified();
  const lastIdRow = queryOne('SELECT last_insert_rowid() as id');
  saveDB();
  return { changes, lastId: lastIdRow?.id ?? 0 };
}
