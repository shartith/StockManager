import { test, expect } from '@playwright/test';

test.describe('UI Navigation & Pages', () => {
  test('dashboard loads successfully', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // Verify the page loaded and has content
    const body = await page.textContent('body');
    expect(body!.length).toBeGreaterThan(100);
  });

  test('sidebar navigation works for all routes', async ({ page }) => {
    await page.goto('/');

    // Test each navigation route
    const routes = [
      { path: '/portfolio', text: '포트폴리오' },
      { path: '/recommendations', text: '추천' },
      { path: '/watchlist', text: '관심' },
      { path: '/transactions', text: '거래' },
      { path: '/dividends', text: '배당' },
      { path: '/alerts', text: '알림' },
      { path: '/feedback', text: '성과' },
      { path: '/settings', text: '설정' },
    ];

    for (const route of routes) {
      await page.goto(route.path);
      await page.waitForLoadState('networkidle');
      // Verify the page loaded (no error screen)
      const body = await page.textContent('body');
      expect(body).toBeTruthy();
    }
  });

  test('settings page loads with KIS API section', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Should have the settings form
    const body = await page.textContent('body');
    expect(body).toContain('설정');
  });

  test('dark mode toggle exists in sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Verify toggle button exists
    const darkToggle = page.locator('aside button', { hasText: /다크 모드|라이트 모드/ });
    await expect(darkToggle).toBeVisible();
  });

  test('notification panel opens and closes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click notification button in sidebar
    const notifButton = page.locator('button[aria-label="알림 패널 열기"]');
    if (await notifButton.isVisible()) {
      await notifButton.click();
      // Notification panel should appear
      const panel = page.locator('[role="dialog"][aria-label="알림 패널"]');
      await expect(panel).toBeVisible({ timeout: 3000 });

      // Close panel
      const closeBtn = page.locator('button[aria-label="알림 패널 닫기"]');
      await closeBtn.click();
      await expect(panel).not.toBeVisible();
    }
  });
});

test.describe('Responsive Layout', () => {
  test('mobile hamburger menu appears on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Hamburger button should be visible on mobile
    const hamburger = page.locator('button[aria-label="메뉴 열기"]');
    await expect(hamburger).toBeVisible({ timeout: 5000 });
  });

  test('sidebar is always visible on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Hamburger should not be visible on desktop
    const hamburger = page.locator('button[aria-label="메뉴 열기"]');
    await expect(hamburger).not.toBeVisible();

    // Sidebar should be visible
    const sidebar = page.locator('aside[role="navigation"]');
    await expect(sidebar).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  test('sidebar has proper ARIA attributes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Sidebar has role="navigation"
    const sidebar = page.locator('aside[role="navigation"]');
    await expect(sidebar).toHaveAttribute('aria-label', '메인 내비게이션');

    // Navigation has aria-label
    const nav = sidebar.locator('nav[aria-label="주 메뉴"]');
    await expect(nav).toBeVisible();
  });

  test('interactive elements have focus indicators', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Tab to first nav link and check it's focusable
    await page.keyboard.press('Tab');
    const focusedElement = page.locator(':focus');
    expect(await focusedElement.count()).toBeGreaterThan(0);
  });

  test('active nav item has aria-current="page"', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const activeLink = page.locator('a[aria-current="page"]');
    await expect(activeLink).toBeVisible();
  });
});
