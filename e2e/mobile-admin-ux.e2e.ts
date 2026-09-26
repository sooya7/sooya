import { type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  ADMIN_HEADERS, CONSOLE_PAGES, PNG, expectNoHorizontalOverflow, installAdminToken, pageTitle, section, waitForLoaded
} from './helpers.js';

/**
 * Phone layout of the console (≤760px, packages/web/src/console): bottom tab
 * bar for the pages used most, a drawer with every page behind 更多, sections
 * folded to one tappable row each, and no page wider than the screen.
 * Runs in the `mobile` project (Pixel 7 device profile, 375px wide here).
 */

test.use({ viewport: { width: 375, height: 812 } });

test.beforeAll(async ({ request }) => {
  for (const slot of ['assistant', 'user'] as const) {
    const uploaded = await request.post(`/api/admin/persona/avatar/${slot}`, {
      headers: ADMIN_HEADERS,
      multipart: { file: { name: `${slot}.png`, mimeType: 'image/png', buffer: PNG } }
    });
    expect(uploaded.ok()).toBeTruthy();
  }
  for (let index = 0; index < 9; index += 1) {
    const uploaded = await request.post('/api/admin/stickers', {
      headers: ADMIN_HEADERS,
      multipart: {
        name: `移动端表情 ${index + 1}`,
        emotion: 'happy',
        tags: 'happy',
        file: { name: `mobile-sticker-${index + 1}.png`, mimeType: 'image/png', buffer: PNG }
      }
    });
    expect(uploaded.ok()).toBeTruthy();
  }
});

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '手机布局只在 mobile project 验证');
  await installAdminToken(page);
});

const tabBar = (page: Page) => page.getByRole('navigation', { name: '常用栏目' });
const drawer = (page: Page) => page.getByRole('navigation', { name: '管理栏目' });
const moreButton = (page: Page) => tabBar(page).getByRole('button');

/** Unfold every folded section on the page (phone sections start as one row). */
async function unfoldAll(page: Page): Promise<void> {
  const folded = page.locator('main').getByRole('button', { expanded: false }).and(page.locator('.cs-section-toggle'));
  for (let guard = 0; guard < 40 && await folded.count(); guard += 1) {
    await folded.first().click();
  }
  await expect(folded).toHaveCount(0);
}

test('底部常用栏与栏目抽屉：常用页一步可达，其余页在「更多」里', async ({ page }) => {
  await page.goto('/admin');
  await expect(pageTitle(page, '此刻')).toBeAttached();

  // The tab bar holds 此刻 / 生活 / 记忆 / 聊天 and the 更多 button.
  await expect(tabBar(page)).toBeVisible();
  const tabs = tabBar(page).getByRole('link');
  await expect(tabs).toHaveText(['此刻', '生活', '记忆', '聊天']);
  await expect(moreButton(page)).toHaveText('更多');
  await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(tabBar(page).getByRole('link', { name: '此刻' })).toHaveAttribute('aria-current', 'page');
  // The full navigation is a drawer, parked off screen.
  await expect(drawer(page)).not.toBeInViewport();

  await tabBar(page).getByRole('link', { name: '生活' }).click();
  await expect(page).toHaveURL(/\/admin\/life$/);
  await expect(pageTitle(page, '生活')).toBeVisible();
  await expect(tabBar(page).getByRole('link', { name: '生活' })).toHaveAttribute('aria-current', 'page');
  await expect(tabBar(page).getByRole('link', { name: '此刻' })).not.toHaveAttribute('aria-current', 'page');

  // 更多 opens the drawer with all thirteen pages.
  await moreButton(page).click();
  await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer(page)).toBeInViewport({ ratio: 0.9 });
  const links = drawer(page).getByRole('link');
  await expect(drawer(page).getByRole('link', { name: '回到此刻' })).toBeVisible();
  for (const target of CONSOLE_PAGES) {
    await expect(drawer(page).getByRole('link', { name: target.label, exact: true })).toBeInViewport();
  }
  await expect(links).toHaveCount(CONSOLE_PAGES.length + 1);
  await expect(drawer(page).getByRole('link', { name: '生活', exact: true })).toHaveAttribute('aria-current', 'page');

  // Picking a page closes the drawer; the 更多 slot then names where you are.
  await drawer(page).getByRole('link', { name: '存储与备份', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/storage$/);
  await expect(pageTitle(page, '存储与备份')).toBeVisible();
  await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer(page)).not.toBeInViewport();
  await expect(moreButton(page)).toHaveText('存储与备份');
  await expect(moreButton(page)).toHaveAttribute('aria-current', 'page');

  // Escape closes the drawer as well.
  await moreButton(page).click();
  await expect(drawer(page)).toBeInViewport({ ratio: 0.9 });
  await page.keyboard.press('Escape');
  await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer(page)).not.toBeInViewport();

  // Browser back walks the pages visited through the bar and the drawer.
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/life$/);
  await expect(pageTitle(page, '生活')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'life after back');
});

