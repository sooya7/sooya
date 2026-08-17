import { expect, test, type Page } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';

async function installTokens(page: Page): Promise<void> {
  await page.addInitScript(({ admin }) => {
    localStorage.setItem('sooya.admin-token', admin);
  }, { admin: ADMIN_TOKEN });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport);
}

test.beforeEach(async ({ page }) => { await installTokens(page); });

test('follows the system light and warm-dark palettes', async ({ page }) => {
  // 根 CSS 变量是全局主题；Admin 页面加载后即可验证（Web Chat 已下线）。
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/admin');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#f8f3f8');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#1b171d');
  const dark = await page.evaluate(() => ({
    body: getComputedStyle(document.body).color
  }));
  expect(dark.body).toBe('rgb(244, 237, 245)');
});

test('themes gallery and admin without horizontal overflow', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 844, height: 390 },
    { width: 1280, height: 860 }
  ]) {
    await page.setViewportSize(viewport);

    await page.goto('/gallery');
    await expect(page.locator('.gallery-page')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto('/admin/features');
    await expect(page.locator('.admin-v2')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('reduces shimmer and transition motion without hiding loading surfaces', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/admin');
  const motion = await page.evaluate(() => {
    const placeholder = document.createElement('span');
    placeholder.className = 'image-part-placeholder';
    document.body.append(placeholder);
    const style = getComputedStyle(placeholder);
    const result = { duration: style.animationDuration, iterations: style.animationIterationCount };
    placeholder.remove();
    return result;
  });
  const durationMs = motion.duration.endsWith('ms')
    ? Number.parseFloat(motion.duration)
    : Number.parseFloat(motion.duration) * 1000;
  expect(durationMs).toBeLessThanOrEqual(0.01);
  expect(motion.iterations).toBe('1');
});
