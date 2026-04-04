import { test, expect } from '@playwright/test';

function uniqueTicker(prefix: string): string {
  return `${prefix}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

test.describe('Stocks CRUD API', () => {
  test('create, list, update, delete stock lifecycle', async ({ request }) => {
    const ticker = uniqueTicker('CRD');

    // Create
    const createRes = await request.post('/api/stocks', {
      data: { ticker, name: 'E2E 라이프사이클', market: 'KRX', sector: '테스트' },
    });
    expect(createRes.status()).toBe(201);
    const stock = await createRes.json();
    expect(stock.ticker).toBe(ticker);
    const stockId = stock.id;

    // List (should include it)
    const listRes = await request.get('/api/stocks');
    expect(listRes.status()).toBe(200);
    const stocks = await listRes.json();
    expect(stocks.find((s: any) => s.ticker === ticker)).toBeTruthy();

    // Update
    const updateRes = await request.put(`/api/stocks/${stockId}`, {
      data: { name: 'E2E 수정됨' },
    });
    expect(updateRes.status()).toBe(200);
    expect((await updateRes.json()).name).toBe('E2E 수정됨');

    // Delete (soft)
    const deleteRes = await request.delete(`/api/stocks/${stockId}`);
    expect(deleteRes.status()).toBe(200);

    // Should not appear in list
    const list2 = await (await request.get('/api/stocks')).json();
    expect(list2.find((s: any) => s.id === stockId)).toBeUndefined();
  });

  test('rejects duplicate ticker', async ({ request }) => {
    const ticker = uniqueTicker('DUP');
    await request.post('/api/stocks', { data: { ticker, name: '원본' } });
    const response = await request.post('/api/stocks', { data: { ticker, name: '중복' } });
    expect(response.status()).toBe(409);
  });

  test('validates required fields', async ({ request }) => {
    const response = await request.post('/api/stocks', { data: { ticker: '' } });
    expect(response.status()).toBe(400);
  });
});

test.describe('Transactions API', () => {
  test('full buy/sell lifecycle with validation', async ({ request }) => {
    const ticker = uniqueTicker('TX');
    const stockRes = await request.post('/api/stocks', {
      data: { ticker, name: 'TX 테스트', market: 'KRX' },
    });
    expect(stockRes.status()).toBe(201);
    const stockId = (await stockRes.json()).id;

    // Validate date format
    const badDate = await request.post('/api/transactions', {
      data: { stock_id: stockId, type: 'BUY', quantity: 10, price: 50000, date: 'bad-date' },
    });
    expect(badDate.status()).toBe(400);

    // Buy
    const buyRes = await request.post('/api/transactions', {
      data: { stock_id: stockId, type: 'BUY', quantity: 10, price: 50000, date: '2024-01-15' },
    });
    expect(buyRes.status()).toBe(201);
    expect((await buyRes.json()).type).toBe('BUY');

    // Prevent oversell
    const oversellRes = await request.post('/api/transactions', {
      data: { stock_id: stockId, type: 'SELL', quantity: 999, price: 50000, date: '2024-01-16' },
    });
    expect(oversellRes.status()).toBe(400);

    // Valid sell
    const sellRes = await request.post('/api/transactions', {
      data: { stock_id: stockId, type: 'SELL', quantity: 5, price: 55000, date: '2024-01-16' },
    });
    expect(sellRes.status()).toBe(201);
  });
});

test.describe('Trading Rules API', () => {
  test('can list all 14 trading rules', async ({ request }) => {
    const response = await request.get('/api/trading-rules');
    expect(response.status()).toBe(200);

    const rules = await response.json();
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBe(14);

    const categories = new Set(rules.map((r: any) => r.category));
    expect(categories.has('TIME')).toBe(true);
    expect(categories.has('VOLUME')).toBe(true);
    expect(categories.has('VOLATILITY')).toBe(true);
    expect(categories.has('CANDLE')).toBe(true);
    expect(categories.has('SUPPORT')).toBe(true);
  });

  test('can toggle a rule on/off', async ({ request }) => {
    const disableRes = await request.patch('/api/trading-rules/SIDEWAYS_NO_TRADE', {
      data: { is_enabled: false },
    });
    expect(disableRes.status()).toBe(200);

    const listRes = await request.get('/api/trading-rules');
    const rules = await listRes.json();
    const rule = rules.find((r: any) => r.rule_id === 'SIDEWAYS_NO_TRADE');
    expect(rule.is_enabled).toBe(false);

    // Re-enable
    await request.patch('/api/trading-rules/SIDEWAYS_NO_TRADE', {
      data: { is_enabled: true },
    });
  });

  test('can update rule params with numeric values', async ({ request }) => {
    const response = await request.patch('/api/trading-rules/MORNING_SURGE_SELL', {
      data: { params_json: { gapThreshold: 5 } },
    });
    expect(response.status()).toBe(200);
  });

  test('rejects non-existent rule', async ({ request }) => {
    const response = await request.patch('/api/trading-rules/NONEXISTENT_RULE', {
      data: { is_enabled: false },
    });
    expect(response.status()).toBe(404);
  });

  test('validates empty update body', async ({ request }) => {
    const response = await request.patch('/api/trading-rules/SIDEWAYS_NO_TRADE', {
      data: {},
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('Alerts API', () => {
  test('alert lifecycle: create, toggle, delete', async ({ request }) => {
    const ticker = uniqueTicker('ALT');
    const stockRes = await request.post('/api/stocks', {
      data: { ticker, name: '알림 테스트', market: 'KRX' },
    });
    expect(stockRes.status()).toBe(201);
    const stockId = (await stockRes.json()).id;

    // Create alert
    const createRes = await request.post('/api/alerts', {
      data: { stock_id: stockId, type: 'PRICE_ABOVE', value: 100000 },
    });
    expect(createRes.status()).toBe(201);
    const alertId = (await createRes.json()).id;

    // Reject invalid type
    const invalidRes = await request.post('/api/alerts', {
      data: { stock_id: stockId, type: 'INVALID_TYPE', value: 100000 },
    });
    expect(invalidRes.status()).toBe(400);

    // Toggle
    const toggleRes = await request.patch(`/api/alerts/${alertId}`, {
      data: { is_active: false },
    });
    expect(toggleRes.status()).toBe(200);

    // Cleanup
    await request.delete(`/api/alerts/${alertId}`);
  });
});