test('抽屉打开时点遮罩区域会关闭抽屉，而不是点到下面的页面', async ({ page }) => {
  // ConsoleApp.tsx only closes the drawer when the click lands on the <nav>
  // element itself; the dimmed area is a box-shadow, so a tap there reaches the
  // page underneath and the drawer stays open.
  await page.goto('/admin/storage');
  await moreButton(page).click();
  await expect(drawer(page)).toBeInViewport({ ratio: 0.9 });
  await page.mouse.click(360, 400);
  await expect(moreButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer(page)).not.toBeInViewport();
});

test('手机上每一节折叠成一行，点开才显示；首页和「她现在」默认展开', async ({ page }) => {
  await page.goto('/admin/storage');
  await expect(pageTitle(page, '存储与备份')).toBeVisible();
  const toggles = page.locator('main').locator('.cs-section-toggle');
  const names = ['占用', '清理规则', '手动清理', '备份', '导出完整备份'];
  await expect(toggles).toHaveText(names);
  for (const name of names) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'false');
  }
  const cleanupToggle = page.getByRole('button', { name: '手动清理', exact: true });
  const preview = page.getByRole('button', { name: '预览可以清理的内容' });
  await expect(preview).toBeHidden();
  // The explanation button only appears once a section is open.
  await expect(section(page, '手动清理').getByRole('button', { name: '这一节是做什么的' })).toHaveCount(0);

  await cleanupToggle.click();
  await expect(cleanupToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(preview).toBeVisible();
  const info = section(page, '手动清理').getByRole('button', { name: '这一节是做什么的' });
  await info.click();
  await expect(section(page, '手动清理').getByText('先预览会删掉什么')).toBeVisible();
  await expect(section(page, '手动清理').getByRole('button', { name: '收起说明' })).toHaveAttribute('aria-expanded', 'true');

  // Folding keeps the body mounted: a preview made before folding is still there.
  await preview.click();
  await expect(section(page, '手动清理').getByText(/^预览生成于/)).toBeVisible();
  await cleanupToggle.click();
  await expect(cleanupToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(section(page, '手动清理').getByText(/^预览生成于/)).toBeHidden();
  await cleanupToggle.click();
  await expect(section(page, '手动清理').getByText(/^预览生成于/)).toBeVisible();

  // Landing page: read-first sections start open.
  await tabBar(page).getByRole('link', { name: '此刻' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const system = page.getByRole('button', { name: '系统', exact: true });
  await expect(system).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, '系统').getByText('项能力可用')).toBeVisible();

  // Life: 她现在 open, everything else folded.
  await tabBar(page).getByRole('link', { name: '生活' }).click();
  await expect(page.getByRole('button', { name: '她现在', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(section(page, '她现在').getByText('在做的是')).toBeVisible();
  await expect(page.getByRole('button', { name: '今天的时间线', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '计划', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expectNoHorizontalOverflow(page, 'life');
});

test('形象页按需加载：头像按显示宽度取缩略图，不去请求首页的系统数据', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (entry) => requested.push(entry.url()));

  await page.goto('/admin/look');
  await expect(pageTitle(page, '形象')).toBeVisible();
  const avatarsToggle = page.getByRole('button', { name: '头像', exact: true });
  await expect(avatarsToggle).toHaveAttribute('aria-expanded', 'false');
  await avatarsToggle.click();
  const avatars = section(page, '头像');
  await expect(avatars.getByRole('img', { name: '她的头像' })).toHaveAttribute('src', /^blob:/);
  await expect(avatars.getByRole('img', { name: '你的头像' })).toHaveAttribute('src', /^blob:/);

  // Only this page's data: none of the landing page's system/backup reads.
  expect(requested.filter((url) => /\/api\/admin\/(?:system|capabilities|backups|errors)\b/.test(url))).toEqual([]);
  const avatarMedia = requested.filter((url) => new URL(url).pathname.startsWith('/api/media/'));
  expect(avatarMedia.length).toBeGreaterThanOrEqual(2);
  // Every image is requested at its display width (?w=), never the original.
  expect(avatarMedia.every((url) => new URL(url).searchParams.has('w'))).toBe(true);
  expect(await avatars.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page, 'look');
});

test('手机上的声音设置、语音试听和表情包库保持可读', async ({ page }) => {
  await page.goto('/admin/persona');
  await expect(pageTitle(page, '人设与声音')).toBeVisible();
  await page.getByRole('button', { name: '她什么时候发语音', exact: true }).click();
  const behavior = section(page, '她什么时候发语音');
  await expect(behavior.getByLabel('一条语音最长几秒')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'persona');

  // Models → 语音合成: the provider form and its preview fit the phone.
  await page.goto('/admin/models#tts');
  await expect(pageTitle(page, '模型')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '能力' }).getByRole('button', { name: /^语音合成/ })).toHaveAttribute('aria-current', 'true');
  await page.getByRole('button', { name: '试听', exact: true }).click();
  const preview = section(page, '试听');
  await expect(preview.getByLabel('念什么')).toBeVisible();
  await preview.getByRole('button', { name: '试听（会消耗语音额度）' }).click();
  await preview.getByRole('group', { name: '会真实合成一段语音，按字数计费。' }).getByRole('button', { name: '确认试听' }).click();
  await expect(preview.locator('audio')).toBeVisible();
  await expect(preview.locator('audio')).toHaveAttribute('src', /^blob:/);
  expect(await preview.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page, 'models#tts');

  // Sticker library with nine stickers: a grid that wraps inside the screen.
  await page.goto('/admin/media#stickers');
  await expect(page.getByRole('tab', { name: '表情包' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '表情包库', exact: true }).click();
  const library = section(page, '表情包库');
  // beforeAll runs again in a fresh worker after a failure, so count at least nine.
  await expect(library.getByRole('button', { name: /^编辑 移动端表情 \d$/ }).nth(8)).toBeVisible();
  await expect(library.getByRole('img', { name: '移动端表情 9' }).first()).toHaveAttribute('src', /^blob:/);
  expect(await library.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expectNoHorizontalOverflow(page, 'media#stickers');
});

test('375px 下 13 个页面全部展开后都不横向溢出', async ({ page }) => {
  test.setTimeout(180_000);
  for (const target of CONSOLE_PAGES) {
    await page.goto(target.path);
    await expect(pageTitle(page, target.label)).toBeAttached();
    await unfoldAll(page);
    await waitForLoaded(page);
    await expectNoHorizontalOverflow(page, target.path);
    // The tab bar stays on screen over every page.
    await expect(tabBar(page)).toBeInViewport();
  }
});
