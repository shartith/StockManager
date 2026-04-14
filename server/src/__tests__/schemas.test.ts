/**
 * zod schema validation coverage (schemas/index.ts was at 58.82%)
 *
 * Pure validation — no DB, no fetch. Covers happy path + failure branches +
 * default propagation + refine() predicates on saveConfigSchema (SSRF block,
 * URL validity) and updateWatchlistSchema (no-op guard).
 */

import { describe, it, expect } from 'vitest';
import {
  createStockSchema,
  updateStockSchema,
  createTransactionSchema,
  createDividendSchema,
  createAlertSchema,
  updateAlertSchema,
  createWatchlistSchema,
  updateWatchlistSchema,
  createRecommendationSchema,
  updateRecommendationStatusSchema,
  generateRecommendationSchema,
  decisionSchema,
  pullModelSchema,
  saveConfigSchema,
  resolveEventSchema,
  backtestSchema,
  configRestoreSchema,
  strategyImportSchema,
  updateTradingRuleSchema,
} from '../schemas';

describe('createStockSchema', () => {
  it('uppercases ticker and applies defaults', () => {
    const out = createStockSchema.parse({ ticker: 'aapl', name: 'Apple' });
    expect(out.ticker).toBe('AAPL');
    expect(out.market).toBe('');
    expect(out.sector).toBe('');
  });

  it('rejects empty ticker', () => {
    expect(() => createStockSchema.parse({ ticker: '', name: 'X' })).toThrow();
  });

  it('rejects empty name', () => {
    expect(() => createStockSchema.parse({ ticker: 'X', name: '' })).toThrow();
  });
});

describe('updateStockSchema', () => {
  it('accepts any subset of optional fields', () => {
    expect(updateStockSchema.parse({})).toEqual({});
    expect(updateStockSchema.parse({ name: 'New' })).toEqual({ name: 'New' });
  });
});

describe('createTransactionSchema', () => {
  it('accepts a valid BUY transaction', () => {
    const t = createTransactionSchema.parse({
      stock_id: 1,
      type: 'BUY',
      quantity: 10,
      price: 70000,
      date: '2026-04-07',
    });
    expect(t.fee).toBe(0); // default
    expect(t.memo).toBe('');
  });

  it('rejects non-BUY/SELL type', () => {
    expect(() => createTransactionSchema.parse({
      stock_id: 1, type: 'HOLD', quantity: 1, price: 1, date: '2026-04-07',
    })).toThrow();
  });

  it('rejects negative quantity', () => {
    expect(() => createTransactionSchema.parse({
      stock_id: 1, type: 'BUY', quantity: -1, price: 1, date: '2026-04-07',
    })).toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => createTransactionSchema.parse({
      stock_id: 1, type: 'BUY', quantity: 1, price: 1, date: '2026/04/07',
    })).toThrow();
  });

  it('rejects non-positive stock_id', () => {
    expect(() => createTransactionSchema.parse({
      stock_id: 0, type: 'BUY', quantity: 1, price: 1, date: '2026-04-07',
    })).toThrow();
  });
});

describe('createDividendSchema', () => {
  it('requires positive amount', () => {
    expect(() => createDividendSchema.parse({
      stock_id: 1, amount: 0, date: '2026-04-07',
    })).toThrow();
  });

  it('accepts valid dividend with default memo', () => {
    const d = createDividendSchema.parse({ stock_id: 1, amount: 100, date: '2026-04-07' });
    expect(d.memo).toBe('');
  });
});

describe('createAlertSchema + updateAlertSchema', () => {
  it('accepts known alert types', () => {
    for (const type of ['PRICE_ABOVE', 'PRICE_BELOW', 'PROFIT_TARGET']) {
      expect(() => createAlertSchema.parse({ stock_id: 1, type, value: 100 })).not.toThrow();
    }
  });

  it('rejects unknown alert type', () => {
    expect(() => createAlertSchema.parse({ stock_id: 1, type: 'BAD', value: 1 })).toThrow();
  });

  it('updateAlertSchema requires is_active boolean', () => {
    expect(() => updateAlertSchema.parse({ is_active: 'yes' })).toThrow();
    expect(updateAlertSchema.parse({ is_active: true }).is_active).toBe(true);
  });
});

