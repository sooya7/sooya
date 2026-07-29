import { expect, test, type Page } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';
const CHAT_TOKEN = 'e2e-chat-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function installAdminToken(page: Page): Promise<void> {
  await page.addInitScript((token: string) => localStorage.setItem('sooya.admin-token', token), ADMIN_TOKEN);
}

test.describe('SOOYA 1-9 user flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token: string) => localStorage.setItem('sooya.token', token), CHAT_TOKEN);
  });
  test('feature center exposes avatar, voice, world and storage controls', async ({ page }, testInfo) => {
    const worldSubject = `E2E 城市 ${testInfo.project.name} ${Date.now()}`;
    let voiceStatusReads = 0;
    await page.addInitScript(() => {
      const original = URL.revokeObjectURL.bind(URL);
      (window as typeof window & { __sooyaRevokedUrls: string[] }).__sooyaRevokedUrls = [];
      URL.revokeObjectURL = (url: string) => {
        (window as typeof window & { __sooyaRevokedUrls: string[] }).__sooyaRevokedUrls.push(url);
        original(url);
      };
    });
    const mediaRequests: Array<{ url: string; authorization: string | undefined }> = [];
    page.context().on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/media/')) {
        mediaRequests.push({ url: request.url(), authorization: request.headers().authorization });
      }
      if (new URL(request.url()).pathname === '/api/admin/voice' && request.method() === 'GET') voiceStatusReads++;
    });
    await installAdminToken(page);
    await page.goto('/admin/features');
    await expect(page.getByRole('heading', { name: '双方头像' })).toBeVisible();
    const avatarSettings = page.getByTestId('avatar-settings');
    await expect(avatarSettings).toBeVisible();
    await avatarSettings.locator('input[type="file"]').nth(0).setInputFiles({ name: 'assistant-e2e.png', mimeType: 'image/png', buffer: PNG });
    await expect(avatarSettings.getByAltText('SOOYA 头像预览')).toHaveAttribute('src', /^blob:/);
    await avatarSettings.locator('input[type="file"]').nth(1).setInputFiles({ name: 'user-e2e.png', mimeType: 'image/png', buffer: PNG });
    await expect(avatarSettings.getByAltText('用户头像预览')).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
    for (const request of mediaRequests) {
      expect(request.url).not.toContain(ADMIN_TOKEN);
      expect(request.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
    }
    expect(await page.locator('body').evaluate((body, token) => body.innerHTML.includes(token), ADMIN_TOKEN)).toBe(false);
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __sooyaRevokedUrls: string[] }).__sooyaRevokedUrls.length
    )).toBeGreaterThan(0);

    await page.getByRole('button', { name: '情绪语音' }).click();
    await expect(page.getByTestId('voice-settings')).toBeVisible();
    await expect(page.getByText(/TTS 能力可用/)).toBeVisible();
    await expect(page.getByLabel('音调')).toBeDisabled();
    await expect(page.getByLabel('音量')).toBeDisabled();
    await page.getByRole('button', { name: '保存语音配置' }).click();
    await expect(page.getByText('情绪语音配置已保存并立即生效')).toBeVisible();
    await expect.poll(() => voiceStatusReads).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(/TTS 能力可用/)).toBeVisible();
    await expect(page.getByRole('button', { name: '试听' })).toBeEnabled();

    await page.getByRole('button', { name: '世界引擎' }).click();
    const worldSettings = page.getByTestId('world-settings');
    await expect(worldSettings).toBeVisible();
    await page.getByPlaceholder('主体').fill(worldSubject);
    await page.getByPlaceholder('关系/属性').fill('天气');
    await page.getByPlaceholder('内容').fill('晴朗');
    await page.getByRole('button', { name: '新增' }).click();
    const worldRow = worldSettings.locator('.admin-list-row').filter({ hasText: worldSubject });
    await expect(worldRow).toContainText('晴朗');
    await worldRow.getByRole('button', { name: '编辑' }).click();
    await page.getByLabel('编辑内容').fill('多云');
    await page.getByRole('button', { name: '保存编辑' }).click();
    await expect(worldSettings.locator('.admin-list-row').filter({ hasText: worldSubject })).toContainText('多云');

    await page.getByRole('button', { name: '存储治理' }).click();
    await expect(page.getByTestId('storage-settings')).toBeVisible();
    await page.getByRole('button', { name: '预览清理' }).click();
    await expect(page.getByText('清理预览已生成，尚未删除任何内容')).toBeVisible();
  });

  test('gallery supports favorite, recycle bin, restore and zoom viewer', async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __sooyaDownloads: Array<{ href: string; download: string }> }).__sooyaDownloads = [];
      (window as typeof window & { __sooyaDownloadErrors: string[] }).__sooyaDownloadErrors = [];
      window.addEventListener('unhandledrejection', (event) => {
        (window as typeof window & { __sooyaDownloadErrors: string[] }).__sooyaDownloadErrors.push(String(event.reason));
      });
      HTMLAnchorElement.prototype.click = function captureDownload() {
        (window as typeof window & { __sooyaDownloads: Array<{ href: string; download: string }> }).__sooyaDownloads.push({
          href: this.href,
          download: this.download
        });
      };
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    const uploaded = await request.post('/api/admin/persona/avatar/assistant', {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      multipart: { file: { name: 'e2e-avatar.png', mimeType: 'image/png', buffer: PNG } }
    });
    expect(uploaded.ok()).toBeTruthy();
    const mediaId = (await uploaded.json() as { media: { id: string } }).media.id;

    await installAdminToken(page);
    await page.goto(`/gallery?media=${encodeURIComponent(mediaId)}`);
    const card = page.locator(`.gallery-item[data-media-id="${mediaId}"]`);
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '收藏' }).click();
    await expect(card.getByRole('button', { name: '取消收藏' })).toBeVisible();

    await card.locator('.gallery-thumb').click();
    const viewer = page.getByRole('dialog', { name: '图片查看器' });
    await expect(viewer).toBeVisible();
    const viewerSrc = await viewer.locator('img').getAttribute('src');
    expect(await page.evaluate(async (src) => {
      try {
        const response = await fetch(src!);
        const blob = await response.blob();
        return { ok: response.ok, type: response.headers.get('content-type'), size: blob.size };
      } catch (error) {
        return { ok: false, type: error instanceof Error ? error.message : String(error) };
      }
    }, viewerSrc)).toEqual({ ok: true, type: 'image/png', size: PNG.length });
    await viewer.getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => ({
      downloads: (window as typeof window & { __sooyaDownloads: Array<{ href: string; download: string }> }).__sooyaDownloads,
      errors: (window as typeof window & { __sooyaDownloadErrors: string[] }).__sooyaDownloadErrors
    }))).toMatchObject({ downloads: [{ href: expect.stringMatching(/^blob:/) }], errors: [] });
    await viewer.getByRole('button', { name: '分享' }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __sooyaDownloads: Array<{ href: string; download: string }> }).__sooyaDownloads.length
    )).toBe(2);
    const downloads = await page.evaluate(() =>
      (window as typeof window & { __sooyaDownloads: Array<{ href: string; download: string }> }).__sooyaDownloads
    );
    for (const download of downloads) {
      expect(download.href).toMatch(/^blob:/);
      expect(download.href).not.toContain(ADMIN_TOKEN);
      expect(download.download).not.toContain(ADMIN_TOKEN);
    }
    await page.keyboard.press('+');
    await expect(page.locator('.image-viewer-hint')).toContainText('%');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '图片查看器' })).toBeHidden();

    await card.getByRole('button', { name: '移入回收站' }).click();
    await expect(card).toBeHidden();
    await page.getByRole('button', { name: '打开回收站' }).click();
    const trashCard = page.locator(`.gallery-item[data-media-id="${mediaId}"]`);
    await expect(trashCard).toBeVisible();
    await trashCard.getByRole('button', { name: '恢复' }).click();
    await expect(trashCard).toBeHidden();
    await page.getByRole('button', { name: '返回普通图库' }).click();
    await expect(page.locator(`.gallery-item[data-media-id="${mediaId}"]`)).toBeVisible();
  });

  test('image viewer preserves existing history state without growing entries while switching', async ({ page, request }, testInfo) => {
    const mediaIds: string[] = [];
    for (const slot of ['assistant', 'user']) {
      const uploaded = await request.post(`/api/admin/persona/avatar/${slot}`, {
        headers: { 'x-admin-token': ADMIN_TOKEN },
        multipart: { file: { name: `${slot}-history.png`, mimeType: 'image/png', buffer: PNG } }
      });
      expect(uploaded.ok()).toBeTruthy();
      mediaIds.push((await uploaded.json() as { media: { id: string } }).media.id);
    }

    await installAdminToken(page);
    await page.goto('/gallery');
    const firstCard = page.locator(`.gallery-item[data-media-id="${mediaIds[0]}"]`);
    const secondCard = page.locator(`.gallery-item[data-media-id="${mediaIds[1]}"]`);
    await expect(firstCard).toBeVisible();
    await expect(secondCard).toBeVisible();
    const baseline = await page.evaluate(() => {
      history.replaceState({ existing: 'preserved' }, '');
      return history.length;
    });

    await firstCard.locator('.gallery-thumb').click();
    const viewer = page.getByRole('dialog', { name: '图片查看器' });
    await expect(viewer).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state)).toMatchObject({ existing: 'preserved', sooyaImageViewer: true });
    expect(await page.evaluate(() => history.length)).toBe(baseline + 1);

    if (testInfo.project.name === 'mobile') {
      const countBefore = await viewer.locator('.image-viewer-count').textContent();
      const client = await page.context().newCDPSession(page);
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y: 500, id: 51 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 500, id: 51 }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await client.detach();
      await expect.poll(() => viewer.locator('.image-viewer-count').textContent()).not.toBe(countBefore);
    } else {
      await viewer.getByRole('button', { name: '下一张' }).click();
    }
    expect(await page.evaluate(() => history.length)).toBe(baseline + 1);

    await page.goBack();
    await expect(viewer).toBeHidden();
    expect(await page.evaluate(() => history.state)).toEqual({ existing: 'preserved' });

    await secondCard.locator('.gallery-thumb').click();
    await expect(viewer).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(baseline + 1);
    await viewer.getByRole('button', { name: '关闭图片' }).click();
    await expect(viewer).toBeHidden();
    expect(await page.evaluate(() => history.state)).toEqual({ existing: 'preserved' });
  });

  test('message menu supports quote, resend-safe reply target and placeholder withdraw', async ({ page }) => {
    const firstText = `E2E 引用源 ${Date.now()}`;
    const replyText = `E2E 引用回复 ${Date.now()}`;
    await page.goto('/');
    await page.getByTestId('composer-input').fill(firstText);
    const firstSendCompleted = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/messages' &&
      response.request().method() === 'POST' &&
      response.ok()
    );
    await page.getByTestId('btn-send').click();
    await firstSendCompleted;
    const first = page.locator('.msg-row.mine').filter({ hasText: firstText }).last();
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: '消息操作' }).click();
    await page.getByRole('menuitem', { name: '引用回复' }).click();
    await expect(page.locator('.composer-quote')).toContainText(firstText.slice(0, 20));

    const composerInput = page.getByTestId('composer-input');
    await composerInput.fill(replyText);
    await expect(composerInput).toHaveValue(replyText);
    await expect(page.getByTestId('btn-send')).toBeEnabled();
    const replySendCompleted = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/messages' &&
      response.request().method() === 'POST' &&
      response.ok()
    );
    await page.getByTestId('btn-send').click();
    await replySendCompleted;
    const reply = page.locator('.msg-row.mine').filter({ hasText: replyText }).last();
    await expect(reply).toBeVisible();
    await expect(reply.locator('.message-reply-preview')).toBeVisible();

    await reply.getByRole('button', { name: '消息操作' }).click();
    await page.getByRole('menuitem', { name: '撤回（保留占位）' }).click();
    await expect(page.locator('.msg-row.mine').filter({ hasText: '[消息已撤回]' }).last()).toBeVisible();
  });

  test('scrolling cancels a touch long-press before the message menu opens', async ({ page }) => {
    const text = `E2E 滚动取消长按 ${Date.now()}`;
    await page.goto('/');
    await page.getByTestId('composer-input').fill(text);
    const sendCompleted = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/messages' &&
      response.request().method() === 'POST' &&
      response.ok()
    );
    await page.getByTestId('btn-send').click();
    await sendCompleted;

    const message = page.locator('.msg-row.mine').filter({ hasText: text }).last();
    const startPress = (pointerId: number) =>
      message.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId, clientX: 160, clientY: 320 });
    const menu = page.getByRole('menu', { name: '消息操作' });

    await startPress(41);
    await page.getByTestId('scroller').dispatchEvent('scroll');
    await page.waitForTimeout(650);
    await expect(menu).toBeHidden();

    await startPress(42);
    await message.dispatchEvent('pointercancel', { pointerType: 'touch', pointerId: 42 });
    await page.waitForTimeout(650);
    await expect(menu).toBeHidden();

    await startPress(43);
    await message.dispatchEvent('lostpointercapture', { pointerType: 'touch', pointerId: 43 });
    await page.waitForTimeout(650);
    await expect(menu).toBeHidden();

    await startPress(44);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });
    await page.waitForTimeout(650);
    await expect(menu).toBeHidden();

    await startPress(45);
    await expect(menu).toBeVisible({ timeout: 1_500 });
    await page.keyboard.press('Escape');

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await startPress(46);
    await page.goto('/admin/features');
    await page.waitForTimeout(650);
    await expect(menu).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});
