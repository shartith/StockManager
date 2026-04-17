/**
 * v4.19.0: NAS 양방향 동기화 — jsonl → DB import (MVP)
 *
 * 기존 nasSync.ts는 export-only (DB → jsonl). 이 모듈은 **다른 디바이스가**
 * NAS에 올린 jsonl을 자기 DB로 가져온다.
 *
 * ── MVP 설계 ────────────────────────────────────────────
 *
 * 1. 대상: append-only 테이블 8종. 상태 테이블(recommendations/watchlist/stocks)은
 *    UPDATE/DELETE 충돌 해결이 필요해 MVP에서 제외.
 *
 * 2. ID 충돌: 다른 디바이스의 id가 내 DB와 겹칠 수 있음 → **id 컬럼 제외하고 INSERT**.
 *    내 DB가 AUTOINCREMENT로 새 id 할당. 참조 무결성(예: signal_performance.signal_id)이
 *    깨지는 테이블은 제외.
 *
 * 3. 중복 방지: `last_import.json`에 "이 디바이스로부터 마지막 import 시점" 기록.
 *    `created_at > lastImportedAt`인 레코드만 처리. idempotent 보장은 아니지만
 *    (같은 시각 레코드 경계) MVP로 충분.
 *
 * 4. 자기 디바이스 제외: `device-{hostname}` 폴더는 자기 DB의 원본이므로 skip.
 *
 * ── 제외 대상 ────────────────────────────────────────────
 *  - signal_performance: signal_id FK 맵핑 복잡
 *  - recommendations/watchlist/stocks: 상태 테이블 충돌 해결 미구현
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger';
import { execute } from '../db';
import { getSettings } from './settings';
import { logSystemEvent } from './systemEvent';

/** Import 대상 테이블 목록. id 컬럼 제외 + created_at 기준 필터. */
const IMPORT_TABLES = [
  'transactions',
  'auto_trades',
  'trade_signals',
  'system_events',
  'audit_log',
  'weekly_reports',
  'backtest_results',
  'weight_optimization_log',
] as const;

type ImportTable = typeof IMPORT_TABLES[number];

interface DeviceImportState {
  lastImportedAt: string; // ISO 또는 SQLite datetime 문자열
  recordsByTable: Record<string, number>;
}

export interface ImportResult {
  devicesProcessed: number;
  recordsImported: number;
  perDevice: Array<{ device: string; records: number; perTable: Record<string, number> }>;
  skipped: string[]; // skip 사유
}

/** 이 디바이스의 hostname (자기 데이터 폴더 제외용). */
function thisDeviceFolderName(): string {
  return `device-${os.hostname()}`;
}

/** 디바이스 폴더 목록을 stock-data에서 스캔. 자기 자신 제외. */
function discoverDeviceFolders(nasRoot: string): string[] {
  if (!fs.existsSync(nasRoot)) return [];
  const me = thisDeviceFolderName();
  return fs
    .readdirSync(nasRoot)
    .filter(name => name.startsWith('device-') && name !== me)
    .map(name => path.join(nasRoot, name))
    .filter(p => fs.statSync(p).isDirectory());
}

/** 해당 디바이스로부터 last import 시점 조회. */
function getLastImportedAt(deviceDir: string): string | null {
  const p = path.join(deviceDir, 'last_import.json');
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.lastImportedAt || null;
    }
  } catch {}
  return null;
}

function setLastImportedAt(deviceDir: string, state: DeviceImportState): void {
  const p = path.join(deviceDir, 'last_import.json');
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
}

/** 하나의 jsonl 파일을 import. id 컬럼 제외하고 INSERT.
 *  @returns 실제 insert된 레코드 수 */
function importTableFile(
  tableName: ImportTable,
  jsonlPath: string,
  sinceTimestamp: string | null
): number {
  if (!fs.existsSync(jsonlPath)) return 0;

  const content = fs.readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return 0;

  let imported = 0;
  for (const line of lines) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // malformed line → skip
    }

    // created_at 필터 — sinceTimestamp 이후만
    if (sinceTimestamp && row.created_at && row.created_at <= sinceTimestamp) {
      continue;
    }

    // id 컬럼 제거 (자기 DB에서 재할당)
    const { id: _id, ...rest } = row;
    const cols = Object.keys(rest);
    if (cols.length === 0) continue;

    const placeholders = cols.map(() => '?').join(',');
    const sql = `INSERT OR IGNORE INTO ${tableName} (${cols.join(',')}) VALUES (${placeholders})`;
    try {
      const result = execute(sql, cols.map(c => rest[c]));
      if ((result.changes ?? 0) > 0) imported++;
    } catch (err: any) {
      // schema mismatch or constraint — 레코드 단위 skip, 다음 줄 진행
      logger.debug({ err: err.message, table: tableName, row: Object.keys(rest).slice(0, 3) }, 'Import row skipped');
    }
  }
  return imported;
}

