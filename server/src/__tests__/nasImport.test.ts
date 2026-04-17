/**
 * nasImport.ts — 양방향 NAS sync (jsonl → DB) MVP 테스트
 *
 * 임시 디렉토리에 `device-XXX / 날짜폴더 / 테이블.jsonl` 구조를 seed하고
 * runNasImport 호출 후 DB 상태 검증. 자기 디바이스 제외, opt-in 플래그,
 * id 충돌 회피, last_import.json 기록을 커버.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.STOCK_MANAGER_DB_PATH = ':memory:';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(),
}));

vi.mock('../services/systemEvent', () => ({
  logSystemEvent: vi.fn().mockResolvedValue(1),
}));

import { initializeDB, execute, queryAll, queryOne } from '../db';
import { runNasImport } from '../services/nasImport';
import { getSettings } from '../services/settings';

// ─── 헬퍼 ─────────────────────────────────────────────

let tmpRoot: string;

function makeTmpNasRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nasImport-test-'));
}

function rmTmp(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function writeJsonl(dir: string, table: string, rows: any[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const content = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${table}.jsonl`), content, 'utf-8');
}

function setSettings(overrides: any = {}): void {
  vi.mocked(getSettings).mockReturnValue({
    nasSyncEnabled: true,
    nasSyncPath: tmpRoot,
    nasImportEnabled: true,
    ...overrides,
  } as any);
}

// ─── 테스트 ────────────────────────────────────────────

describe('runNasImport (UC-08 확장: 양방향 sync)', () => {
  beforeAll(async () => {
    await initializeDB();
    execute('PRAGMA foreign_keys = OFF');
    // transactions에 stock_id FK가 있으나 OFF로 했으니 임의 값 허용
  });

  beforeEach(() => {
    tmpRoot = makeTmpNasRoot();
    execute('DELETE FROM transactions');
    execute('DELETE FROM auto_trades');
    execute('DELETE FROM trade_signals');
    execute('DELETE FROM system_events');
    execute('DELETE FROM audit_log');
    execute('DELETE FROM weekly_reports');
    execute('DELETE FROM backtest_results');
    execute('DELETE FROM weight_optimization_log');
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmTmp(tmpRoot);
  });

  // ─── Opt-in 가드 ───

  describe('opt-in 플래그', () => {
    it('nasSyncEnabled=false → skip', async () => {
      setSettings({ nasSyncEnabled: false });
      const r = await runNasImport();
      expect(r.devicesProcessed).toBe(0);
      expect(r.skipped[0]).toContain('NAS sync 미활성화');
    });

    it('nasImportEnabled=false(기본) → skip', async () => {
      setSettings({ nasImportEnabled: false });
      const r = await runNasImport();
      expect(r.devicesProcessed).toBe(0);
      expect(r.skipped[0]).toContain('nasImportEnabled=false');
    });

    it('경로 미존재 → skip', async () => {
      setSettings({ nasSyncPath: '/nonexistent/path/nas' });
      const r = await runNasImport();
      expect(r.skipped.length).toBeGreaterThan(0);
      expect(r.devicesProcessed).toBe(0);
    });
  });

  // ─── 기본 import ───

  describe('jsonl → DB import', () => {
    it('다른 디바이스의 transactions 레코드 import', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-other-laptop');
      const dateDir = path.join(deviceDir, '2026-04-15');
      writeJsonl(dateDir, 'transactions', [
        { id: 1, stock_id: 100, type: 'BUY', quantity: 10, price: 5000, fee: 5, date: '2026-04-15', memo: 'imported', created_at: '2026-04-15 10:00:00' },
        { id: 2, stock_id: 101, type: 'SELL', quantity: 5, price: 5500, fee: 3, date: '2026-04-15', memo: 'imported', created_at: '2026-04-15 11:00:00' },
      ]);

      const r = await runNasImport();

      expect(r.devicesProcessed).toBe(1);
      expect(r.recordsImported).toBe(2);

      const rows = queryAll('SELECT * FROM transactions ORDER BY created_at');
      expect(rows.length).toBe(2);
      expect(rows[0].memo).toBe('imported');
    });

    it('id 컬럼은 제외하고 INSERT (자기 DB가 재할당)', async () => {
      setSettings();
      // 내 DB에 이미 id=1 레코드 존재
      execute(
        `INSERT INTO transactions (stock_id, type, quantity, price, fee, date, memo, created_at)
         VALUES (500, 'BUY', 1, 100, 0, '2026-04-10', 'local', datetime('now', '-10 days'))`
      );
      const mineBefore = queryOne('SELECT id FROM transactions WHERE memo = ?', ['local']);

      // 다른 디바이스가 id=1을 쓰는 레코드 보냄 — 충돌이 아닌 새 id로 재할당되어야 함
      const deviceDir = path.join(tmpRoot, 'device-other');
      writeJsonl(path.join(deviceDir, '2026-04-15'), 'transactions', [
        { id: 1, stock_id: 600, type: 'BUY', quantity: 2, price: 200, fee: 0, date: '2026-04-15', memo: 'imported', created_at: '2026-04-15 12:00:00' },
      ]);

      const r = await runNasImport();

      expect(r.recordsImported).toBe(1);

      // 내 기존 레코드와 imported 레코드 모두 살아있어야
      const rows = queryAll('SELECT memo FROM transactions ORDER BY id');
      expect(rows.length).toBe(2);
      expect(rows.map(x => x.memo).sort()).toEqual(['imported', 'local']);
    });

    it('자기 디바이스 폴더(device-{hostname})는 제외', async () => {
      setSettings();
      const myDir = path.join(tmpRoot, `device-${os.hostname()}`);
      writeJsonl(path.join(myDir, '2026-04-15'), 'transactions', [
        { id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'self', created_at: '2026-04-15 10:00:00' },
      ]);

      const r = await runNasImport();

      expect(r.devicesProcessed).toBe(0);
      expect(r.recordsImported).toBe(0);
      expect(queryAll('SELECT * FROM transactions').length).toBe(0);
    });

    it('여러 테이블 동시 import', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-analyst-pc');
      const dateDir = path.join(deviceDir, '2026-04-15');

      writeJsonl(dateDir, 'transactions', [
        { id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'tx', created_at: '2026-04-15 10:00:00' },
      ]);
      writeJsonl(dateDir, 'backtest_results', [
        { id: 1, name: 'bt-1', ticker: '005930', market: 'KRX', start_date: '2026-01-01', end_date: '2026-04-01', strategy_config_json: '{}', total_trades: 15, winning_trades: 10, losing_trades: 5, total_return: 8.5, max_drawdown: 3.2, sharpe_ratio: 1.5, win_rate: 66, avg_win: 1000, avg_loss: 500, profit_factor: 1.8, results_json: '[]', created_at: '2026-04-15 11:00:00' },
      ]);
      writeJsonl(dateDir, 'weekly_reports', [
        { id: 1, report: '주간 리포트 import 테스트', stats_json: '{}', weight_changes_json: null, created_at: '2026-04-15 12:00:00' },
      ]);

      const r = await runNasImport();

      expect(r.recordsImported).toBe(3);
      expect(queryAll('SELECT * FROM transactions').length).toBe(1);
      expect(queryAll('SELECT * FROM backtest_results').length).toBe(1);
      expect(queryAll('SELECT * FROM weekly_reports').length).toBe(1);
    });

    it('여러 날짜 폴더 순차 처리', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-x');
      writeJsonl(path.join(deviceDir, '2026-04-10'), 'trade_signals', [
        { id: 1, stock_id: 1, signal_type: 'BUY', source: 'llm', confidence: 70, indicators_json: '{}', llm_reasoning: 'early', created_at: '2026-04-10 10:00:00' },
      ]);
      writeJsonl(path.join(deviceDir, '2026-04-15'), 'trade_signals', [
        { id: 2, stock_id: 2, signal_type: 'SELL', source: 'llm', confidence: 60, indicators_json: '{}', llm_reasoning: 'later', created_at: '2026-04-15 10:00:00' },
      ]);

      const r = await runNasImport();

      expect(r.recordsImported).toBe(2);
      const rows = queryAll('SELECT llm_reasoning FROM trade_signals ORDER BY created_at');
      expect(rows[0].llm_reasoning).toBe('early');
      expect(rows[1].llm_reasoning).toBe('later');
    });
  });

  // ─── 중복 방지 ───

  describe('중복 방지 (last_import.json)', () => {
    it('첫 import 후 last_import.json 기록됨', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-first');
      writeJsonl(path.join(deviceDir, '2026-04-15'), 'transactions', [
        { id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'first', created_at: '2026-04-15 10:00:00' },
      ]);

      await runNasImport();

      const lastImportPath = path.join(deviceDir, 'last_import.json');
      expect(fs.existsSync(lastImportPath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(lastImportPath, 'utf-8'));
      expect(state.lastImportedAt).toBeTruthy();
      expect(state.recordsByTable.transactions).toBe(1);
    });

    it('재실행 시 이미 import된 레코드는 다시 삽입 안 함', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-dup');
      const dateDir = path.join(deviceDir, '2026-04-15');
      writeJsonl(dateDir, 'transactions', [
        { id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'dup', created_at: '2026-04-15 10:00:00' },
      ]);

      const first = await runNasImport();
      expect(first.recordsImported).toBe(1);

      // 재실행
      const second = await runNasImport();
      expect(second.recordsImported).toBe(0);

      const rows = queryAll('SELECT * FROM transactions WHERE memo = ?', ['dup']);
      expect(rows.length).toBe(1);
    });

    it('새 레코드 추가 후 재실행 시 신규만 import', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-incr');
      writeJsonl(path.join(deviceDir, '2026-04-15'), 'transactions', [
        { id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'day1', created_at: '2026-04-15 10:00:00' },
      ]);

      await runNasImport(); // 1건 import

      // 새 날짜 폴더에 레코드 추가
      writeJsonl(path.join(deviceDir, '2026-04-16'), 'transactions', [
        { id: 2, stock_id: 2, type: 'SELL', quantity: 1, price: 200, fee: 0, date: '2026-04-16', memo: 'day2', created_at: '2026-04-16 10:00:00' },
      ]);

      const r = await runNasImport();
      expect(r.recordsImported).toBe(1);

      const memos = queryAll('SELECT memo FROM transactions ORDER BY created_at').map(x => x.memo);
      expect(memos).toEqual(['day1', 'day2']);
    });
  });

  // ─── 에러 처리 ───

  describe('에러 처리', () => {
    it('malformed jsonl line은 skip (다른 줄은 처리)', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-bad');
      const dateDir = path.join(deviceDir, '2026-04-15');
      fs.mkdirSync(dateDir, { recursive: true });
      fs.writeFileSync(
        path.join(dateDir, 'transactions.jsonl'),
        [
          JSON.stringify({ id: 1, stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'good', created_at: '2026-04-15 10:00:00' }),
          'NOT_JSON_GARBAGE',
          JSON.stringify({ id: 2, stock_id: 2, type: 'SELL', quantity: 1, price: 200, fee: 0, date: '2026-04-15', memo: 'also good', created_at: '2026-04-15 11:00:00' }),
        ].join('\n'),
        'utf-8'
      );

      const r = await runNasImport();
      expect(r.recordsImported).toBe(2);
    });

    it('스키마에 없는 컬럼은 행 단위 skip (에러로 중단 안 함)', async () => {
      setSettings();
      const deviceDir = path.join(tmpRoot, 'device-schema');
      writeJsonl(path.join(deviceDir, '2026-04-15'), 'transactions', [
        { id: 1, nonexistent_col: 'X', stock_id: 1, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'bad-col', created_at: '2026-04-15 10:00:00' },
        { id: 2, stock_id: 2, type: 'BUY', quantity: 1, price: 100, fee: 0, date: '2026-04-15', memo: 'ok', created_at: '2026-04-15 11:00:00' },
      ]);

      const r = await runNasImport();
      // 첫 행은 스키마 불일치로 skip, 두 번째는 성공
      expect(r.recordsImported).toBe(1);
    });
  });
});
