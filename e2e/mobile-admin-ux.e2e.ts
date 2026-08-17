import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.use({ viewport: { width: 375, height: 812 } });

test('375px 下管理子页保持可读且按需加载', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '移动端布局只在 mobile project 验证');

  await page.addInitScript(({ admin }) => {
    localStorage.setItem('sooya.admin-token', admin);
  }, { admin: ADMIN_TOKEN });

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
  const observation = page.getByTestId('life-observation');
  await expect(observation).toBeVisible();
  await expect(page.getByRole('button', { name: '添加计划' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '立即推进' })).toHaveCount(0);
  const boundaries = page.getByTestId('life-boundaries');
  await boundaries.getByRole('button', { name: /^动态发布/ }).click();
  await expect(boundaries.getByRole('button', { name: '保存动态设置' })).toBeVisible();
  expect(await observation.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Voice-system convergence: the standalone「情绪语音」page is gone. The
  // mobile panel now surfaces the two behavior knobs under 助手配置 and the
  // TTS provider form (incl. preview) under 模型配置 — same no-overflow rule.
  await page.goto('/admin/persona');
  const voiceBehavior = page.getByTestId('voice-behavior-settings');
  await expect(voiceBehavior).toBeVisible();
  await expect(voiceBehavior.getByLabel('单条语音最大长度（秒）')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.goto('/admin/models');
  await page.getByRole('button', { name: '语音合成模型' }).click();
  const ttsPreview = page.getByTestId('admin-tts-preview');
  await expect(ttsPreview).toBeVisible();
  await expect(ttsPreview.getByRole('button', { name: '试听' })).toBeEnabled();
  expect(await ttsPreview.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
