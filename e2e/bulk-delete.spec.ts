/**
 * v4.7.1–v4.7.3: 시스템 이벤트 / 알림 bulk delete + validation
 *
 * - /api/system-events/all?resolved=true (v4.7.1)
 * - /api/system-events/all (v4.7.1)
 * - /api/notifications/all (v4.7.1)
 * - DELETE /api/notifications/:id input validation (v4.7.3)
 * - PATCH /api/notifications/:id/read input validation (v4.7.3)
 * - CRITICAL guard via the UI은 별도 UI 스펙에서 검증
 */

import { test, expect } from '@playwright/test';

test.describe('System Events bulk delete (v4.7.1+)', () => {
  test('DELETE /system-events/all returns deleted count', async ({ request }) => {
    const res = await request.delete('/api/system-events/all');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('deleted');
    expect(typeof body.deleted).toBe('number');
    expect(body.deleted).toBeGreaterThanOrEqual(0);
  });

  test('DELETE /system-events/all?resolved=true only deletes resolved', async ({ request }) => {
    const res = await request.delete('/api/system-events/all', {
      params: { resolved: 'true' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('deleted');
    expect(body.deleted).toBeGreaterThanOrEqual(0);
  });

  test('DELETE /system-events/:id with invalid id is rejected', async ({ request }) => {
    // :id route uses Number(id) — "abc" NaN should be rejected via !Number.isFinite
    const res = await request.delete('/api/system-events/abc');
    // 400 (validated) 또는 404 (route not matching) — 어느 쪽이든 200은 아니어야 한다
    expect([400, 404]).toContain(res.status());
  });

  test('counts endpoint reflects empty state after bulk delete', async ({ request }) => {
    await request.delete('/api/system-events/all');
    const res = await request.get('/api/system-events/counts');
    expect(res.status()).toBe(200);
    const counts = await res.json();
    expect(counts.unresolved).toBe(0);
  });
});

test.describe('Notifications bulk delete + validation (v4.7.1–v4.7.3)', () => {
  test('DELETE /notifications/all returns deleted count', async ({ request }) => {
    const res = await request.delete('/api/notifications/all');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('deleted');
    expect(typeof body.deleted).toBe('number');
  });

  test('GET /notifications returns zero unread after bulk delete', async ({ request }) => {
    await request.delete('/api/notifications/all');
    const res = await request.get('/api/notifications/unread-count');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  test('DELETE /notifications/:id with non-numeric id returns 400 (v4.7.3 validation)', async ({ request }) => {
    const res = await request.delete('/api/notifications/not-a-number');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('PATCH /notifications/:id/read with non-numeric id returns 400 (v4.7.3 validation)', async ({ request }) => {
    const res = await request.patch('/api/notifications/not-a-number/read');
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  test('DELETE /notifications/all route is matched before /:id (express ordering)', async ({ request }) => {
    // "all" must NOT be parsed as an id; 이전에는 Number("all") = NaN으로 route 충돌 가능성 있었음
    const res = await request.delete('/api/notifications/all');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('deleted');
    expect(body).not.toHaveProperty('error');
  });
});
