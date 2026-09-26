import { type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { CONSOLE_PAGES, expectNoHorizontalOverflow, installAdminToken, pageTitle, section, waitForLoaded } from './helpers.js';

/**
 * Theme of the console: the palette lives in CSS variables on `.cs`
 * (console/console.css) and follows the system light/dark preference; no page
 * scrolls sideways on phone, phone-landscape or desktop; reduced motion squeezes
 * animations and transitions without hiding loading states.
 */

const LIGHT = { ground: '#e2e8e3', paper: '#f4f6f2', ink: '#22303a', inkRgb: 'rgb(34, 48, 58)', groundRgb: 'rgb(226, 232, 227)' };
const DARK = { ground: '#0d1216', paper: '#141b20', ink: '#e3e9e5', inkRgb: 'rgb(227, 233, 229)', groundRgb: 'rgb(13, 18, 22)' };

async function palette(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.cs')!;
    const style = getComputedStyle(root);
    return {
      ground: style.getPropertyValue('--c-ground').trim(),
      paper: style.getPropertyValue('--c-paper').trim(),
      ink: style.getPropertyValue('--c-ink').trim(),
      color: style.color,
      background: style.backgroundColor,
      scheme: style.colorScheme,
      body: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor
    };
  });
}

function expected(p: typeof LIGHT, scheme: 'light' | 'dark') {
  return { ground: p.ground, paper: p.paper, ink: p.ink, color: p.inkRgb, background: p.groundRgb, scheme, body: p.groundRgb, html: p.groundRgb };
}

test('跟随系统浅色/深色：.cs 上的颜色变量、文字色、页面底色和 color-scheme 一起切换', async ({ page }) => {
  // The lock screen is themed too (it lives inside .cs).
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/admin');
  await expect(page.getByLabel('管理令牌')).toBeVisible();
  expect(await palette(page)).toEqual(expected(LIGHT, 'light'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => palette(page)).toEqual(expected(DARK, 'dark'));

  // Signed in: switching the system preference re-themes the running console.
  await installAdminToken(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/admin/storage');
  await expect(pageTitle(page, '存储与备份')).toBeVisible();
  expect(await palette(page)).toEqual(expected(LIGHT, 'light'));
  const inputBackground = () => section(page, '清理规则').getByLabel('媒体上限（MB）').evaluate((node) => getComputedStyle(node).colorScheme);
  expect(await inputBackground()).toBe('light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => palette(page)).toEqual(expected(DARK, 'dark'));
  // Form controls inherit the dark scheme, so native widgets are dark as well.
  expect(await inputBackground()).toBe('dark');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => palette(page)).toEqual(expected(LIGHT, 'light'));
});

for (const viewport of [
  { name: '手机竖屏 375×812', width: 375, height: 812 },
  { name: '手机横屏 844×390', width: 844, height: 390 },
  { name: '桌面 1280×860', width: 1280, height: 860 }
]) {
  test(`深色主题下 13 个页面在${viewport.name}都不横向溢出`, async ({ page }) => {
    test.setTimeout(120_000);
    await installAdminToken(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const target of CONSOLE_PAGES) {
      await page.goto(target.path);
      await expect(pageTitle(page, target.label)).toBeAttached();
      await waitForLoaded(page);
      await expectNoHorizontalOverflow(page, `${target.path} @ ${viewport.width}×${viewport.height}`);
    }
    // Phones get the tab bar; wider screens (landscape phones included) the side navigation.
    const phone = viewport.width <= 760;
    await expect(page.getByRole('navigation', { name: '常用栏目' })).toBeVisible({ visible: phone });
    if (phone) await expect(page.getByRole('navigation', { name: '管理栏目' })).not.toBeInViewport();
    else await expect(page.getByRole('navigation', { name: '管理栏目' })).toBeInViewport();
  });
}

test('减少动态效果时动画和过渡压到极短，但加载态仍然可见', async ({ page }) => {
  await installAdminToken(page);
  // Hold the landing page's system request so its loading state stays on screen.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/admin/system', async (route) => { await held; await route.continue(); });

  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/admin');
  const loading = section(page, '系统').getByRole('status').filter({ hasText: '正在读取…' });
  await expect(loading).toBeVisible();
  const spinner = await loading.evaluate((node) => {
    const style = getComputedStyle(node, '::before');
    return { name: style.animationName, duration: style.animationDuration, display: style.display, width: parseFloat(style.width), border: style.borderTopWidth };
  });
  const ms = (value: string) => (value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000);
  expect(spinner.name).toBe('cs-spin');
  expect(ms(spinner.duration)).toBeLessThanOrEqual(0.01);
  // Still drawn: the spinner ring keeps its size and border.
  expect(spinner.display).not.toBe('none');
  expect(spinner.width).toBeGreaterThan(0);
  expect(spinner.border).not.toBe('0px');

  // Transitions (moment hero colour fade, section chevron) are squeezed too.
  const transitions = await page.evaluate(() => {
    const hero = document.querySelector('.cs-hero')!;
    return getComputedStyle(hero).transitionDuration.split(',').map((v) => v.trim());
  });
  for (const value of transitions) expect(ms(value)).toBeLessThanOrEqual(0.01);

  release();
  await expect(section(page, '系统').getByText(/^服务在运行/)).toBeVisible();
  await expect(loading).toHaveCount(0);

  // Control: without the preference the same elements animate normally.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const normal = await page.evaluate(() => getComputedStyle(document.querySelector('.cs-hero')!).transitionDuration);
  expect(ms(normal.split(',')[0]!.trim())).toBeGreaterThanOrEqual(100);
});

test('减少动态效果时无限循环的动画只播一次', async ({ page }) => {
  // console.css only shortens animation-duration under prefers-reduced-motion;
  // animation-iteration-count stays `infinite`, so the loading spinner keeps
  // spinning at 0.01ms per turn (it flickers instead of standing still). The
  // retired styles also set the iteration count to 1.
  await installAdminToken(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/admin/system', async (route) => { await held; await route.continue(); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/admin');
  const loading = section(page, '系统').getByRole('status').filter({ hasText: '正在读取…' });
  await expect(loading).toBeVisible();
  expect(await loading.evaluate((node) => getComputedStyle(node, '::before').animationIterationCount)).toBe('1');
  release();
});