/** 특정 디바이스 폴더 내의 날짜 폴더들을 순회하며 모든 테이블 import.
 *  @returns 디바이스 전체에서 import된 레코드 수 + 테이블별 분포 */
function importDevice(deviceDir: string): { total: number; perTable: Record<string, number>; latestTimestamp: string } {
  const sinceTs = getLastImportedAt(deviceDir);
  const perTable: Record<string, number> = {};
  let total = 0;
  let latestTimestamp = sinceTs ?? '';

  if (!fs.existsSync(deviceDir)) return { total: 0, perTable, latestTimestamp };

  const dateDirs = fs
    .readdirSync(deviceDir)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .map(name => path.join(deviceDir, name))
    .filter(p => fs.statSync(p).isDirectory())
    .sort(); // 날짜 오름차순

  for (const dateDir of dateDirs) {
    for (const tableName of IMPORT_TABLES) {
      const jsonlPath = path.join(dateDir, `${tableName}.jsonl`);
      const count = importTableFile(tableName, jsonlPath, sinceTs);
      if (count > 0) {
        perTable[tableName] = (perTable[tableName] ?? 0) + count;
        total += count;
      }
    }
    // 디렉토리 이름이 날짜 기준 — 최종 타임스탬프 갱신 (자정 기준)
    const dateName = path.basename(dateDir);
    const dayEnd = `${dateName} 23:59:59`;
    if (dayEnd > latestTimestamp) latestTimestamp = dayEnd;
  }

  return { total, perTable, latestTimestamp };
}

/** 전체 NAS 양방향 import 진입점.
 *  설정: `settings.nasImportEnabled === true`이고 `nasSyncEnabled === true`일 때만 실행. */
export async function runNasImport(): Promise<ImportResult> {
  const settings = getSettings();
  const result: ImportResult = {
    devicesProcessed: 0,
    recordsImported: 0,
    perDevice: [],
    skipped: [],
  };

  if (!settings.nasSyncEnabled) {
    result.skipped.push('NAS sync 미활성화');
    return result;
  }
  if (!(settings as any).nasImportEnabled) {
    result.skipped.push('nasImportEnabled=false (기본값) — 양방향 import 수동 활성화 필요');
    return result;
  }

  const nasRoot = settings.nasSyncPath || '/Volumes/stock-manager';
  if (!fs.existsSync(nasRoot)) {
    result.skipped.push(`NAS 경로 접근 불가: ${nasRoot}`);
    return result;
  }

  const deviceDirs = discoverDeviceFolders(nasRoot);
  if (deviceDirs.length === 0) {
    result.skipped.push('다른 디바이스 폴더 없음');
    return result;
  }

  for (const deviceDir of deviceDirs) {
    const deviceName = path.basename(deviceDir);
    try {
      const { total, perTable, latestTimestamp } = importDevice(deviceDir);
      if (total > 0) {
        setLastImportedAt(deviceDir, {
          lastImportedAt: latestTimestamp,
          recordsByTable: perTable,
        });
        try {
          await logSystemEvent(
            'INFO',
            'NAS_IMPORT',
            `NAS import 완료: ${deviceName} (${total} 레코드)`,
            JSON.stringify(perTable)
          );
        } catch {}
      }
      result.perDevice.push({ device: deviceName, records: total, perTable });
      result.recordsImported += total;
      result.devicesProcessed++;
    } catch (err: any) {
      logger.error({ err, deviceDir }, 'Device import failed');
      try {
        await logSystemEvent(
          'WARN',
          'NAS_IMPORT',
          `NAS import 실패: ${deviceName}`,
          err.message || String(err)
        );
      } catch {}
    }
  }

  logger.info({ ...result }, 'NAS 양방향 import 완료');
  return result;
}
