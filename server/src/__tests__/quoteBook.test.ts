/**
 * quoteBook.ts coverage (was 13.75% — minimal stub test existed, now full)
 *
 * Covers:
 *   - assessQuoteQuality pure function (GOOD/FAIR/POOR boundaries)
 *   - getQuoteBook cache hit path + invalidation
 *   - getQuoteBook KRX fetch path with mocked KIS response
 *   - getQuoteBook non-KRX (returns null)
 *   - Fetch failure paths (HTTP error, API error, empty levels, auth failure, exception)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/kisAuth', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  getKisConfig: vi.fn(() => ({
    appKey: 'k',
    appSecret: 's',
    baseUrl: 'https://mock.koreainvestment',
    isVirtual: false,
  })),
}));

vi.mock('../services/apiQueue', () => ({
  kisApiCall: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

import {
  assessQuoteQuality,
  getQuoteBook,
  invalidateQuoteBookCache,
} from '../services/quoteBook';
import { getAccessToken } from '../services/kisAuth';

/** Build a KIS inquire-asking-price response payload with 10 levels. */
function mockKrxOutput(opts: {
  bestBid: number; bestAsk: number;
  bidQty: number; askQty: number;
  rt_cd?: string;
}) {
  const output1: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) {
    output1[`askp${i}`] = String(opts.bestAsk + (i - 1) * 10);
    output1[`askp_rsqn${i}`] = String(opts.askQty);
    output1[`bidp${i}`] = String(opts.bestBid - (i - 1) * 10);
    output1[`bidp_rsqn${i}`] = String(opts.bidQty);
  }
  return { rt_cd: opts.rt_cd ?? '0', output1 };
}

describe('assessQuoteQuality', () => {
  it('returns GOOD for tight spread + deep book', () => {
    expect(assessQuoteQuality(0.1, 20_000_000)).toBe('GOOD');
    expect(assessQuoteQuality(0.0, 100_000_000)).toBe('GOOD');
  });

  it('returns GOOD at the spread and depth upper boundary', () => {
    expect(assessQuoteQuality(0.2, 10_000_000)).toBe('GOOD');
  });

  it('returns FAIR for moderate spread or moderate depth', () => {
    expect(assessQuoteQuality(0.3, 15_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.5, 5_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.1, 5_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.2, 3_000_000)).toBe('FAIR');
  });

  it('returns FAIR at the spread and depth lower boundary', () => {
    expect(assessQuoteQuality(0.5, 3_000_000)).toBe('FAIR');
  });

  it('returns POOR when spread > 0.5', () => {
    expect(assessQuoteQuality(0.6, 10_000_000)).toBe('POOR');
    expect(assessQuoteQuality(1.0, 50_000_000)).toBe('POOR');
  });

  it('returns POOR when depth < 3M even with tight spread', () => {
    expect(assessQuoteQuality(0.1, 2_000_000)).toBe('POOR');
    expect(assessQuoteQuality(0.2, 2_999_999)).toBe('POOR');
  });

  it('FAIR/POOR step-off boundaries', () => {
    expect(assessQuoteQuality(0.21, 10_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.2, 9_999_999)).toBe('FAIR');
    expect(assessQuoteQuality(0.51, 3_000_000)).toBe('POOR');
    expect(assessQuoteQuality(0.5, 2_999_999)).toBe('POOR');
  });
});

describe('getQuoteBook', () => {
  beforeEach(() => {
    invalidateQuoteBookCache();
    vi.clearAllMocks();
    vi.mocked(getAccessToken).mockResolvedValue('test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for non-KRX markets', async () => {
    expect(await getQuoteBook('AAPL', 'NASDAQ')).toBeNull();
    expect(await getQuoteBook('AAPL', 'NYSE')).toBeNull();
  });

  it('fetches and parses a valid KRX quote book', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockKrxOutput({
        bestBid: 70000, bestAsk: 70050, bidQty: 200, askQty: 200,
      }),
    }));

    const qb = await getQuoteBook('005930', 'KRX');
    expect(qb).not.toBeNull();
    expect(qb!.ticker).toBe('005930');
    expect(qb!.market).toBe('KRX');
    expect(qb!.bids).toHaveLength(10);
    expect(qb!.asks).toHaveLength(10);
    expect(qb!.bids[0].price).toBe(70000);
    expect(qb!.asks[0].price).toBe(70050);
    expect(qb!.midPrice).toBe(70025);
    expect(qb!.spreadPercent).toBeCloseTo(0.071, 2);
    // depth = 200*70000 + 200*70050 = 28.01M → GOOD
    expect(qb!.quality).toBe('GOOD');
  });

  it('caches successful responses (second call does not fetch)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockKrxOutput({
        bestBid: 70000, bestAsk: 70100, bidQty: 100, askQty: 100,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getQuoteBook('005930', 'KRX');
    await getQuoteBook('005930', 'KRX');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidateQuoteBookCache(ticker, market) forces a refetch for just that key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockKrxOutput({
        bestBid: 70000, bestAsk: 70100, bidQty: 100, askQty: 100,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getQuoteBook('005930', 'KRX');
    invalidateQuoteBookCache('005930', 'KRX');
    await getQuoteBook('005930', 'KRX');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateQuoteBookCache() with no args clears entire cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockKrxOutput({
        bestBid: 70000, bestAsk: 70100, bidQty: 100, askQty: 100,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getQuoteBook('005930', 'KRX');
    invalidateQuoteBookCache();
    await getQuoteBook('005930', 'KRX');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });

  it('returns null when API reports rt_cd != "0"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rt_cd: '1', msg1: 'rejected', output1: {} }),
    }));
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });

  it('returns null when output1 is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rt_cd: '0' }),
    }));
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });

  it('returns null when every level has zero price (empty book)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        const out: Record<string, string> = {};
        for (let i = 1; i <= 10; i++) {
          out[`askp${i}`] = '0';
          out[`askp_rsqn${i}`] = '0';
          out[`bidp${i}`] = '0';
          out[`bidp_rsqn${i}`] = '0';
        }
        return { rt_cd: '0', output1: out };
      },
    }));
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });

  it('returns null when auth token issuance fails', async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error('no token'));
    vi.stubGlobal('fetch', vi.fn());
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });

  it('returns null on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await getQuoteBook('005930', 'KRX')).toBeNull();
  });
});
