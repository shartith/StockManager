import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import logger from '../logger';
import { queryAll } from '../db';
import { getSettings } from './settings';
import { logSystemEvent } from './systemEvent';

/** SMB 자동 마운트 (macOS) */
export function ensureNasMounted(): { mounted: boolean; message: string } {
  const settings = getSettings();
  const mountPath = settings.nasSyncPath || '/Volumes/stock-manager';

  // 이미 마운트되어 있으면 스킵
  if (fs.existsSync(mountPath)) {
    try {
      fs.accessSync(mountPath, fs.constants.W_OK);
      return { mounted: true, message: '이미 마운트됨' };
    } catch {
      // 마운트 포인트 존재하지만 접근 불가 — 재마운트 시도
    }
  }

  if (!settings.nasHost || !settings.nasUsername || !settings.nasPassword) {
    return { mounted: false, message: 'NAS 접속 정보가 설정되지 않았습니다 (host, username, password)' };
  }

  const share = settings.nasShare || 'stock-manager';

  try {
    // macOS: mkdir + mount_smbfs
    if (!fs.existsSync(mountPath)) {
      fs.mkdirSync(mountPath, { recursive: true });
    }

    // URL-encode password for special characters
    const encodedPassword = encodeURIComponent(settings.nasPassword);
    const smbUrl = `//${settings.nasUsername}:${encodedPassword}@${settings.nasHost}/${share}`;

    execSync(`mount_smbfs "${smbUrl}" "${mountPath}"`, {
      timeout: 15000,
      stdio: 'pipe',
    });

    logger.info({ mountPath, host: settings.nasHost, share }, 'NAS SMB 마운트 성공');
    return { mounted: true, message: `마운트 완료: ${mountPath}` };
  } catch (err: any) {
    logger.warn({ err, mountPath }, 'NAS SMB 마운트 실패');
    return { mounted: false, message: `마운트 실패: ${err.message}` };
  }
}

// Tables to sync with their created_at column
const SYNC_TABLES = [
  'trade_signals',
  'auto_trades',
  'transactions',
  'signal_performance',
  'system_events',
  'backtest_results',
  'weight_optimization_log',
  'weekly_reports',
  'audit_log',
] as const;

interface SyncResult {
  success: boolean;
  message: string;
  tablesExported: number;
  totalRecords: number;
  syncPath: string;
  timestamp: string;
}

interface LastSyncInfo {
  lastSyncAt: string;
  deviceId: string;
  tablesExported: number;
  totalRecords: number;
}

/** Validate NAS path is accessible */
export function validateNasPath(nasPath: string): { valid: boolean; message: string } {
  if (!nasPath || nasPath.trim() === '') {
    return { valid: false, message: 'NAS 경로가 비어있습니다' };
  }
  try {
    // Check if path exists
    if (!fs.existsSync(nasPath)) {
      // Try to create it
      fs.mkdirSync(nasPath, { recursive: true });
    }
    // Check write permission
    fs.accessSync(nasPath, fs.constants.W_OK | fs.constants.R_OK);
    return { valid: true, message: '경로 접근 가능' };
  } catch (err: any) {
    return { valid: false, message: `경로 접근 불가: ${err.message}` };
  }
}

/** Get last sync time from NAS */
export function getLastSyncTime(deviceDir: string): string | null {
  const lastSyncPath = path.join(deviceDir, 'last_sync.json');
  try {
    if (fs.existsSync(lastSyncPath)) {
      const data = JSON.parse(fs.readFileSync(lastSyncPath, 'utf-8'));
      return data.lastSyncAt || null;
    }
  } catch {}
  return null;
}

/** Update last sync time on NAS */
function updateLastSyncTime(deviceDir: string, info: LastSyncInfo): void {
  const lastSyncPath = path.join(deviceDir, 'last_sync.json');
  fs.writeFileSync(lastSyncPath, JSON.stringify(info, null, 2), 'utf-8');
}

/** Export a single table incrementally */
function exportTableIncremental(tableName: string, lastSyncAt: string | null, outputDir: string): number {
  let sql = `SELECT * FROM ${tableName}`;
  const params: any[] = [];

  if (lastSyncAt) {
    sql += ` WHERE created_at > ?`;
    params.push(lastSyncAt);
  }

  sql += ' ORDER BY created_at ASC';

  const rows = queryAll(sql, params);
  if (rows.length === 0) return 0;

  const filePath = path.join(outputDir, `${tableName}.jsonl`);
  const lines = rows.map((row: any) => JSON.stringify(row));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

  return rows.length;
}

