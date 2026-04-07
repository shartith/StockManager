/**
 * kisAuth.ts coverage (was 8.82%)
 *
 * Mocks `fetch` and `./settings` so we can exercise:
 *   - missing credentials → clear error
 *   - successful token issuance → cache populated
 *   - cached token reuse
 *   - invalidateToken
 *   - isVirtual → correct baseUrl routing
 *
 * NOTE: the retry path on HTTP failure calls `setTimeout(10_000)` before
 *   recursing. We test the retry-exhausted branch by stubbing `setTimeout`
 *   so the test runs instantly.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    kisAppKey: 'mock-key',
    kisAppSecret: 'mock-secret',
    kisVirtual: false,
  })),
}));

import { getKisConfig, getAccessToken, invalidateToken } from '../services/kisAuth';
import { getSettings } from '../services/settings';

const getSettingsMock = vi.mocked(getSettings);

describe('kisAuth', () => {
  beforeEach(() => {
    invalidateToken();
    // Reset env vars so they don't override settings
    delete process.env.KIS_APP_KEY;
    delete process.env.KIS_APP_SECRET;
    getSettingsMock.mockReturnValue({
      kisAppKey: 'mock-key',
      kisAppSecret: 'mock-secret',
      kisVirtual: false,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('getKisConfig', () => {
    it('returns production baseUrl when kisVirtual=false', () => {
      const c = getKisConfig();
      expect(c.baseUrl).toBe('https://openapi.koreainvestment.com:9443');
      expect(c.isVirtual).toBe(false);
      expect(c.appKey).toBe('mock-key');
      expect(c.appSecret).toBe('mock-secret');
    });

    it('returns virtual (simulated) baseUrl when kisVirtual=true', () => {
      getSettingsMock.mockReturnValue({
        kisAppKey: 'k', kisAppSecret: 's', kisVirtual: true,
      } as any);
      expect(getKisConfig().baseUrl).toBe('https://openapivts.koreainvestment.com:9443');
    });

    it('prefers env var over settings', () => {
      process.env.KIS_APP_KEY = 'env-key';
      process.env.KIS_APP_SECRET = 'env-secret';
      const c = getKisConfig();
      expect(c.appKey).toBe('env-key');
      expect(c.appSecret).toBe('env-secret');
    });
  });

  describe('getAccessToken', () => {
    it('throws when appKey is missing', async () => {
      getSettingsMock.mockReturnValue({
        kisAppKey: '', kisAppSecret: 'x', kisVirtual: false,
      } as any);
      await expect(getAccessToken()).rejects.toThrow(/AppKey/);
    });

    it('throws when appSecret is missing', async () => {
      getSettingsMock.mockReturnValue({
        kisAppKey: 'x', kisAppSecret: '', kisVirtual: false,
      } as any);
      await expect(getAccessToken()).rejects.toThrow(/AppKey|AppSecret/);
    });

    it('issues a new token via the KIS oauth endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'tok-123', expires_in: 86400 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const token = await getAccessToken();
      expect(token).toBe('tok-123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/oauth2\/tokenP$/);
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.grant_type).toBe('client_credentials');
      expect(body.appkey).toBe('mock-key');
      expect(body.appsecret).toBe('mock-secret');
    });

    it('reuses cached token on subsequent calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'cached-tok', expires_in: 86400 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await getAccessToken();
      await getAccessToken();
      await getAccessToken();

      expect(fetchMock).toHaveBeenCalledTimes(1); // only the first call hit the network
    });

    it('invalidateToken forces a fresh fetch on next call', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 't1', expires_in: 86400 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await getAccessToken();
      invalidateToken();
      await getAccessToken();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on HTTP failure and ultimately throws after MAX_TOKEN_RETRIES', async () => {
      // Stub setTimeout so the 10s retry sleep runs instantly
      vi.stubGlobal(
        'setTimeout',
        ((fn: () => void) => {
          fn();
          return 0 as unknown as NodeJS.Timeout;
        }) as any,
      );

      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'server error',
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(getAccessToken()).rejects.toThrow(/KIS 토큰 발급 실패/);
      // 1 initial + 3 retries = 4 total
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });
});