describe('createWatchlistSchema + updateWatchlistSchema', () => {
  it('applies defaults', () => {
    const w = createWatchlistSchema.parse({ stock_id: 1 });
    expect(w.notes).toBe('');
    expect(w.auto_trade_enabled).toBe(false);
  });

  it('updateWatchlistSchema rejects empty update (refine guard)', () => {
    expect(() => updateWatchlistSchema.parse({})).toThrow();
  });

  it('updateWatchlistSchema accepts partial update with just auto_trade_enabled', () => {
    const out = updateWatchlistSchema.parse({ auto_trade_enabled: true });
    expect(out.auto_trade_enabled).toBe(true);
  });

  it('updateWatchlistSchema accepts partial update with just notes', () => {
    const out = updateWatchlistSchema.parse({ notes: 'hello' });
    expect(out.notes).toBe('hello');
  });
});

describe('createRecommendationSchema', () => {
  it('defaults signal_type to BUY and confidence to 0', () => {
    const r = createRecommendationSchema.parse({ ticker: 'AAPL', name: 'Apple' });
    expect(r.signal_type).toBe('BUY');
    expect(r.confidence).toBe(0);
    expect(r.market).toBe('KRX');
  });

  it('clamps confidence to 0-100 range', () => {
    expect(() => createRecommendationSchema.parse({ ticker: 'X', name: 'X', confidence: 150 })).toThrow();
    expect(() => createRecommendationSchema.parse({ ticker: 'X', name: 'X', confidence: -1 })).toThrow();
  });
});

describe('updateRecommendationStatusSchema + generateRecommendationSchema + decisionSchema + pullModelSchema', () => {
  it('rejects unknown recommendation status', () => {
    expect(() => updateRecommendationStatusSchema.parse({ status: 'NEW' })).toThrow();
  });

  it('accepts known recommendation statuses', () => {
    for (const status of ['ACTIVE', 'EXECUTED', 'EXPIRED', 'DISMISSED']) {
      expect(updateRecommendationStatusSchema.parse({ status }).status).toBe(status);
    }
  });

  it('generateRecommendationSchema defaults market to KRX', () => {
    expect(generateRecommendationSchema.parse({}).market).toBe('KRX');
  });

  it('decisionSchema defaults phase to PRE_OPEN', () => {
    expect(decisionSchema.parse({}).phase).toBe('PRE_OPEN');
  });

  it('decisionSchema rejects unknown phase', () => {
    expect(() => decisionSchema.parse({ phase: 'WEEKEND' })).toThrow();
  });

  it('pullModelSchema requires non-empty model', () => {
    expect(() => pullModelSchema.parse({ model: '' })).toThrow();
    expect(pullModelSchema.parse({ model: 'mlx-community/gemma-3n-E4B-it-4bit' }).model).toBe('mlx-community/gemma-3n-E4B-it-4bit');
  });
});