/** Export settings snapshot (without secrets) */
function exportSettingsSnapshot(outputDir: string): void {
  const settings = getSettings();
  const { kisAppKey, kisAppSecret, dartApiKey, ...safeSettings } = settings;
  const snapshot = {
    ...safeSettings,
    kisAppKey: kisAppKey ? '****' : '',
    kisAppSecret: kisAppSecret ? '****' : '',
    dartApiKey: dartApiKey ? '****' : '',
    _exportedAt: new Date().toISOString(),
    _hostname: os.hostname(),
    _platform: os.platform(),
    _arch: os.arch(),
  };
  fs.writeFileSync(
    path.join(outputDir, 'settings-snapshot.json'),
    JSON.stringify(snapshot, null, 2),
    'utf-8'
  );
}

/** Run full NAS sync */
export async function runNasSync(): Promise<SyncResult> {
  const settings = getSettings();
  const timestamp = new Date().toISOString();

  if (!settings.nasSyncEnabled) {
    return { success: false, message: 'NAS 동기화가 비활성화되어 있습니다', tablesExported: 0, totalRecords: 0, syncPath: '', timestamp };
  }

  const nasPath = settings.nasSyncPath || '/Volumes/stock-manager';

  // SMB 자동 마운트 시도
  if (settings.nasAutoMount && settings.nasHost) {
    const mountResult = ensureNasMounted();
    if (!mountResult.mounted) {
      logSystemEvent('WARN', 'NAS_SYNC', 'NAS 마운트 실패', mountResult.message);
      return { success: false, message: `NAS 마운트 실패: ${mountResult.message}`, tablesExported: 0, totalRecords: 0, syncPath: nasPath, timestamp };
    }
  }

  // Validate path
  const validation = validateNasPath(nasPath);
  if (!validation.valid) {
    logSystemEvent('WARN', 'NAS_SYNC', 'NAS 동기화 실패', validation.message);
    return { success: false, message: validation.message, tablesExported: 0, totalRecords: 0, syncPath: nasPath, timestamp };
  }

  const deviceId = settings.deviceId || os.hostname();
  const deviceDir = path.join(nasPath, `device-${deviceId}`);
  const today = new Date().toISOString().slice(0, 10);
  const dateDir = path.join(deviceDir, today);

  // Create directories
  fs.mkdirSync(dateDir, { recursive: true });

  // Get last sync time
  const lastSyncAt = getLastSyncTime(deviceDir);

  logger.info({ deviceId, nasPath, lastSyncAt, today }, 'NAS 동기화 시작');

  let tablesExported = 0;
  let totalRecords = 0;

  try {
    // Export each table
    for (const tableName of SYNC_TABLES) {
      try {
        const count = exportTableIncremental(tableName, lastSyncAt, dateDir);
        if (count > 0) {
          tablesExported++;
          totalRecords += count;
          logger.info({ tableName, count }, `테이블 내보내기 완료`);
        }
      } catch (err: any) {
        logger.error({ err, tableName }, `테이블 내보내기 실패`);
      }
    }

    // Export settings snapshot
    exportSettingsSnapshot(dateDir);

    // Update last sync time
    updateLastSyncTime(deviceDir, {
      lastSyncAt: timestamp,
      deviceId,
      tablesExported,
      totalRecords,
    });

    const message = `동기화 완료: ${tablesExported}개 테이블, ${totalRecords}건 레코드`;
    logSystemEvent('INFO', 'NAS_SYNC', 'NAS 동기화 성공', message);
    logger.info({ tablesExported, totalRecords }, message);

    return { success: true, message, tablesExported, totalRecords, syncPath: dateDir, timestamp };
  } catch (err: any) {
    const message = `NAS 동기화 오류: ${err.message}`;
    logSystemEvent('ERROR', 'NAS_SYNC', 'NAS 동기화 실패', message);
    logger.error({ err }, message);
    return { success: false, message, tablesExported, totalRecords, syncPath: dateDir, timestamp };
  }
}

/** Get sync status */
export function getSyncStatus(): { enabled: boolean; lastSync: LastSyncInfo | null; nasPath: string; deviceId: string } {
  const settings = getSettings();
  const deviceId = settings.deviceId || os.hostname();

  if (!settings.nasSyncEnabled || !settings.nasSyncPath) {
    return { enabled: false, lastSync: null, nasPath: settings.nasSyncPath || '', deviceId };
  }

  const deviceDir = path.join(settings.nasSyncPath, `device-${deviceId}`);
  const lastSyncPath = path.join(deviceDir, 'last_sync.json');

  let lastSync: LastSyncInfo | null = null;
  try {
    if (fs.existsSync(lastSyncPath)) {
      lastSync = JSON.parse(fs.readFileSync(lastSyncPath, 'utf-8'));
    }
  } catch {}

  return { enabled: true, lastSync, nasPath: settings.nasSyncPath, deviceId };
}
