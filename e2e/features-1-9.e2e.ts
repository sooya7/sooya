import { type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  ADMIN_HEADERS, ADMIN_TOKEN, PNG, fillField, installAdminToken, openConsolePage, pageTitle, section, uploadGalleryImage
} from './helpers.js';
import { MOCK_PORT } from './server.js';

/**
 * Feature pages of the admin console (packages/web/src/console):
 * 形象 (avatars), 人设与声音 (voice), 存储与备份 (cleanup, backups) and
 * 相册与表情 (album, all media, recycle bin, viewer).
 */

type Captured = { href: string; download: string };
type CaptureWindow = typeof window & { __downloads: Captured[]; __revoked: string[]; __errors: string[] };

/** Anchor downloads are captured instead of saved, and revoked object URLs are recorded. */
async function captureDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as CaptureWindow;
    w.__downloads = [];
    w.__revoked = [];
    w.__errors = [];
    window.addEventListener('unhandledrejection', (event) => w.__errors.push(String(event.reason)));
    HTMLAnchorElement.prototype.click = function captureDownload() {
      if (this.download) w.__downloads.push({ href: this.href, download: this.download });
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => { w.__revoked.push(url); revoke(url); };
  });
}

const downloads = (page: Page) => page.evaluate(() => (window as CaptureWindow).__downloads);

/** The console's short notice at the bottom of the screen. */
const toast = (page: Page, text: string | RegExp) => page.locator('.cs-toasts').getByText(text);

test.beforeEach(async ({ page }) => {
  await installAdminToken(page);
});

test.describe('形象：头像', () => {
  test('上传双方头像后立即预览，媒体只带 Bearer 令牌，切页回来不重复下载', async ({ page }) => {
    await captureDownloads(page);
    const mediaRequests: Array<{ url: string; authorization: string | undefined }> = [];
    page.context().on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/media/')) {
        mediaRequests.push({ url: request.url(), authorization: request.headers().authorization });
      }
    });

    await openConsolePage(page, '/admin/look', '形象');
    const avatars = section(page, '头像');
    await expect(avatars.getByText('她的头像', { exact: true })).toBeVisible();

    await avatars.getByLabel('上传她的头像').setInputFiles({ name: 'assistant-e2e.png', mimeType: 'image/png', buffer: PNG });
    await expect(toast(page, '她的头像已更新')).toBeVisible();
    await expect(avatars.getByRole('img', { name: '她的头像' })).toHaveAttribute('src', /^blob:/);

    await avatars.getByLabel('上传你的头像').setInputFiles({ name: 'user-e2e.png', mimeType: 'image/png', buffer: PNG });
    await expect(toast(page, '你的头像已更新')).toBeVisible();
    await expect(avatars.getByRole('img', { name: '你的头像' })).toHaveAttribute('src', /^blob:/);
    // Both slots now say they use an uploaded picture and offer to replace it.
    await expect(avatars.getByText('已换成你上传的图片')).toHaveCount(2);
    await expect(avatars.getByText('换一张')).toHaveCount(2);

    // Media goes through the authenticated fetch: the token travels in the
    // Authorization header, never in the URL or the DOM; thumbnails are sized.
    await expect.poll(() => mediaRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of mediaRequests) {
      expect(request.url).not.toContain(ADMIN_TOKEN);
      expect(request.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(new URL(request.url).searchParams.has('w')).toBe(true);
    }
    expect(await page.locator('body').evaluate((body, token) => body.innerHTML.includes(token), ADMIN_TOKEN)).toBe(false);

    // The server really switched both avatars.
    const persona = await page.request.get('/api/admin/persona', { headers: ADMIN_HEADERS });
    const saved = (await persona.json() as { persona: { avatar: string; userAvatar: string } }).persona;
    expect(saved.avatar).toMatch(/^\/api\/media\//);
    expect(saved.userAvatar).toMatch(/^\/api\/media\//);

    // Visit two other pages through the navigation and come back: the avatars
    // come from the shared media cache — no second download, nothing revoked.
    const fetched = new Set(mediaRequests.map((request) => new URL(request.url).pathname + new URL(request.url).search));
    const requestsBefore = mediaRequests.length;
    const revokedBefore = await page.evaluate(() => (window as CaptureWindow).__revoked.length);
    const nav = page.getByRole('navigation', { name: '管理栏目' });
    await nav.getByRole('link', { name: '人设与声音' }).click();
    await expect(pageTitle(page, '人设与声音')).toBeVisible();
    await nav.getByRole('link', { name: '存储与备份' }).click();
    await expect(pageTitle(page, '存储与备份')).toBeVisible();
    await nav.getByRole('link', { name: '形象' }).click();
    await expect(pageTitle(page, '形象')).toBeVisible();
    await expect(avatars.getByRole('img', { name: '她的头像' })).toHaveAttribute('src', /^blob:/);
    await expect(avatars.getByRole('img', { name: '你的头像' })).toHaveAttribute('src', /^blob:/);
    const refetched = mediaRequests.slice(requestsBefore)
      .map((request) => new URL(request.url).pathname + new URL(request.url).search)
      .filter((key) => fetched.has(key));
    expect(refetched).toEqual([]);
    expect(await page.evaluate(() => (window as CaptureWindow).__revoked.length)).toBe(revokedBefore);
  });
});

