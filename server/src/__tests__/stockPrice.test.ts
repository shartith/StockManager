/**
 * v4.5.3: Price cache regression tests
 *
 * Verifies that getMultipleStockPrices() respects the 60-second TTL cache:
 *   - First call hits the upstream fetch (KIS or Yahoo)
 *   - Second call within TTL skips fetch entirely
 *   - invalidatePriceCache() forces a re-fetch on the next call
 *   - Mixed cached/uncached tickers only fetch the missing ones
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API queues so we can count actual fetch invocations
vi.mock('../services/apiQueue', () => ({
  kisApiCall: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  yahooApiCall: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Mock KIS auth so we don't try real network
vi.mock('../services/kisAuth', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
  getKisConfig: vi.fn(() => ({
    appKey: '',
    appSecret: '',
    baseUrl: 'http://mock',
    isVirtual: false,
  })),
}));

// Mock settings to disable KIS path so all fetches go through Yahoo
vi.mock('../services/settings', () => ({
  getSettings: vi.fn(() => ({
    kisAppKey: '',
    kisAppSecret: '',
    kisVirtual: false,
  })),
}));

describe('stockPrice cache (v4.5.3)', () => {
  let getMultipleStockPrices: typeof import('../services/stockPrice').getMultipleStockPrices;
  let invalidatePriceCache: typeof import('../services/stockPrice').invalidatePriceCache;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();

    // Mock global fetch — every call returns a fake price
    let counter = 1000;
    const mockFetch = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      const price = counter++;
      if (url.includes('query1.finance.yahoo.com')) {
        return {
          ok: true,
          json: async () => ({
            chart: {
              result: [{
                meta: { regularMarketPrice: price, chartPreviousClose: price - 5 },
              }],
            },
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => 'not mocked' } as unknown as Response;
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    fetchSpy = mockFetch as unknown as ReturnType<typeof vi.spyOn>;

    // Re-mock dependencies for the freshly reset module
    vi.doMock('../services/apiQueue', () => ({
      kisApiCall: vi.fn(async (fn: () => Promise<unknown>) => fn()),
      yahooApiCall: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    }));
    vi.doMock('../services/kisAuth', () => ({
      getAccessToken: vi.fn(async () => 'fake-token'),
      getKisConfig: vi.fn(() => ({ appKey: '', appSecret: '', baseUrl: 'http://mock', isVirtual: false })),
    }));
    vi.doMock('../services/settings', () => ({
      getSettings: vi.fn(() => ({ kisAppKey: '', kisAppSecret: '', kisVirtual: false })),
    }));

    const mod = await import('../services/stockPrice');
    getMultipleStockPrices = mod.getMultipleStockPrices;
    invalidatePriceCache = mod.invalidatePriceCache;
    invalidatePriceCache(); // ensure clean state
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('first call fetches from upstream', async () => {
    const prices = await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(prices.size).toBe(1);
    expect(prices.get('005930')).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('second call within TTL hits cache (no fetch)', async () => {
    await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const prices = await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(prices.get('005930')).toBeGreaterThan(0);
    // Still only ONE fetch — second call served from cache
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the same cached value on repeated calls', async () => {
    const first = await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    const firstPrice = first.get('005930');

    const second = await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(second.get('005930')).toBe(firstPrice);
  });

  it('invalidatePriceCache() forces re-fetch on next call', async () => {
    await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    invalidatePriceCache();

    await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('mixed cached and uncached tickers only fetch missing ones', async () => {
    // Cache 005930
    await getMultipleStockPrices(['005930'], new Map([['005930', '']]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Now request both 005930 (cached) and 000660 (new)
    const prices = await getMultipleStockPrices(
      ['005930', '000660'],
      new Map([['005930', ''], ['000660', '']]),
    );
    expect(prices.size).toBe(2);
    // Only ONE additional fetch for 000660 (005930 served from cache)
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('empty ticker list returns empty map without fetching', async () => {
    const prices = await getMultipleStockPrices([], new Map());
    expect(prices.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('all-cached request makes zero fetches', async () => {
    // Pre-populate cache with two tickers
    await getMultipleStockPrices(
      ['005930', '000660'],
      new Map([['005930', ''], ['000660', '']]),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockClear();

    // Request the same two tickers again
    const prices = await getMultipleStockPrices(
      ['005930', '000660'],
      new Map([['005930', ''], ['000660', '']]),
    );
    expect(prices.size).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
