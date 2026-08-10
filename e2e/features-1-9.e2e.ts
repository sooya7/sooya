import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';
const CHAT_TOKEN = 'e2e-chat-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function installAdminToken(page: Page): Promise<void> {
  await page.addInitScript((token: string) => localStorage.setItem('sooya.admin-token', token), ADMIN_TOKEN);
}

/**
 * 往图库里塞一张图片。必须走普通上传（`POST /api/media`）：头像上传的图片
 * 按设计不进图库，不能再拿它当图库测试数据。
 */
async function uploadGalleryImage(request: APIRequestContext, name: string): Promise<string> {
  const uploaded = await request.post('/api/media', {
    headers: { 'x-sooya-token': CHAT_TOKEN },
    multipart: { image: { name, mimeType: 'image/png', buffer: PNG } }
  });
  expect(uploaded.ok()).toBeTruthy();
  const body = await uploaded.json() as { media: Array<{ id: string }> };
  expect(body.media).toHaveLength(1);
  return body.media[0]!.id;
}

test.describe('SOOYA 1-9 user flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token: string) => localStorage.setItem('sooya.token', token), CHAT_TOKEN);
  });
  test('feature center exposes avatar, voice and storage controls', async ({ page }) => {
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

    // Voice-system convergence: the standalone「情绪语音」panel is gone —
    // behavior knobs live in「助手配置」, provider parameters + preview in
    //「模型配置 → 语音合成」.
    await expect(page.getByRole('button', { name: '情绪语音' })).toHaveCount(0);
    await page.getByRole('button', { name: '助手配置' }).click();
    await expect(page.getByTestId('voice-behavior-settings')).toBeVisible();
    await expect(page.getByTestId('voice-behavior-settings')).toContainText('启用语音');
    await expect(page.getByTestId('voice-behavior-settings')).toContainText('单条语音最大长度');

    await page.getByRole('button', { name: '模型配置' }).click();
    await page.getByRole('button', { name: '语音合成模型' }).click();
    await expect(page.getByTestId('admin-tts-preview')).toBeVisible();
    await expect(page.getByTestId('admin-tts-preview-play')).toBeEnabled();
    await expect(page.getByText('试听文字')).toBeVisible();

    await page.getByRole('button', { name: '存储治理' }).click();
    await expect(page.getByTestId('storage-settings')).toBeVisible();
    await page.getByRole('button', { name: '预览清理' }).click();
    await expect(page.getByText('清理预览已生成，尚未删除任何内容')).toBeVisible();

    /*
     * 换头像后旧的 blob URL 不再立刻撤销——它留在共享媒体缓存里等淘汰，这正是「切页
     * 回来不重下」的前提，所以这里守的不再是「有东西被撤销」，而是真正想要的性质：
     * 逛了一圈其他面板再回到头像，同一张媒体不能被重新请求一次。
     */
    const alreadyFetched = new Set(mediaRequests.map((request) => new URL(request.url).pathname));
    expect(alreadyFetched.size).toBeGreaterThan(0);
    const requestsBefore = mediaRequests.length;
    const revokedBefore = await page.evaluate(() =>
      (window as typeof window & { __sooyaRevokedUrls: string[] }).__sooyaRevokedUrls.length);
    await page.getByRole('button', { name: '双方头像' }).click();
    await expect(page.getByTestId('avatar-settings')).toBeVisible();
    await expect(avatarSettings.getByAltText('SOOYA 头像预览')).toHaveAttribute('src', /^blob:/);
    await expect(avatarSettings.getByAltText('用户头像预览')).toHaveAttribute('src', /^blob:/);
    expect(mediaRequests.slice(requestsBefore).map((request) => new URL(request.url).pathname)
      .filter((pathname) => alreadyFetched.has(pathname))).toEqual([]);
    // 撤销现在只该发生在缓存淘汰时；回到头像面板这一小段里不该撤销任何东西。
    expect(await page.evaluate(() =>
      (window as typeof window & { __sooyaRevokedUrls: string[] }).__sooyaRevokedUrls.length
    )).toBe(revokedBefore);
  });

  test('storage cleanup report summarizes and paginates thousands of candidates', async ({ page }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __cleanupDownloads: Array<{ href: string; download: string }> }).__cleanupDownloads = [];
      HTMLAnchorElement.prototype.click = function captureCleanupDownload() {
        (window as typeof window & { __cleanupDownloads: Array<{ href: string; download: string }> }).__cleanupDownloads.push({
          href: this.href,
          download: this.download
        });
      };
    });
    const candidates = Array.from({ length: 2_000 }, (_, index) => ({
      path: `orphan/candidate-${String(index).padStart(4, '0')}.bin`,
      bytes: index + 1,
      mtimeMs: 1_700_000_000_000 + index
    }));
    await page.route('**/api/admin/storage/cleanup', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          applied: false,
          report: {
            reportId: 'cleanup_large_report_123456',
            generatedAt: new Date().toISOString(),
            policyHash: 'policy',
            candidateHash: 'candidates',
            candidates: {
              expiredTrash: [],
              missingRecords: [],
              orphanFiles: candidates,
              unreferencedMedia: [],
              tempFiles: [],
              oldBackups: []
            },
            reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0)
          },
          deleted: {},
          skipped: [],
          releasedBytes: 0,
          deletedBytes: 0,
          skippedBytes: 0
        })
      });
    });

    await installAdminToken(page);
    await page.goto('/admin/features');
    await page.getByRole('button', { name: '存储治理' }).click();
    await page.getByRole('button', { name: '预览清理' }).click();

    const summary = page.getByTestId('cleanup-report-summary');
    await expect(summary).toContainText('2,000 项');
    await expect(page.getByTestId('cleanup-report-row')).toHaveCount(50);
    await expect(page.locator('body')).not.toContainText('candidate-1999.bin');
    await page.getByRole('button', { name: '下一页清理明细' }).click();
    await expect(page.getByTestId('cleanup-report-row').first()).toContainText('candidate-0050.bin');
    await page.getByRole('button', { name: '下载完整清理报告' }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __cleanupDownloads: Array<{ href: string; download: string }> }).__cleanupDownloads
    )).toEqual([{ href: expect.stringMatching(/^blob:/), download: 'cleanup_large_report_123456.json' }]);
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
    const mediaId = await uploadGalleryImage(request, 'e2e-gallery.png');

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
    for (const name of ['first-history.png', 'second-history.png']) mediaIds.push(await uploadGalleryImage(request, name));

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

    // Same-URL SPA entries make Playwright's goBack unreliable on headless
    // linux; drive the history API directly so the entry switch always runs.
    await page.evaluate(() => window.history.back());
    await expect(viewer).toBeHidden();
    // SPA history: the popstate round-trip is async, so wait for the state
    // to actually return to the baseline entry.
    await expect.poll(() => page.evaluate(() => history.state)).toEqual({ existing: 'preserved' });

    await secondCard.locator('.gallery-thumb').click();
    await expect(viewer).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(baseline + 1);
    await viewer.getByRole('button', { name: '关闭图片' }).click();
    await expect(viewer).toBeHidden();
    await expect.poll(() => page.evaluate(() => history.state)).toEqual({ existing: 'preserved' });
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

  test('copy selected text never falls back to the full message', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as typeof window & { __copiedText?: string }).__copiedText = value;
          }
        }
      });
    });
    const text = `E2E 只复制选中片段 ${Date.now()}`;
    const selected = '只复制选中片段';
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
    await message.getByRole('button', { name: '消息操作' }).click();
    await expect(page.getByRole('menuitem', { name: '复制选中文本' })).toBeDisabled();
    expect(await page.evaluate(() => (window as typeof window & { __copiedText?: string }).__copiedText)).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: '消息操作' })).toBeHidden();

    await message.getByTestId('text-bubble').evaluate((element, value) => {
      const content = element.textContent ?? '';
      const start = content.indexOf(value);
      const node = element.firstChild;
      if (!node || start < 0) throw new Error('selection fixture text not found');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + value.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, selected);
    await message.getByRole('button', { name: '消息操作' }).click();
    const copySelection = page.getByRole('menuitem', { name: '复制选中文本' });
    await expect(copySelection).toBeEnabled();
    await copySelection.click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __copiedText?: string }).__copiedText)).toBe(selected);
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