describe('saveConfigSchema — SSRF guards and URL validation', () => {
  const valid = () => ({ appKey: 'test-key' });

  it('applies sensible defaults', () => {
    const c = saveConfigSchema.parse(valid());
    expect(c.mlxUrl).toBe('http://localhost:8000');
    expect(c.mlxModel).toBe('mlx-community/gemma-3n-E4B-it-4bit');
    expect(c.isVirtual).toBe(true);
    expect(c.autoTradeEnabled).toBe(false);
    expect(c.portfolioMaxHoldings).toBe(10);
  });

  it('rejects empty appKey', () => {
    expect(() => saveConfigSchema.parse({ appKey: '' })).toThrow();
  });

  it('blocks AWS metadata endpoint in mlxUrl', () => {
    expect(() => saveConfigSchema.parse({
      ...valid(), mlxUrl: 'http://169.254.169.254/latest',
    })).toThrow(/유효한 http/);
  });

  it('blocks Alibaba Cloud metadata endpoint in mlxUrl', () => {
    expect(() => saveConfigSchema.parse({
      ...valid(), mlxUrl: 'http://100.100.100.200/',
    })).toThrow();
  });

  it('blocks GCP metadata hostname in mlxUrl', () => {
    expect(() => saveConfigSchema.parse({
      ...valid(), mlxUrl: 'http://metadata.google.internal/',
    })).toThrow();
  });

  it('rejects non-http protocol in mlxUrl', () => {
    expect(() => saveConfigSchema.parse({
      ...valid(), mlxUrl: 'file:///etc/passwd',
    })).toThrow();
  });

  it('rejects malformed URL in mlxUrl', () => {
    expect(() => saveConfigSchema.parse({
      ...valid(), mlxUrl: 'not a url at all',
    })).toThrow();
  });

  it('accepts empty mlxUrl (will use default)', () => {
    const c = saveConfigSchema.parse({ ...valid(), mlxUrl: '' });
    // empty passes refine, then default kicks in
    expect(typeof c.mlxUrl).toBe('string');
  });

  it('rejects out-of-range autoTradeScoreThreshold', () => {
    expect(() => saveConfigSchema.parse({ ...valid(), autoTradeScoreThreshold: 10 })).toThrow();
    expect(() => saveConfigSchema.parse({ ...valid(), autoTradeScoreThreshold: 500 })).toThrow();
  });

  it('rejects out-of-range portfolioMaxHoldings', () => {
    expect(() => saveConfigSchema.parse({ ...valid(), portfolioMaxHoldings: 1 })).toThrow();
    expect(() => saveConfigSchema.parse({ ...valid(), portfolioMaxHoldings: 100 })).toThrow();
  });

  it('rejects malformed nasSyncTime cron', () => {
    expect(() => saveConfigSchema.parse({ ...valid(), nasSyncTime: 'not a cron' })).toThrow();
  });

  it('accepts empty nasSyncTime', () => {
    const c = saveConfigSchema.parse({ ...valid(), nasSyncTime: '' });
    expect(c.nasSyncTime).toBe('');
  });

  it('validates schedule sub-objects when provided', () => {
    const c = saveConfigSchema.parse({
      ...valid(),
      scheduleKrx: { enabled: true, preOpen: true, postOpen: false, preClose1h: true, preClose30m: false },
    });
    expect(c.scheduleKrx?.enabled).toBe(true);
  });
});

describe('resolveEventSchema', () => {
  it('defaults resolution when omitted', () => {
    expect(resolveEventSchema.parse({}).resolution).toBe('수동 해결');
  });
});

describe('backtestSchema', () => {
  const makeCandles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      time: `2026-04-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 110, low: 95, close: 105, volume: 1000,
    }));

  it('rejects fewer than 60 candles', () => {
    expect(() => backtestSchema.parse({
      name: 'test', candles: makeCandles(10), initialCapital: 1000000,
    })).toThrow(/최소 60/);
  });

  it('rejects more than 2000 candles', () => {
    expect(() => backtestSchema.parse({
      name: 'test', candles: makeCandles(2001), initialCapital: 1000000,
    })).toThrow(/최대 2000/);
  });

  it('rejects non-positive initialCapital', () => {
    expect(() => backtestSchema.parse({
      name: 'test', candles: makeCandles(60), initialCapital: 0,
    })).toThrow();
  });

  it('accepts 60-candle backtest with defaults', () => {
    const b = backtestSchema.parse({
      name: 'test', candles: makeCandles(60), initialCapital: 1000000,
    });
    expect(b.candles).toHaveLength(60);
  });
});

describe('configRestoreSchema + strategyImportSchema', () => {
  it('configRestoreSchema requires settings object', () => {
    expect(() => configRestoreSchema.parse({})).toThrow();
    expect(configRestoreSchema.parse({ settings: { a: 1 } })).toBeDefined();
  });

  it('strategyImportSchema requires version, settings, weights', () => {
    expect(() => strategyImportSchema.parse({ version: '1', settings: {} })).toThrow();
    const s = strategyImportSchema.parse({ version: '1', settings: {}, weights: {} });
    expect(s.version).toBe('1');
  });
});

describe('updateTradingRuleSchema', () => {
  it('rejects empty update (refine guard)', () => {
    expect(() => updateTradingRuleSchema.parse({})).toThrow();
  });

  it('accepts is_enabled toggle alone', () => {
    const r = updateTradingRuleSchema.parse({ is_enabled: false });
    expect(r.is_enabled).toBe(false);
  });

  it('accepts params_json alone', () => {
    const r = updateTradingRuleSchema.parse({ params_json: { threshold: 5 } });
    expect(r.params_json?.threshold).toBe(5);
  });
});
