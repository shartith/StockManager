import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Mock fs to avoid actual file operations
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// We need to reset the module cache to clear the settings cache between tests
// because settings.ts has a module-level `_cache` variable.

describe('settings', () => {
  let getSettings: typeof import('../services/settings').getSettings;
  let saveSettings: typeof import('../services/settings').saveSettings;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset module to clear _cache
    vi.resetModules();

    // Clear environment variables that settings reads
    delete process.env.KIS_APP_KEY;
    delete process.env.KIS_APP_SECRET;
    delete process.env.DART_API_KEY;
    delete process.env.KIS_VIRTUAL;

    // Re-mock fs after resetModules
    vi.doMock('fs', () => ({
      default: {
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }));

    const mod = await import('../services/settings');
    getSettings = mod.getSettings;
    saveSettings = mod.saveSettings;
  });

  afterEach(() => {
    delete process.env.KIS_APP_KEY;
    delete process.env.KIS_APP_SECRET;
    delete process.env.DART_API_KEY;
    delete process.env.KIS_VIRTUAL;
  });

  describe('getSettings', () => {
    it('returns default settings when no file exists', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      const settings = getSettings();
      expect(settings.kisAppKey).toBe('');
      expect(settings.kisAppSecret).toBe('');
      expect(settings.mlxUrl).toBe('http://localhost:8000');
      expect(settings.mlxModel).toBe('mlx-community/gemma-3n-E4B-it-4bit');
      expect(settings.mlxEnabled).toBe(true); // v4.12.0: MLX 기본 활성화
      expect(settings.autoTradeEnabled).toBe(false);
      expect(settings.investmentStyle).toBe('balanced');
      expect(settings.stopLossPercent).toBe(3);
      expect(settings.kisVirtual).toBe(true);
      expect(settings.kisAccountProductCode).toBe('01');
    });

    it('returns default settings with correct trading rules defaults', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      const settings = getSettings();
      expect(settings.tradingRulesEnabled).toBe(true);
      expect(settings.tradingRulesStrictMode).toBe(false);
      expect(settings.gapThresholdPercent).toBe(3);
      expect(settings.volumeSurgeRatio).toBe(1.5);
      expect(settings.lowVolumeRatio).toBe(0.7);
      expect(settings.sidewaysAtrPercent).toBe(1.0);
    });

    it('returns default schedule config', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      const settings = getSettings();
      expect(settings.scheduleKrx).toEqual({
        enabled: false,
        preOpen: true,
        postOpen: true,
        preClose1h: true,
        preClose30m: true,
      });
      expect(settings.scheduleNyse).toEqual({
        enabled: false,
        preOpen: true,
        postOpen: true,
        preClose1h: true,
        preClose30m: true,
      });
    });

    it('merges saved file settings with defaults', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({
          kisAppKey: 'my-key',
          mlxModel: 'llama3',
          autoTradeEnabled: true,
        })
      );

      const settings = getSettings();
      expect(settings.kisAppKey).toBe('my-key');
      expect(settings.mlxModel).toBe('llama3');
      expect(settings.autoTradeEnabled).toBe(true);
      // Defaults should still be present
      expect(settings.mlxUrl).toBe('http://localhost:8000');
      expect(settings.stopLossPercent).toBe(3);
    });

    it('returns defaults when file has invalid JSON', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue('not valid json{{{');

      const settings = getSettings();
      expect(settings.kisAppKey).toBe('');
      expect(settings.mlxUrl).toBe('http://localhost:8000');
    });

    it('caches settings on second call', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      const first = getSettings();
      const second = getSettings();
      expect(first).toBe(second); // same reference (cached)
      // existsSync should only be called once (the cache prevents second read)
      expect(fsModule.default.existsSync).toHaveBeenCalledTimes(1);
    });

    it('environment variable KIS_APP_KEY overrides file value', async () => {
      // ENV_SECRETS snapshots at module load — set env BEFORE re-importing
      vi.resetModules();
      process.env.KIS_APP_KEY = 'env-key';
      vi.doMock('fs', () => ({
        default: {
          existsSync: vi.fn().mockReturnValue(true),
          readFileSync: vi.fn().mockReturnValue(JSON.stringify({ kisAppKey: 'file-key' })),
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
        },
      }));
      const mod = await import('../services/settings');
      const settings = mod.getSettings();
      expect(settings.kisAppKey).toBe('env-key');
    });

    it('environment variable KIS_APP_SECRET overrides file value', async () => {
      vi.resetModules();
      process.env.KIS_APP_SECRET = 'env-secret';
      vi.doMock('fs', () => ({
        default: {
          existsSync: vi.fn().mockReturnValue(true),
          readFileSync: vi.fn().mockReturnValue(JSON.stringify({ kisAppSecret: 'file-secret' })),
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
        },
      }));
      const mod = await import('../services/settings');
      const settings = mod.getSettings();
      expect(settings.kisAppSecret).toBe('env-secret');
    });

    it('environment variable DART_API_KEY overrides file value', async () => {
      vi.resetModules();
      process.env.DART_API_KEY = 'env-dart';
      vi.doMock('fs', () => ({
        default: {
          existsSync: vi.fn().mockReturnValue(true),
          readFileSync: vi.fn().mockReturnValue(JSON.stringify({ dartApiKey: 'file-dart' })),
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
        },
      }));
      const mod = await import('../services/settings');
      const settings = mod.getSettings();
      expect(settings.dartApiKey).toBe('env-dart');
    });

    it('syncs kisAppKey to process.env when loaded from file', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({ kisAppKey: 'sync-key' })
      );

      getSettings();
      expect(process.env.KIS_APP_KEY).toBe('sync-key');
    });

    it('sets KIS_VIRTUAL env var based on kisVirtual', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({ kisVirtual: false })
      );

      getSettings();
      expect(process.env.KIS_VIRTUAL).toBe('false');
    });
  });

  describe('saveSettings', () => {
    it('merges partial settings with current', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      // First call initializes with defaults
      getSettings();

      // Save partial update
      saveSettings({ mlxModel: 'custom-model', autoTradeEnabled: true });

      // Verify writeFileSync was called
      expect(fsModule.default.writeFileSync).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[0][1] as string
      );
      expect(writtenData.mlxModel).toBe('custom-model');
      expect(writtenData.autoTradeEnabled).toBe(true);
      // Default values should persist
      expect(writtenData.mlxUrl).toBe('http://localhost:8000');
    });

    it('creates data directory if it does not exist', async () => {
      const fsModule = await import('fs');
      // existsSync returns false for settings file (first call) and false for directory
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      getSettings();
      saveSettings({ mlxModel: 'test' });

      expect(fsModule.default.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('strips secrets from file when set via env vars BEFORE module load', async () => {
      // ENV_SECRETS is snapshotted at module load time. To test this path,
      // set env vars and then re-import the module so the snapshot picks them up.
      vi.resetModules();
      process.env.KIS_APP_KEY = 'env-key';
      process.env.KIS_APP_SECRET = 'env-secret';
      process.env.DART_API_KEY = 'env-dart';

      vi.doMock('fs', () => ({
        default: {
          existsSync: vi.fn().mockReturnValue(false),
          readFileSync: vi.fn(),
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
        },
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      }));

      const mod = await import('../services/settings');
      const fsModule = await import('fs');

      mod.getSettings();
      mod.saveSettings({ mlxModel: 'test' });

      const writtenData = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[0][1] as string,
      );
      // Secrets should NOT be in the written file when set via external env
      expect(writtenData.kisAppKey).toBeUndefined();
      expect(writtenData.kisAppSecret).toBeUndefined();
      expect(writtenData.dartApiKey).toBeUndefined();
    });

    it('preserves UI-entered secrets in file across multiple saves (regression for v4.5.1 bug)', async () => {
      // BUG: Previously, the second saveSettings() call would strip kisAppKey/kisAppSecret
      // because saveSettings used process.env.KIS_APP_KEY as the strip trigger, and
      // getSettings/saveSettings themselves set process.env after the first save.
      // FIX: ENV_SECRETS is now snapshotted at module load time. Internal env sync
      // does not affect strip behavior.
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      // Simulate UI flow: user enters keys and saves
      getSettings();
      saveSettings({ kisAppKey: 'user-entered-key', kisAppSecret: 'user-entered-secret' });

      const firstSave = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[0][1] as string,
      );
      expect(firstSave.kisAppKey).toBe('user-entered-key');
      expect(firstSave.kisAppSecret).toBe('user-entered-secret');

      // User changes another setting and saves again — keys MUST still be in file
      saveSettings({ mlxModel: 'updated-model' });

      const secondSave = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[1][1] as string,
      );
      expect(secondSave.kisAppKey).toBe('user-entered-key');
      expect(secondSave.kisAppSecret).toBe('user-entered-secret');
      expect(secondSave.mlxModel).toBe('updated-model');
    });

    it('preserves file-loaded secrets across saves when no external env vars set', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({ kisAppKey: 'file-key', kisAppSecret: 'file-secret', dartApiKey: 'file-dart' }),
      );

      getSettings();
      // Internal env sync happens (so other modules can read), but ENV_SECRETS snapshot is empty
      saveSettings({ mlxModel: 'test' });

      const writtenData = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[0][1] as string,
      );
      // Keys must be preserved — they were entered via UI/file, not external env
      expect(writtenData.kisAppKey).toBe('file-key');
      expect(writtenData.kisAppSecret).toBe('file-secret');
      expect(writtenData.dartApiKey).toBe('file-dart');
    });

    it('syncs environment variables after save', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      getSettings();
      saveSettings({ kisAppKey: 'new-key', kisAppSecret: 'new-secret', kisVirtual: false });

      expect(process.env.KIS_APP_KEY).toBe('new-key');
      expect(process.env.KIS_APP_SECRET).toBe('new-secret');
      expect(process.env.KIS_VIRTUAL).toBe('false');
    });

    it('reflects saved values on next getSettings call', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(false);

      getSettings();
      saveSettings({ mlxModel: 'updated-model' });

      const settings = getSettings();
      expect(settings.mlxModel).toBe('updated-model');
    });
  });

  // ── v4.5.3: Legacy field migration ──────────────────────────
  //
  // externalAi* fields were added in v4.5.0 for an external AI provider
  // option, but the project pivoted to local-only Ollama. They became
  // dead config and a leak risk in NAS sync exports. v4.5.3 strips them
  // automatically on load and on next save.

  describe('legacy field migration (v4.5.3)', () => {
    it('strips externalAiApiKey from loaded settings', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({
          kisAppKey: 'real-key',
          mlxModel: 'exaone3.5:2.4b',
          externalAiApiKey: 'sk-ant-api03-leaked-secret',
          externalAiProvider: 'claude',
          externalAiModel: 'claude-sonnet-4.6',
        }),
      );

      const settings = getSettings() as unknown as Record<string, unknown>;
      expect(settings.kisAppKey).toBe('real-key');
      expect(settings.mlxModel).toBe('exaone3.5:2.4b');
      // Legacy fields must be stripped from cache
      expect(settings.externalAiApiKey).toBeUndefined();
      expect(settings.externalAiProvider).toBeUndefined();
      expect(settings.externalAiModel).toBeUndefined();
    });

    it('omits legacy fields from next saveSettings write', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({
          kisAppKey: 'real-key',
          externalAiApiKey: 'sk-ant-leaked',
          externalAiProvider: 'claude',
          externalAiModel: 'claude-sonnet-4.6',
        }),
      );

      getSettings();
      saveSettings({ mlxModel: 'updated' });

      const written = JSON.parse(
        vi.mocked(fsModule.default.writeFileSync).mock.calls[0][1] as string,
      );
      expect(written.kisAppKey).toBe('real-key');
      expect(written.mlxModel).toBe('updated');
      // Legacy fields must NOT be persisted on next save (self-cleaning migration)
      expect(written.externalAiApiKey).toBeUndefined();
      expect(written.externalAiProvider).toBeUndefined();
      expect(written.externalAiModel).toBeUndefined();
    });

    it('handles malformed legacy fields gracefully', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({
          externalAiApiKey: null,
          externalAiProvider: 12345,
          externalAiModel: { nested: 'object' },
          mlxUrl: 'http://localhost:8000',
        }),
      );

      // Should not throw despite weird types
      const settings = getSettings();
      expect(settings.mlxUrl).toBe('http://localhost:8000');
      expect((settings as unknown as Record<string, unknown>).externalAiApiKey).toBeUndefined();
    });

    it('does not strip non-legacy fields with similar names', async () => {
      const fsModule = await import('fs');
      vi.mocked(fsModule.default.existsSync).mockReturnValue(true);
      vi.mocked(fsModule.default.readFileSync).mockReturnValue(
        JSON.stringify({
          kisAppKey: 'real-key',
          mlxModel: 'real-model',
          mlxUrl: 'real-url',
          dartApiKey: 'real-dart',
        }),
      );

      const settings = getSettings();
      expect(settings.kisAppKey).toBe('real-key');
      expect(settings.mlxModel).toBe('real-model');
      expect(settings.mlxUrl).toBe('real-url');
      expect(settings.dartApiKey).toBe('real-dart');
    });
  });
});
