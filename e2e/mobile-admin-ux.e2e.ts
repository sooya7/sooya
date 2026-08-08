import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';
const CHAT_TOKEN = 'e2e-chat-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.use({ viewport: { width: 375, height: 812 } });

test('375px 下管理子页与表情面板保持可读且按需加载', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '移动端布局只在 mobile project 验证');

  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });

  for (const slot of ['assistant', 'user'] as const) {
    const uploaded = await request.post(`/api/admin/persona/avatar/${slot}`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      multipart: { file: { name: `${slot}.png`, mimeType: 'image/png', buffer: PNG } }
    });
    expect(uploaded.ok()).toBeTruthy();
  }
  for (let index = 0; index < 9; index += 1) {
    const uploaded = await request.post('/api/admin/stickers', {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      multipart: {
        name: `移动端表情 ${index + 1}`,
        emotion: 'happy',
        tags: 'happy',
        file: { name: `mobile-sticker-${index + 1}.png`, mimeType: 'image/png', buffer: PNG }
      }
    });
    expect(uploaded.ok()).toBeTruthy();
  }

  const requested: string[] = [];
  page.on('request', (entry) => requested.push(entry.url()));

  await page.goto('/admin/avatar');
  await expect(page.getByTestId('avatar-settings')).toBeVisible();
  await expect(page.getByAltText('SOOYA 头像预览')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByAltText('用户头像预览')).toHaveAttribute('src', /^blob:/);
  expect(requested.some((url) => /\/api\/admin\/(?:system|capabilities|backups)/.test(url))).toBe(false);
  const avatarMediaRequests = requested.filter((url) => new URL(url).pathname.startsWith('/api/media/'));
  expect(avatarMediaRequests.length).toBeGreaterThanOrEqual(2);
  expect(avatarMediaRequests.every((url) => new URL(url).searchParams.has('w'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/admin/life');
  const rules = page.getByTestId('life-rules');
  await expect(rules).toBeVisible();
  expect(await rules.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const narrowLabel = await rules.locator('label').evaluateAll((labels) => Math.min(...labels.map((label) => label.getBoundingClientRect().width)));
  expect(narrowLabel).toBeGreaterThan(280);
  const addPlan = page.getByRole('button', { name: '加入计划' });
  expect(await addPlan.evaluate((button) => getComputedStyle(button).whiteSpace)).toBe('nowrap');
  const addPlanBox = await addPlan.boundingBox();
  expect(addPlanBox).not.toBeNull();
  expect(addPlanBox!.x).toBeGreaterThanOrEqual(0);
  expect(addPlanBox!.x + addPlanBox!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/admin/voice');
  const voiceSettings = page.getByTestId('voice-settings');
  await expect(voiceSettings).toBeVisible();
  await expect(page.getByLabel('中性说话方式')).toBeVisible();
  await expect(page.getByLabel('中性语速')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const emotionRowsInsideViewport = await voiceSettings.locator('.emotion-map-row').evaluateAll((rows) => rows.every((row) => {
    const box = row.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  }));
  expect(emotionRowsInsideViewport).toBe(true);

  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toContainText('在线');
  const beforeStickers = requested.length;
  await page.getByTestId('btn-sticker').click();
  const choices = page.locator('.sticker-choice');
  await expect(choices.nth(8)).toBeVisible();
  const panelBox = await page.getByTestId('sticker-panel').boundingBox();
  const thirdRowBox = await choices.nth(8).boundingBox();
  expect(panelBox).not.toBeNull();
  expect(thirdRowBox).not.toBeNull();
  expect(thirdRowBox!.y + thirdRowBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
  await expect.poll(() => requested.slice(beforeStickers).some((url) => {
    const parsed = new URL(url);
    return parsed.pathname.startsWith('/api/media/') && parsed.searchParams.has('w');
  })).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
