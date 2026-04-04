import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock dependencies
vi.mock('fs');
vi.mock('child_process');
vi.mock('../db', () => ({
  queryAll: vi.fn(() => []),
  queryOne: vi.fn(() => null),
  execute: vi.fn(() => ({ changes: 0, lastId: 0 })),
}));
vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    nasSyncEnabled: true,
    nasSyncPath: '/tmp/test-nas-sync',
    nasSyncTime: '0 20 * * *',
    deviceId: 'test-device',
    nasHost: 'nas.local',
    nasShare: 'stock-manager',
    nasUsername: 'user',
    nasPassword: 'pass123',
    nasAutoMount: false,
    kisAppKey: 'testkey',
    kisAppSecret: 'testsecret',
    dartApiKey: 'dartkey',
  })),
}));
vi.mock('../services/systemEvent', () => ({
  logSystemEvent: vi.fn(),
}));
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { validateNasPath, getLastSyncTime, runNasSync, getSyncStatus, ensureNasMounted } from '../services/nasSync';
import { getSettings } from '../services/settings';
import { queryAll } from '../db';
import { logSystemEvent } from '../services/systemEvent';

describe('nasSync', () => {
  const defaultSettings = {
    nasSyncEnabled: true,
    nasSyncPath: '/tmp/test-nas-sync',
    nasSyncTime: '0 20 * * *',
    deviceId: 'test-device',
    nasHost: 'nas.local',
    nasShare: 'stock-manager',
    nasUsername: 'user',
    nasPassword: 'pass123',
    nasAutoMount: false,
    kisAppKey: 'testkey',
    kisAppSecret: 'testsecret',
    dartApiKey: 'dartkey',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue(defaultSettings as any);
  });

  // ── validateNasPath ──

  describe('validateNasPath', () => {
    it('returns invalid for empty path', () => {
      const result = validateNasPath('');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('비어있습니다');
    });

    it('returns invalid for whitespace-only path', () => {
      const result = validateNasPath('   ');
      expect(result.valid).toBe(false);
    });

    it('returns valid when path exists and is writable', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);

      const result = validateNasPath('/valid/path');
      expect(result.valid).toBe(true);
      expect(result.message).toContain('접근 가능');
    });

    it('creates directory if path does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);

      const result = validateNasPath('/new/path');
      expect(result.valid).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalledWith('/new/path', { recursive: true });
    });

    it('returns invalid when access check fails', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = validateNasPath('/no-access');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('접근 불가');
    });
  });

  // ── getLastSyncTime ──

  describe('getLastSyncTime', () => {
    it('returns null when last_sync.json does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getLastSyncTime('/some/dir')).toBeNull();
    });

    it('returns lastSyncAt from existing file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastSyncAt: '2026-04-04T20:00:00.000Z' })
      );

      const result = getLastSyncTime('/device/dir');
      expect(result).toBe('2026-04-04T20:00:00.000Z');
    });

    it('returns null when file is corrupted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not-json');

      expect(getLastSyncTime('/device/dir')).toBeNull();
    });

    it('returns null when lastSyncAt is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

      expect(getLastSyncTime('/device/dir')).toBeNull();
    });
  });

  // ── ensureNasMounted ──

  describe('ensureNasMounted', () => {
    it('returns mounted if path already accessible', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);

      const result = ensureNasMounted();
      expect(result.mounted).toBe(true);
      expect(result.message).toContain('이미 마운트');
    });

    it('returns false if NAS credentials missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('no access'); });
      vi.mocked(getSettings).mockReturnValueOnce({
        nasSyncEnabled: true,
        nasSyncPath: '/Volumes/stock-manager',
        nasHost: '',
        nasShare: 'stock-manager',
        nasUsername: '',
        nasPassword: '',
        nasAutoMount: true,
        deviceId: 'test',
      } as any);

      const result = ensureNasMounted();
      expect(result.mounted).toBe(false);
      expect(result.message).toContain('접속 정보');
    });
  });

  // ── getSyncStatus ──

  describe('getSyncStatus', () => {
    it('returns disabled when nasSyncEnabled is false', () => {
      vi.mocked(getSettings).mockReturnValue({
        ...vi.mocked(getSettings)(),
        nasSyncEnabled: false,
      } as any);

      const status = getSyncStatus();
      expect(status.enabled).toBe(false);
      expect(status.lastSync).toBeNull();
    });

    it('returns enabled with last sync info', () => {
      vi.mocked(getSettings).mockReturnValue({
        nasSyncEnabled: true,
        nasSyncPath: '/tmp/test-nas-sync',
        deviceId: 'test-device',
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        lastSyncAt: '2026-04-04T20:00:00.000Z',
        deviceId: 'test-device',
        tablesExported: 5,
        totalRecords: 100,
      }));

      const status = getSyncStatus();
      expect(status.enabled).toBe(true);
      expect(status.deviceId).toBe('test-device');
      expect(status.lastSync).not.toBeNull();
      expect(status.lastSync!.tablesExported).toBe(5);
    });

    it('uses hostname when deviceId is empty', () => {
      vi.mocked(getSettings).mockReturnValue({
        ...vi.mocked(getSettings)(),
        deviceId: '',
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const status = getSyncStatus();
      expect(status.deviceId).toBe(os.hostname());
    });
  });

  // ── runNasSync ──

  describe('runNasSync', () => {
    it('returns failure when sync is disabled', async () => {
      vi.mocked(getSettings).mockReturnValue({
        ...vi.mocked(getSettings)(),
        nasSyncEnabled: false,
      } as any);

      const result = await runNasSync();
      expect(result.success).toBe(false);
      expect(result.message).toContain('비활성화');
    });

    it('returns failure when path validation fails', async () => {
      vi.mocked(getSettings).mockReturnValueOnce({
        nasSyncEnabled: true,
        nasSyncPath: '/invalid',
        nasAutoMount: false,
        nasHost: '',
        deviceId: 'test',
      } as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => { throw new Error('EACCES'); });

      const result = await runNasSync();
      expect(result.success).toBe(false);
      expect(logSystemEvent).toHaveBeenCalled();
    });

    it('exports tables and creates sync files on success', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.includes('last_sync')) return false;
        return true; // validateNasPath needs this
      });
      vi.mocked(fs.accessSync).mockImplementation(() => undefined);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      vi.mocked(queryAll).mockReturnValue([
        { id: 1, signal_type: 'BUY', created_at: '2026-04-04T10:00:00Z' },
      ]);

      const result = await runNasSync();
      expect(result.success).toBe(true);
      expect(result.tablesExported).toBeGreaterThan(0);
      expect(result.totalRecords).toBeGreaterThan(0);
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(logSystemEvent).toHaveBeenCalledWith('INFO', 'NAS_SYNC', expect.any(String), expect.any(String));
    });

    it('handles table export errors gracefully', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        if (String(p).includes('last_sync')) return false;
        return true;
      });
      vi.mocked(fs.accessSync).mockImplementation(() => undefined);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);

      let callCount = 0;
      vi.mocked(queryAll).mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('DB error');
        return [{ id: 1 }];
      });

      const result = await runNasSync();
      expect(result.success).toBe(true);
    });

    it('passes lastSyncAt to incremental queries', async () => {
      // last_sync.json exists and has a lastSyncAt value
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.accessSync).mockReturnValue(undefined);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lastSyncAt: '2026-04-03T20:00:00.000Z' })
      );
      vi.mocked(queryAll).mockReturnValue([]);

      await runNasSync();

      const calls = vi.mocked(queryAll).mock.calls;
      const incrementalCall = calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('WHERE created_at > ?')
      );
      expect(incrementalCall).toBeDefined();
      expect(incrementalCall![1]).toEqual(['2026-04-03T20:00:00.000Z']);
    });

    it('masks secrets in settings snapshot', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        if (String(p).includes('last_sync')) return false;
        return true;
      });
      vi.mocked(fs.accessSync).mockImplementation(() => undefined);
      vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
      vi.mocked(queryAll).mockReturnValue([]);

      const writtenContents: string[] = [];
      vi.mocked(fs.writeFileSync).mockImplementation((_p: any, content: any) => {
        writtenContents.push(String(content));
      });

      await runNasSync();

      const snapshotContent = writtenContents.find(c => c.includes('_exportedAt'));
      expect(snapshotContent).toBeDefined();

      const parsed = JSON.parse(snapshotContent!);
      expect(parsed.kisAppKey).toBe('****');
      expect(parsed.kisAppSecret).toBe('****');
      expect(parsed.dartApiKey).toBe('****');
    });
  });
});