test.describe('人设与声音：语音', () => {
  test('语音习惯可保存并在刷新后保留，试听真实调用语音服务并播放', async ({ page, request }) => {
    await openConsolePage(page, '/admin/persona', '人设与声音');

    const behavior = section(page, '她什么时候发语音');
    await expect(behavior.getByRole('switch', { name: '允许她发语音' })).toBeVisible();
    const maxSeconds = behavior.getByLabel('一条语音最长几秒');
    await expect(maxSeconds).toBeVisible();
    // Out of range values are refused before anything is sent.
    await fillField(maxSeconds, '500');
    await expect(behavior.getByText('请填 5 到 120 之间的整数')).toBeVisible();
    await expect(behavior.getByRole('button', { name: '保存语音习惯' })).toBeDisabled();
    await fillField(maxSeconds, '37');
    await behavior.getByRole('button', { name: '保存语音习惯' }).click();
    await expect(toast(page, '语音习惯已保存')).toBeVisible();
    await page.reload();
    await expect(section(page, '她什么时候发语音').getByLabel('一条语音最长几秒')).toHaveValue('37');

    // Provider parameters and the preview live on the same page now.
    const voice = section(page, '她的声音');
    await expect(voice.getByRole('textbox', { name: '音色', exact: true })).toHaveValue('alloy');
    await expect(voice.getByRole('spinbutton', { name: '语速', exact: true })).toHaveValue('1');
    await expect(voice.getByText('语音服务可用')).toBeVisible();
    await expect(voice.getByRole('button', { name: '去模型页面配置语音服务' })).toBeVisible();
    await expect(page.getByRole('table', { name: '不同心情的说法' })).toBeVisible();

    const preview = section(page, '试听');
    await expect(preview.getByLabel('让她念什么')).toBeVisible();
    await fillField(preview.getByLabel('让她念什么'), '今天也辛苦啦。');
    const before = await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__control`)).json() as { calls: { tts: number } };
    // Paid action: the first click only explains the cost.
    await preview.getByRole('button', { name: '试听这句（消耗语音额度）' }).click();
    const ask = preview.getByRole('group', { name: '会调用语音服务，消耗一次语音额度。' });
    await expect(ask).toBeVisible();
    expect((await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__control`)).json() as { calls: { tts: number } }).calls.tts)
      .toBe(before.calls.tts);
    await ask.getByRole('button', { name: '确认试听' }).click();
    await expect(preview.locator('audio')).toHaveAttribute('src', /^blob:/);
    await expect.poll(async () => ((await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__control`)).json()) as { calls: { tts: number } }).calls.tts)
      .toBeGreaterThan(before.calls.tts);
  });
});

test.describe('存储与备份', () => {
  test('占用、清理规则校验、实时清理预览、备份创建与校验', async ({ page }) => {
    await openConsolePage(page, '/admin/storage', '存储与备份');

    const usage = section(page, '占用');
    await expect(usage.getByRole('meter', { name: '媒体占用' })).toBeVisible();
    await expect(usage.getByText('磁盘剩余')).toBeVisible();

    const policy = section(page, '清理规则');
    const soft = policy.getByLabel('媒体提醒线（MB）');
    const hard = policy.getByLabel('媒体上限（MB）');
    await expect(soft).not.toHaveValue('');
    const hardValue = await hard.inputValue();
    const softValue = await soft.inputValue();
    await fillField(soft, String(Number(hardValue) + 1));
    await expect(policy.getByText('提醒线要比上限低')).toBeVisible();
    await expect(policy.getByRole('button', { name: '保存清理规则' })).toBeDisabled();
    await policy.getByRole('button', { name: '还原' }).click();
    await expect(soft).toHaveValue(softValue);
    await expect(policy.getByText('提醒线要比上限低')).toHaveCount(0);
    await expect(policy.getByRole('button', { name: '保存清理规则' })).toBeEnabled();

    // Preview against the live server: it never deletes anything.
    const cleanup = section(page, '手动清理');
    await expect(cleanup.getByText('预览不会删除任何东西。')).toBeVisible();
    await cleanup.getByRole('button', { name: '预览可以清理的内容' }).click();
    await expect(cleanup.getByText(/^预览生成于 .+，一共 [\d,]+ 项，最多能释放 /)).toBeVisible();
    await expect(cleanup.getByRole('button', { name: '重新预览' })).toBeVisible();
    await expect(cleanup.getByRole('button', { name: '下载完整清单' })).toBeVisible();

    const backups = section(page, '备份');
    await backups.getByRole('button', { name: '立即备份' }).click();
    await expect(toast(page, /^备份已创建（/)).toBeVisible();
    await expect(backups.getByText('有校验值').first()).toBeVisible();
    await backups.getByRole('button', { name: '校验这份备份' }).first().click();
    await expect(backups.getByText('校验通过，这份备份完整可用')).toBeVisible();
  });

  test('清理预览对 2000 项候选做汇总、分页、下载清单，并按勾选的类别和报告号执行', async ({ page }) => {
    await captureDownloads(page);
    const candidates = Array.from({ length: 2_000 }, (_, index) => ({
      path: `orphan/candidate-${String(index).padStart(4, '0')}.bin`,
      bytes: index + 1,
      mtimeMs: 1_700_000_000_000 + index
    }));
    const report = {
      reportId: 'cleanup_large_report_123456',
      generatedAt: new Date().toISOString(),
      policyHash: 'policy',
      candidateHash: 'candidates',
      candidates: { expiredTrash: [], missingRecords: [], orphanFiles: candidates, unreferencedMedia: [], tempFiles: [], oldBackups: [] },
      reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0)
    };
    const applyBodies: unknown[] = [];
    await page.route('**/api/admin/storage/cleanup', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON() as { apply: boolean };
      if (body.apply) applyBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body.apply
          ? { applied: true, report, deleted: { orphanFiles: 2000 }, skipped: [], releasedBytes: report.reclaimableBytes, deletedBytes: report.reclaimableBytes, skippedBytes: 0 }
          : { applied: false, report, deleted: {}, skipped: [], releasedBytes: 0, deletedBytes: 0, skippedBytes: 0 })
      });
    });

    await openConsolePage(page, '/admin/storage', '存储与备份');
    const cleanup = section(page, '手动清理');
    await cleanup.getByRole('button', { name: '预览可以清理的内容' }).click();

    // One summary line and one row per non-empty category; empty ones are named once.
    await expect(cleanup.getByText(/一共 2,000 项，最多能释放 1\.9 MB/)).toBeVisible();
    const orphanRow = cleanup.locator('.cs-list-item').filter({ hasText: '没有记录的文件' });
    await expect(orphanRow.getByText('2000 项，1.9 MB')).toBeVisible();
    await expect(orphanRow.getByRole('checkbox', { name: '没有记录的文件' })).toBeChecked();
    await expect(cleanup.getByText(/^其余类别（.*回收站里过期的文件.*临时文件.*）没有需要清理的。$/)).toBeVisible();
    // Nothing of the 2000 paths is rendered until the details are asked for.
    await expect(page.locator('body')).not.toContainText('candidate-0000.bin');

    const details = orphanRow.getByRole('button', { name: '看明细' });
    await expect(details).toHaveAttribute('aria-expanded', 'false');
    await details.click();
    await expect(orphanRow.getByRole('button', { name: '收起明细' })).toHaveAttribute('aria-expanded', 'true');
    const rows = cleanup.getByText(/^orphan\/candidate-\d{4}\.bin$/);
    await expect(rows).toHaveCount(30);
    await expect(rows.first()).toHaveText('orphan/candidate-0000.bin');
    await expect(rows.last()).toHaveText('orphan/candidate-0029.bin');
    await expect(cleanup.getByText('1 / 67', { exact: true })).toBeVisible();
    await expect(cleanup.getByRole('button', { name: '上一页' })).toBeDisabled();
    await expect(page.locator('body')).not.toContainText('candidate-1999.bin');

    await cleanup.getByRole('button', { name: '下一页' }).click();
    await expect(rows.first()).toHaveText('orphan/candidate-0030.bin');
    await expect(rows).toHaveCount(30);
    await expect(cleanup.getByText('2 / 67', { exact: true })).toBeVisible();
    await cleanup.getByRole('button', { name: '上一页' }).click();
    await expect(rows.first()).toHaveText('orphan/candidate-0000.bin');

    // The full list downloads as one JSON named after the report.
    await cleanup.getByRole('button', { name: '下载完整清单' }).click();
    await expect.poll(() => downloads(page)).toEqual([{ href: expect.stringMatching(/^blob:/), download: 'cleanup_large_report_123456.json' }]);

    // Unticking the only non-empty category disables the destructive button.
    const applyButton = cleanup.getByRole('button', { name: '清理选中的 2000 项' });
    await expect(applyButton).toBeEnabled();
    await orphanRow.getByRole('checkbox', { name: '没有记录的文件' }).uncheck();
    await expect(cleanup.getByRole('button', { name: '清理选中的 0 项' })).toBeDisabled();
    await orphanRow.getByRole('checkbox', { name: '没有记录的文件' }).check();

    // Two-step confirm; only then the report id and chosen categories are sent.
    await applyButton.click();
    const confirm = cleanup.getByRole('group', { name: '会永久删除约 1.9 MB，删掉就找不回来。确定清理？' });
    await expect(confirm).toBeVisible();
    expect(applyBodies).toEqual([]);
    await confirm.getByRole('button', { name: '永久删除' }).click();
    await expect(cleanup.getByText(/^清理完成，释放了 1\.9 MB：没有记录的文件 2000 项。/)).toBeVisible();
    expect(applyBodies).toEqual([{ apply: true, categories: ['orphanFiles'], reportId: 'cleanup_large_report_123456' }]);
    await expect(cleanup.getByRole('button', { name: '预览可以清理的内容' })).toBeVisible();
  });
});

test.describe('相册与表情', () => {
  test('相册里收藏、打标签、查看原图、下载，移入回收站后可以恢复', async ({ page, request }) => {
    await captureDownloads(page);
    const name = `e2e-album-${Date.now()}.png`;
    const mediaId = await uploadGalleryImage(request, name);

    // The old standalone gallery address now opens this page.
    await page.goto('/gallery');
    await expect(page).toHaveURL(/\/admin\/media$/);
    await expect(pageTitle(page, '相册与表情')).toBeVisible();
    const tabs = page.getByRole('tablist', { name: '相册与表情' });
    await expect(tabs.getByRole('tab', { name: '相册' })).toHaveAttribute('aria-selected', 'true');

    const album = section(page, '她的相册');
    const openCard = album.getByRole('button', { name: `查看 ${name}` });
    await expect(openCard).toBeVisible();
    await expect(album.getByText(/^共 \d+ 张，占 /)).toBeVisible();

    await openCard.click();
    const viewer = page.getByRole('dialog', { name });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('button', { name: '关闭' })).toBeFocused();
    await expect(viewer.getByText('上传的')).toBeVisible();
    await expect(viewer.getByText('没有被任何消息、表情包或头像用到。')).toBeVisible();

    // The full image is the original bytes, served through a blob URL.
    const full = viewer.getByRole('img', { name });
    await expect(full).toHaveAttribute('src', /^blob:/);
    const src = await full.getAttribute('src');
    expect(await page.evaluate(async (url) => {
      const response = await fetch(url!);
      const blob = await response.blob();
      return { ok: response.ok, type: blob.type, size: blob.size };
    }, src)).toEqual({ ok: true, type: 'image/png', size: PNG.length });

    // Favorite.
    await viewer.getByRole('button', { name: '收藏', exact: true }).click();
    await expect(toast(page, '已收藏')).toBeVisible();
    await expect(viewer.getByRole('button', { name: '取消收藏' })).toBeVisible();

    // Tags: saved on Enter-free click, shown as chips, searchable from the album.
    const tag = `海边${Date.now() % 100000}`;
    await fillField(viewer.getByLabel('标签'), `${tag}，自拍`);
    await viewer.getByRole('button', { name: '保存标签' }).click();
    await expect(toast(page, '标签已保存')).toBeVisible();
    await expect(viewer.getByText(tag, { exact: true })).toBeVisible();
    await expect(viewer.getByText('自拍', { exact: true })).toBeVisible();

    // Download fetches the original with the token and hands the browser a blob.
    await viewer.getByRole('button', { name: '下载原文件' }).click();
    await expect.poll(() => downloads(page)).toHaveLength(1);
    const [saved] = await downloads(page);
    expect(saved).toEqual({ href: expect.stringMatching(/^blob:/), download: name });
    expect(saved!.href).not.toContain(ADMIN_TOKEN);
    expect(await page.evaluate(() => (window as CaptureWindow).__errors)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(album.locator('.cs-media').filter({ has: page.getByRole('button', { name: `查看 ${name}` }) }).getByText('收藏')).toBeVisible();

    // Filters: only favorites, and a tag search, both keep the card.
    await album.getByRole('switch', { name: '只看收藏' }).check();
    await expect(openCard).toBeVisible();
    await album.getByRole('switch', { name: '只看收藏' }).uncheck();
    await album.getByLabel('搜索').fill(tag);
    await expect(album.getByText('符合条件的 1 张', { exact: false })).toBeVisible();
    await expect(openCard).toBeVisible();
    await album.getByRole('button', { name: '清除筛选' }).first().click();

    // Recycle bin: move out of the album from the viewer (two-step confirm).
    await openCard.click();
    await expect(viewer).toBeVisible();
    await viewer.getByRole('button', { name: '移到回收站' }).click();
    await viewer.getByRole('group', { name: '移到回收站？之后还能恢复。' }).getByRole('button', { name: '移到回收站' }).click();
    await expect(toast(page, '已移到回收站')).toBeVisible();
    // The viewer moves on to a neighbour (or closes when there is none).
    await expect(page.getByRole('dialog', { name })).toBeHidden();
    if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
    await expect(openCard).toBeHidden();

    await tabs.getByRole('tab', { name: '回收站' }).click();
    await expect(page).toHaveURL(/\/admin\/media#trash$/);
    const trash = section(page, '回收站');
    const trashRow = trash.getByRole('listitem').filter({ has: page.getByRole('button', { name: `查看 ${name}` }) });
    await expect(trashRow).toBeVisible();
    await expect(trashRow.getByText(/移进回收站$/)).toBeVisible();
    await trashRow.getByRole('button', { name: '恢复' }).click();
    await trashRow.getByRole('group', { name: '放回原处？' }).getByRole('button', { name: '恢复' }).click();
    await expect(toast(page, '已恢复')).toBeVisible();
    await expect(trashRow).toBeHidden();

    // Back in the album, still a favorite; the full list shows it too.
    await tabs.getByRole('tab', { name: '相册' }).click();
    await expect(page).toHaveURL(/\/admin\/media$/);
    await expect(openCard).toBeVisible();
    await tabs.getByRole('tab', { name: '全部媒体' }).click();
    const allRow = section(page, '全部媒体').getByRole('listitem').filter({ has: page.getByRole('button', { name: `查看 ${name}` }) });
    await expect(allRow.getByText('收藏', { exact: true })).toBeVisible();

    const detail = await request.get(`/api/admin/media/${mediaId}`, { headers: ADMIN_HEADERS });
    const media = (await detail.json() as { media: { favorite: boolean; deletedAt: string | null; tags: string[] } }).media;
    expect(media).toMatchObject({ favorite: true, deletedAt: null, tags: [tag, '自拍'] });
  });

  test('回收站里彻底删除后，文件从回收站和全部媒体里都消失', async ({ page, request }) => {
    const name = `e2e-destroy-${Date.now()}.png`;
    const mediaId = await uploadGalleryImage(request, name);
    const trashed = await request.post(`/api/admin/media/${mediaId}/trash`, { headers: ADMIN_HEADERS });
    expect(trashed.ok()).toBeTruthy();

    await page.goto('/admin/media#trash');
    const tabs = page.getByRole('tablist', { name: '相册与表情' });
    await expect(tabs.getByRole('tab', { name: '回收站' })).toHaveAttribute('aria-selected', 'true');
    const trash = section(page, '回收站');
    const row = trash.getByRole('listitem').filter({ has: page.getByRole('button', { name: `查看 ${name}` }) });
    await row.getByRole('button', { name: '彻底删除' }).click();
    await row.getByRole('group', { name: '不能找回，确定？' }).getByRole('button', { name: '彻底删除' }).click();
    await expect(toast(page, '已彻底删除')).toBeVisible();
    await expect(row).toBeHidden();

    await tabs.getByRole('tab', { name: '全部媒体' }).click();
    await expect(section(page, '全部媒体').getByText(/^共 \d+ 个$/)).toBeVisible();
    await expect(page.getByRole('button', { name: `查看 ${name}` })).toHaveCount(0);
    expect((await request.get(`/api/admin/media/${mediaId}`, { headers: ADMIN_HEADERS })).status()).toBe(404);
  });

  /*
   * The retired gallery viewer pushed one history entry so the phone back
   * gesture closed it. The new viewer layer (pages/Media/Layer.tsx) keeps no
   * history at all: opening, stepping and closing must not add, remove or
   * rewrite entries, the address stays put, and leaving the page while it is
   * open must not leave the body scroll-locked.
   */
  test('查看层切换时不增加历史记录，不改地址，离开页面时解除滚动锁定', async ({ page, request }) => {
    const stamp = Date.now();
    const first = `history-first-${stamp}.png`;
    const second = `history-second-${stamp}.png`;
    await uploadGalleryImage(request, first);
    await uploadGalleryImage(request, second);

    await openConsolePage(page, '/admin/look', '形象');
    await page.getByRole('navigation', { name: '管理栏目' }).getByRole('link', { name: '相册与表情' }).click();
    await expect(page).toHaveURL(/\/admin\/media$/);
    const album = section(page, '她的相册');
    await expect(album.getByRole('button', { name: `查看 ${first}` })).toBeVisible();
    await expect(album.getByRole('button', { name: `查看 ${second}` })).toBeVisible();
    const baseline = await page.evaluate(() => {
      history.replaceState({ existing: 'preserved' }, '');
      return { length: history.length, url: location.href };
    });
    const historyNow = () => page.evaluate(() => ({ length: history.length, url: location.href, state: history.state as unknown }));

    // Newest first: the second upload sits right before the first one.
    // Opening adds exactly one entry (same URL, existing state kept) so the back gesture can close it.
    const layerEntry = { ...baseline, length: baseline.length + 1, state: { existing: 'preserved', csMediaLayer: true } };
    await album.getByRole('button', { name: `查看 ${second}` }).click();
    await expect(page.getByRole('dialog', { name: second })).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/^\d+ \/ \d+$/)).toBeVisible();
    expect(await historyNow()).toEqual(layerEntry);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    // Stepping through items never adds more.
    await page.getByRole('dialog').getByRole('button', { name: '下一个' }).click();
    await expect(page.getByRole('dialog', { name: first })).toBeVisible();
    expect(await historyNow()).toEqual(layerEntry);
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('dialog', { name: second })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('dialog', { name: first })).toBeVisible();
    expect(await historyNow()).toEqual(layerEntry);

    // Closing from inside steps back off the layer's entry: same page, original state.
    await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await historyNow()).state).toEqual({ existing: 'preserved' });
    expect((await historyNow()).url).toBe(baseline.url);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    // Focus returns to what opened the layer.
    await expect(album.getByRole('button', { name: `查看 ${second}` })).toBeFocused();

    // Back while the layer is open closes the layer and stays on the page…
    await album.getByRole('button', { name: `查看 ${first}` }).click();
    await expect(page.getByRole('dialog', { name: first })).toBeVisible();
    await page.evaluate(() => window.history.back());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/media$/);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    expect((await historyNow()).state).toEqual({ existing: 'preserved' });
    // …and only the next back leaves it.
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/\/admin\/look$/);
    await expect(pageTitle(page, '形象')).toBeVisible();
  });
});

/*
 * Regressions found while rewriting this suite, now fixed in the console:
 * the first keystroke on a page was dropped (dirty state set in the capture
 * phase), and a focused field's hint pushed the button below it away.
 */
test.describe('表单输入', () => {
  test('页面打开后的第一次输入不会被吞掉', async ({ page }) => {
    // ConsoleApp.tsx: <main onInputCapture> sets the shell's dirty state in the
    // capture phase; React re-renders the controlled input with its old value
    // before the field's onChange sees the new one. Same after every save.
    await openConsolePage(page, '/admin/storage', '存储与备份');
    const trash = section(page, '清理规则').getByLabel('回收站保留天数');
    await expect(trash).not.toHaveValue('');
    await trash.fill('13');
    await expect(trash).toHaveValue('13');
    await expect(page.getByRole('status').filter({ hasText: '这一页有没保存的修改' })).toBeVisible();
  });

  test('在带提示的输入框里打完字，直接点下方按钮能点中', async ({ page }) => {
    // console.css: `.cs-field-hint { display: none }` + `.cs-field:focus-within
    // .cs-field-hint { display: block }`. Mousedown on a button below moves focus,
    // the hint collapses, the button jumps up ~26px and the click is lost.
    await openConsolePage(page, '/admin/storage', '存储与备份');
    const policy = section(page, '清理规则');
    const trash = policy.getByLabel('回收站保留天数');
    await expect(trash).not.toHaveValue('');
    const original = await trash.inputValue();
    await trash.fill('13');
    await trash.fill('14');
    await expect(trash).toBeFocused();
    await policy.getByRole('button', { name: '还原' }).click();
    await expect(trash).toHaveValue(original);
  });
});
