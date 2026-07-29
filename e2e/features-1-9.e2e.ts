import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function installAdminToken(page: Parameters<typeof test>[0] extends never ? never : any): Promise<void> {
  await page.addInitScript((token: string) => localStorage.setItem('sooya.admin-token', token), ADMIN_TOKEN);
}

test.describe('SOOYA 1-9 user flows', () => {
  test('feature center exposes avatar, voice, world and storage controls', async ({ page }) => {
    await installAdminToken(page);
    await page.goto('/admin/features');
    await expect(page.getByRole('heading', { name: '双方头像' })).toBeVisible();
    await expect(page.getByTestId('avatar-settings')).toBeVisible();

    await page.getByRole('button', { name: '情绪语音' }).click();
    await expect(page.getByTestId('voice-settings')).toBeVisible();
    await expect(page.getByText(/TTS 能力可用/)).toBeVisible();
    await page.getByRole('button', { name: '保存语音配置' }).click();
    await expect(page.getByText('情绪语音配置已保存并立即生效')).toBeVisible();
    await expect(page.getByRole('button', { name: '试听' })).toBeEnabled();

    await page.getByRole('button', { name: '世界引擎' }).click();
    await expect(page.getByTestId('world-settings')).toBeVisible();
    await page.getByPlaceholder('主体').fill('E2E 城市');
    await page.getByPlaceholder('关系/属性').fill('天气');
    await page.getByPlaceholder('内容').fill('晴朗');
    await page.getByRole('button', { name: '新增' }).click();
    await expect(page.getByText(/E2E 城市.*天气.*晴朗/)).toBeVisible();

    await page.getByRole('button', { name: '存储治理' }).click();
    await expect(page.getByTestId('storage-settings')).toBeVisible();
    await page.getByRole('button', { name: '预览清理' }).click();
    await expect(page.getByText('清理预览已生成，尚未删除任何内容')).toBeVisible();
  });

  test('gallery supports favorite, recycle bin, restore and zoom viewer', async ({ page, request }) => {
    const uploaded = await request.post('/api/admin/persona/avatar/assistant', {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      multipart: { file: { name: 'e2e-avatar.png', mimeType: 'image/png', buffer: PNG } }
    });
    expect(uploaded.ok()).toBeTruthy();
    const mediaId = (await uploaded.json() as { media: { id: string } }).media.id;

    await installAdminToken(page);
    await page.goto(`/gallery?media=${encodeURIComponent(mediaId)}`);
    const card = page.locator('.gallery-item').filter({ has: page.locator(`[data-media-id="${mediaId}"]`) });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '收藏' }).click();
    await expect(card.getByRole('button', { name: '取消收藏' })).toBeVisible();

    await card.locator('.gallery-thumb').click();
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toBeVisible();
    await page.keyboard.press('+');
    await expect(page.locator('.image-viewer-hint')).toContainText('%');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toBeHidden();

    await card.getByRole('button', { name: '移入回收站' }).click();
    await expect(card).toBeHidden();
    await page.getByRole('button', { name: '打开回收站' }).click();
    const trashCard = page.locator('.gallery-item').filter({ has: page.locator(`[data-media-id="${mediaId}"]`) });
    await expect(trashCard).toBeVisible();
    await trashCard.getByRole('button', { name: '恢复' }).click();
    await expect(trashCard).toBeHidden();
    await page.getByRole('button', { name: '返回普通图库' }).click();
    await expect(page.locator('.gallery-item').filter({ has: page.locator(`[data-media-id="${mediaId}"]`) })).toBeVisible();
  });

  test('message menu supports quote, resend-safe reply target and placeholder withdraw', async ({ page }) => {
    const firstText = `E2E 引用源 ${Date.now()}`;
    const replyText = `E2E 引用回复 ${Date.now()}`;
    await page.goto('/');
    await page.getByTestId('composer-input').fill(firstText);
    await page.getByTestId('btn-send').click();
    const first = page.locator('.msg-row.mine').filter({ hasText: firstText }).last();
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: '消息操作' }).click();
    await page.getByRole('menuitem', { name: '引用回复' }).click();
    await expect(page.locator('.composer-quote')).toContainText(firstText.slice(0, 20));

    await page.getByTestId('composer-input').fill(replyText);
    await page.getByTestId('btn-send').click();
    const reply = page.locator('.msg-row.mine').filter({ hasText: replyText }).last();
    await expect(reply).toBeVisible();
    await expect(reply.locator('.message-reply-preview')).toBeVisible();

    await reply.getByRole('button', { name: '消息操作' }).click();
    await page.getByRole('menuitem', { name: '撤回（保留占位）' }).click();
    await expect(page.locator('.msg-row.mine').filter({ hasText: '[消息已撤回]' }).last()).toBeVisible();
  });
});
