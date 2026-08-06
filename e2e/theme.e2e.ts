import { expect, test, type Page } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

async function installTokens(page: Page): Promise<void> {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
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
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#f8f3f8');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
    .toBe('#1b171d');
  const dark = await page.evaluate(() => ({
    topbar: getComputedStyle(document.querySelector('.topbar')!).backgroundColor,
    composer: getComputedStyle(document.querySelector('.composer')!).backgroundColor,
    body: getComputedStyle(document.body).color
  }));
  expect(dark.topbar).not.toBe('rgb(255, 255, 255)');
  expect(dark.composer).not.toBe('rgb(255, 255, 255)');
  expect(dark.body).toBe('rgb(244, 237, 245)');
});

test('themes chat, gallery and admin without horizontal overflow', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 844, height: 390 },
    { width: 1280, height: 860 }
  ]) {
    await page.setViewportSize(viewport);

    await page.goto('/');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const appWidth = await page.locator('.app').evaluate((element) => element.getBoundingClientRect().width);
    expect(appWidth).toBeLessThanOrEqual(900);

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
  await page.goto('/');
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
