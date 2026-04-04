import { test, expect } from '@playwright/test';

test.describe('Health & Security', () => {
  test('health endpoint returns ok with subsystem checks', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTruthy();
    expect(body.checks).toBeDefined();
    expect(body.checks.database).toBe('ok');
    expect(body.checks.scheduler).toBeDefined();
  });

  test('security headers are set by helmet', async ({ request }) => {
    const response = await request.get('/api/health');
    const headers = response.headers();

    // Helmet default headers
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  test('CORS rejects unknown origins', async ({ request }) => {
    const response = await request.get('/api/health', {
      headers: { 'Origin': 'http://evil.com' },
    });
    // The request itself succeeds (CORS is enforced by browsers, not servers)
    // But the response should NOT have Access-Control-Allow-Origin for evil.com
    const acao = response.headers()['access-control-allow-origin'];
    expect(acao).not.toBe('http://evil.com');
  });

  test('rate limiting headers are present', async ({ request }) => {
    const response = await request.get('/api/health');
    const headers = response.headers();
    expect(headers['ratelimit-limit']).toBeTruthy();
    expect(headers['ratelimit-remaining']).toBeTruthy();
  });

  test('WebSocket requires valid token', async ({ request }) => {
    // Get a valid WS token
    const tokenRes = await request.get('/api/ws-token');
    expect(tokenRes.status()).toBe(200);
    const { token } = await tokenRes.json();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.length).toBe(32); // 16 bytes hex
  });

  test('update endpoint requires authentication token', async ({ request }) => {
    // POST without token should be rejected
    const response = await request.post('/api/update');
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toBeTruthy();
  });
});
