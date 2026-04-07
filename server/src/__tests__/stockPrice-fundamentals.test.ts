/**
 * stockPrice.ts — getFundamentals + getKisFundamentals coverage
 * (lines 250-334 were uncovered in the 2nd pass)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    kisAppKey: 'k', kisAppSecret: 's', kisVirtual: false,
    dartEnabled: false, dartApiKey: '',
  })),
}));

vi.mock('../services/kisAuth', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  getKisConfig: vi.fn(() => ({
    appKey: 'k', appSecret: 's',
    baseUrl: 'https://mock.koreainvestment',
    isVirtual: false,
  })),
}));

vi.mock('../services/apiQueue', () => ({
  kisApiCall: vi.fn(async (fn: () => Promise<any>) => fn()),
  yahooApiCall: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

import {
  getFundamentals,
  getKisFundamentals,
} from '../services/stockPrice';
import { getSettings } from '../services/settings';

describe('getFundamentals (Yahoo)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 52-week high/low from Yahoo meta', async () => {
    // Use a unique ticker to bypass module-level fundamentalCache from
    // previous test runs
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            meta: {
              fiftyTwoWeekHigh: 85000,
              fiftyTwoWeekLow: 55000,
            },
          }],
        },
      }),
    }));

    const data = await getFundamentals('UNIQUE_TICKER_FND_1');
    expect(data.fiftyTwoWeekHigh).toBe(85000);
    expect(data.fiftyTwoWeekLow).toBe(55000);
  });

  it('returns empty object on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }));

    const data = await getFundamentals('UNIQUE_TICKER_FND_2');
    expect(data).toEqual({});
  });

  it('returns empty object on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    const data = await getFundamentals('UNIQUE_TICKER_FND_3');
    expect(data).toEqual({});
  });
});

describe('getKisFundamentals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({
      kisAppKey: 'k', kisAppSecret: 's', kisVirtual: false,
      dartEnabled: false, dartApiKey: '',
    } as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty object when KIS credentials are missing', async () => {
    vi.mocked(getSettings).mockReturnValue({
      kisAppKey: '', kisAppSecret: '', kisVirtual: false,
      dartEnabled: false, dartApiKey: '',
    } as any);
    const data = await getKisFundamentals('UNIQUE_KIS_FND_1');
    expect(data).toEqual({});
  });

  it('parses per/pbr/marketCap from KIS inquire-price response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rt_cd: '0',
        output: {
          per: '12.5',
          pbr: '1.2',
          hts_avls: '420000', // 시가총액 42조원 (단위: 억원)
        },
      }),
    }));

    const data = await getKisFundamentals('UNIQUE_KIS_FND_2');
    expect(data.per).toBe(12.5);
    expect(data.pbr).toBe(1.2);
    expect(data.marketCap).toBe(420000);
  });

  it('returns empty object when KIS returns rt_cd != "0"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rt_cd: '1' }),
    }));

    const data = await getKisFundamentals('UNIQUE_KIS_FND_3');
    expect(data).toEqual({});
  });

  it('returns empty object on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    const data = await getKisFundamentals('UNIQUE_KIS_FND_4');
    expect(data).toEqual({});
  });

  it('returns empty object on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const data = await getKisFundamentals('UNIQUE_KIS_FND_5');
    expect(data).toEqual({});
  });
});
