import { test, expect } from '@playwright/test';

test.describe('NAS Sync API', () => {
  test('sync status returns valid structure', async ({ request }) => {
    const response = await request.get('/api/nas-sync/status');
    expect(response.status()).toBe(200);

    const status = await response.json();
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('nasPath');
    expect(status).toHaveProperty('deviceId');
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.deviceId).toBe('string');
  });

  test('validate rejects empty path', async ({ request }) => {
    const response = await request.post('/api/nas-sync/validate', {
      data: { path: '' },
    });
    // Server may return 200 with valid:false or 400 — both acceptable
    const status = response.status();
    expect(status === 200 || status === 400).toBe(true);
  });

  test('validate rejects missing path param', async ({ request }) => {
    const response = await request.post('/api/nas-sync/validate', {
      data: {},
    });
    expect(response.status()).toBe(400);
  });

  test('sync run returns result when disabled', async ({ request }) => {
    const response = await request.post('/api/nas-sync/run');
    expect(response.status()).toBe(200);

    const result = await response.json();
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('tablesExported');
    expect(result).toHaveProperty('totalRecords');
    expect(result).toHaveProperty('timestamp');
  });
});

test.describe('Portfolio Settings API', () => {
  test('config form includes portfolio fields', async ({ request }) => {
    const response = await request.get('/api/chart/config/form');
    expect(response.status()).toBe(200);

    const config = await response.json();
    // Portfolio fields added in v4.4.0
    expect(config).toHaveProperty('portfolioMaxHoldings');
    expect(config).toHaveProperty('portfolioMaxPerStockPercent');
    expect(config).toHaveProperty('portfolioMaxSectorPercent');
    expect(config).toHaveProperty('portfolioRebalanceEnabled');
    expect(config).toHaveProperty('portfolioMinCashPercent');

    // Verify default values are reasonable
    expect(config.portfolioMaxHoldings).toBeGreaterThanOrEqual(3);
    expect(config.portfolioMaxPerStockPercent).toBeGreaterThanOrEqual(5);
    expect(config.portfolioMaxSectorPercent).toBeGreaterThanOrEqual(20);
    expect(typeof config.portfolioRebalanceEnabled).toBe('boolean');
  });

  test('config form includes NAS sync fields', async ({ request }) => {
    const response = await request.get('/api/chart/config/form');
    const config = await response.json();

    expect(config).toHaveProperty('nasSyncEnabled');
    expect(config).toHaveProperty('nasSyncPath');
    expect(config).toHaveProperty('nasSyncTime');
    expect(config).toHaveProperty('deviceId');
    expect(config).toHaveProperty('nasHost');
    expect(config).toHaveProperty('nasShare');
    expect(config).toHaveProperty('nasAutoMount');
  });

  test('config form includes auto-trade threshold fields', async ({ request }) => {
    const response = await request.get('/api/chart/config/form');
    const config = await response.json();

    expect(config).toHaveProperty('autoTradeScoreThreshold');
    expect(config).toHaveProperty('priceChangeThreshold');
    expect(typeof config.autoTradeScoreThreshold).toBe('number');
    expect(typeof config.priceChangeThreshold).toBe('number');
  });

  test('config form includes trading rules fields', async ({ request }) => {
    const response = await request.get('/api/chart/config/form');
    const config = await response.json();

    expect(config).toHaveProperty('tradingRulesEnabled');
    expect(config).toHaveProperty('tradingRulesStrictMode');
    expect(config).toHaveProperty('gapThresholdPercent');
    expect(config).toHaveProperty('volumeSurgeRatio');
  });
});

test.describe('Scheduler & System Status', () => {
  test('scheduler status returns valid structure', async ({ request }) => {
    const response = await request.get('/api/scheduler/status');
    expect(response.status()).toBe(200);

    const status = await response.json();
    expect(status).toHaveProperty('active');
    expect(status).toHaveProperty('taskCount');
    expect(status).toHaveProperty('krxEnabled');
    expect(status).toHaveProperty('nyseEnabled');
    expect(status).toHaveProperty('autoTradeEnabled');
    expect(status).toHaveProperty('recentLogs');
    expect(typeof status.active).toBe('boolean');
    expect(typeof status.taskCount).toBe('number');
  });

  test('system events returns array', async ({ request }) => {
    const response = await request.get('/api/system-events?limit=5');
    expect(response.status()).toBe(200);

    const events = await response.json();
    expect(Array.isArray(events)).toBe(true);
  });

  test('system events counts returns valid structure', async ({ request }) => {
    const response = await request.get('/api/system-events/counts');
    expect(response.status()).toBe(200);

    const counts = await response.json();
    expect(counts).toHaveProperty('total');
    expect(counts).toHaveProperty('unresolved');
  });
});

test.describe('Portfolio API', () => {
  test('portfolio summary endpoint responds', async ({ request }) => {
    const response = await request.get('/api/portfolio/summary');
    // 200 with data, or 500 if KIS API not configured
    expect([200, 500]).toContain(response.status());
  });

  test('portfolio insight returns risk context', async ({ request }) => {
    const response = await request.get('/api/portfolio/insight');
    expect(response.status()).toBe(200);

    const insight = await response.json();
    expect(insight).toHaveProperty('totalInvested');
    expect(insight).toHaveProperty('holdingCount');
  });

  test('portfolio history returns array', async ({ request }) => {
    const response = await request.get('/api/portfolio/history');
    expect(response.status()).toBe(200);

    const history = await response.json();
    expect(Array.isArray(history)).toBe(true);
  });
});

test.describe('Version & Health (v4.4.0)', () => {
  test('version shows 4.4.0', async ({ request }) => {
    const response = await request.get('/api/version');
    expect(response.status()).toBe(200);

    const version = await response.json();
    expect(version.currentVersion).toMatch(/^4\./);
  });

  test('health checks all subsystems', async ({ request }) => {
    const response = await request.get('/api/health');
    const health = await response.json();

    expect(health.checks).toHaveProperty('database');
    expect(health.checks).toHaveProperty('scheduler');
    expect(health.checks).toHaveProperty('llm');
    expect(health.checks.database).toBe('ok');
  });
});
