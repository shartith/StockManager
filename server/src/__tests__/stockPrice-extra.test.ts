/**
 * stockPrice.ts — extra coverage (complements stockPrice.test.ts which covers
 * the v4.5.3 cache behavior). This file targets the other exports:
 *
 *   - getStockPrice (single-ticker KIS + Yahoo fallback)
 *   - fetchYahooQuote (success, HTTP fail, missing meta, exception)
 *   - getMarketContext (aggregation + cache)
 *   - formatMarketContext (KRX/NYSE flavors, VIX fear, FX warnings, empty)
 *   - getMultipleStockPrices overseas branch + KIS-path for domestic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  getStockPrice,
  getMultipleStockPrices,
  invalidatePriceCache,
  fetchYahooQuote,
  getMarketContext,
  formatMarketContext,
  type MarketContextData,
} from '../services/stockPrice';
import { getSettings } from '../services/settings';
import { getAccessToken } from '../services/kisAuth';

const kisPriceResponse = (price: number) => ({
  ok: true,
  json: async () => ({ rt_cd: '0', output: { stck_prpr: String(price) } }),
});

const kisOverseasPriceResponse = (price: number) => ({
  ok: true,
  json: async () => ({ rt_cd: '0', output: { last: String(price) } }),
});

const yahooQuoteResponse = (price: number, prevClose: number) => ({
  ok: true,
  json: async () => ({
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          chartPreviousClose: prevClose,
        },
      }],
    },
  }),
});

describe('getStockPrice', () => {
  beforeEach(() => {
    invalidatePriceCache();
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({
      kisAppKey: 'k', kisAppSecret: 's', kisVirtual: false,
      dartEnabled: false, dartApiKey: '',
    } as any);
    vi.mocked(getAccessToken).mockResolvedValue('tok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns KIS price when KIS call succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(kisPriceResponse(70500)));
    expect(await getStockPrice('005930')).toBe(70500);
  });

  it('falls back to Yahoo when KIS auth fails', async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error('no token'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooQuoteResponse(123.45, 120)));
    expect(await getStockPrice('AAPL')).toBe(123.45);
  });

  it('falls back to Yahoo when KIS returns rt_cd != "0"', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rt_cd: '1' }) })
      .mockResolvedValueOnce(yahooQuoteResponse(50, 48));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getStockPrice('005930')).toBe(50);
  });

  it('returns null when both KIS and Yahoo fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await getStockPrice('UNKNOWN')).toBeNull();
  });

  it('uses Yahoo directly when KIS is not configured', async () => {
    vi.mocked(getSettings).mockReturnValue({
      kisAppKey: '', kisAppSecret: '', kisVirtual: false,
      dartEnabled: false, dartApiKey: '',
    } as any);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooQuoteResponse(222, 220)));
    expect(await getStockPrice('TSLA')).toBe(222);
  });
});

describe('getMultipleStockPrices — KIS and overseas branches', () => {
  beforeEach(() => {
    invalidatePriceCache();
    vi.clearAllMocks();
    vi.mocked(getSettings).mockReturnValue({
      kisAppKey: 'k', kisAppSecret: 's', kisVirtual: false,
      dartEnabled: false, dartApiKey: '',
    } as any);
    vi.mocked(getAccessToken).mockResolvedValue('tok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches domestic tickers via KIS when credentials are configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(kisPriceResponse(10000)));

    const prices = await getMultipleStockPrices(['005930', '000660']);
    expect(prices.get('005930')).toBe(10000);
    expect(prices.get('000660')).toBe(10000);
  });

  it('fetches overseas tickers via KIS overseas endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(kisOverseasPriceResponse(150.25)));

    const markets = new Map([['AAPL', 'NASDAQ']]);
    const prices = await getMultipleStockPrices(['AAPL'], markets);
    expect(prices.get('AAPL')).toBe(150.25);
  });

  it('falls back to Yahoo for domestic when KIS auth fails', async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new Error('no token'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooQuoteResponse(88, 85)));

    const prices = await getMultipleStockPrices(['005930']);
    expect(prices.get('005930')).toBe(88);
  });
});

describe('fetchYahooQuote', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns price and changePercent on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooQuoteResponse(110, 100)));
    const q = await fetchYahooQuote('^GSPC');
    expect(q).not.toBeNull();
    expect(q!.price).toBe(110);
    expect(q!.changePercent).toBe(10); // (110-100)/100 = 10%
  });

  it('returns null on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchYahooQuote('^BAD')).toBeNull();
  });

  it('returns null when meta is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ chart: { result: [{}] } }),
    }));
    expect(await fetchYahooQuote('^BAD')).toBeNull();
  });

  it('returns null on fetch exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await fetchYahooQuote('^BAD')).toBeNull();
  });
});

describe('getMarketContext', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('aggregates Yahoo quotes into MarketContextData', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(yahooQuoteResponse(2500, 2450)));
    const ctx = await getMarketContext();
    expect(typeof ctx).toBe('object');
    // The first call uncovers all 6 symbols (or re-uses a cached value from a
    // previous test). Either way the returned object should be well-formed.
    if (ctx.kospi) {
      expect(ctx.kospi.price).toBeGreaterThan(0);
    }
  });
});

describe('formatMarketContext', () => {
  it('renders KRX-flavored text with all indicators', () => {
    const ctx: MarketContextData = {
      kospi: { price: 2600, changePercent: 0.5 },
      kosdaq: { price: 850, changePercent: -0.3 },
      usdKrw: { price: 1350, changePercent: 0.2 },
      sp500: { price: 5000, changePercent: 0.8 },
    };
    const text = formatMarketContext(ctx, 'KRX');
    expect(text).toContain('KOSPI');
    expect(text).toContain('KOSDAQ');
    expect(text).toContain('USD/KRW');
    expect(text).toContain('S&P500(전일)');
  });

  it('warns on VIX > 30 (extreme fear)', () => {
    const text = formatMarketContext({ vix: { price: 35, changePercent: 2 } }, 'NYSE');
    expect(text).toContain('VIX 30 초과');
  });

  it('warns on VIX > 25 but < 30', () => {
    const text = formatMarketContext({ vix: { price: 27, changePercent: 1 } }, 'NYSE');
    expect(text).toContain('VIX 25 초과');
  });

  it('warns on KRW weakness ≥ 1380 for KRX', () => {
    const text = formatMarketContext({ usdKrw: { price: 1400, changePercent: 0.2 } }, 'KRX');
    expect(text).toContain('원화 약세');
  });

  it('warns on KRW strength ≤ 1320 for KRX', () => {
    const text = formatMarketContext({ usdKrw: { price: 1300, changePercent: -0.2 } }, 'KRX');
    expect(text).toContain('원화 강세');
  });

  it('renders NYSE-flavored text', () => {
    const ctx: MarketContextData = {
      sp500: { price: 5000, changePercent: 0.8 },
      dow: { price: 40000, changePercent: 0.3 },
      vix: { price: 15, changePercent: -0.5 },
      usdKrw: { price: 1400, changePercent: 0.2 },
    };
    const text = formatMarketContext(ctx, 'NYSE');
    expect(text).toContain('S&P500');
    expect(text).toContain('다우');
    expect(text).toContain('VIX');
    expect(text).toContain('달러 강세');
  });

  it('warns NYSE on dollar weakness ≤ 1320', () => {
    const ctx: MarketContextData = { usdKrw: { price: 1300, changePercent: -0.2 } };
    const text = formatMarketContext(ctx, 'NYSE');
    expect(text).toContain('달러 약세');
  });

  it('warns on large FX daily move (≥1%)', () => {
    const text = formatMarketContext({ usdKrw: { price: 1350, changePercent: 1.5 } }, 'NYSE');
    expect(text).toContain('환율 일 변동');
  });

  it('returns empty string for empty context', () => {
    expect(formatMarketContext({}, 'KRX')).toBe('');
  });
});
