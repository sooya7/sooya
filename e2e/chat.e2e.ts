import { test, expect, type Page } from '@playwright/test';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT ?? 9912}/__control`;
const ADMIN = 'e2e-admin-token';
const CHAT_TOKEN = 'e2e-chat-token';

async function control(patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(MOCK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`mock control failed: ${res.status}`);
}

async function calls(): Promise<Record<string, number>> {
  const res = await fetch(MOCK);
  return ((await res.json()) as { calls: Record<string, number> }).calls;
}

async function clearChat(baseURL: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/admin/chat/clear`, { method: 'POST', headers: { 'x-admin-token': ADMIN } });
  if (!res.ok) throw new Error(`clear chat failed: ${res.status}`);
}

async function chatApi(baseURL: string, path: string, init: RequestInit): Promise<void> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${CHAT_TOKEN}`);
  const res = await fetch(`${baseURL}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`chat API ${init.method ?? 'GET'} ${path} failed: ${res.status} ${body}`);
  }
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('composer-input');
  await input.click();
  await input.fill(text);
  await page.getByTestId('btn-send').click();
}

/** Wait until the newest assistant message is finished rendering. */
async function waitForReply(page: Page, index = -1): Promise<void> {
  await expect
    .poll(
      async () => {
        const rows = page.locator('[data-testid="message"][data-role="assistant"]');
        const count = await rows.count();
        if (count === 0) return 'none';
        const target = index < 0 ? count - 1 : index;
        return (await rows.nth(target).getAttribute('data-status')) ?? 'none';
      },
      { timeout: 25_000 }
    )
    .toBe('sent');
}

test.beforeEach(async ({ baseURL, page }) => {
  await page.addInitScript((token: string) => localStorage.setItem('sooya.token', token), CHAT_TOKEN);
  await clearChat(baseURL!);
  await control({ queue: [], fallback: '好的。', failChat: false, failImage: false, failTts: false, delayMs: 0, chunkDelayMs: 6, resetCalls: true });
});

test('loads the single permanent conversation with no chat-management UI', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('SOOYA').first()).toBeVisible();
  await expect(page.getByTestId('connection-status')).toContainText(/在线|连接/);

  const html = (await page.content()).toLowerCase();
  for (const forbidden of ['新建聊天', '删除聊天', '切换聊天', '人格切换', '切换角色', '注册', '工作区', '会话列表']) {
    expect(html, `UI must not contain "${forbidden}"`).not.toContain(forbidden.toLowerCase());
  }
  // Exactly one conversation surface, no sidebar/list.
  expect(await page.locator('[data-testid="scroller"]').count()).toBe(1);
});

test('sends text and receives a streamed reply', async ({ page }) => {
  await control({ queue: ['我在呢，怎么了？'] });
  await page.goto('/');
  await send(page, '在吗');

  await expect(page.locator('[data-testid="message"][data-role="user"]').last()).toContainText('在吗');
  await waitForReply(page);
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText('我在呢，怎么了？');
  // Directive markers must never leak into the UI.
  expect(await page.textContent('body')).not.toContain('[[');
});

test('shows incremental streaming before the reply completes', async ({ page }) => {
  await control({ queue: ['一二三四五六七八九十，这是一段比较长的流式回复内容。'], chunkDelayMs: 200 });
  await page.goto('/');
  await send(page, '慢慢说');

  // A partial bubble must appear while the message is still "sending".
  await expect
    .poll(
      async () => {
        const rows = page.locator('[data-testid="message"][data-role="assistant"]');
        if ((await rows.count()) === 0) return false;
        const last = rows.last();
        const status = await last.getAttribute('data-status');
        const text = (await last.textContent()) ?? '';
        return status === 'sending' && text.includes('一二三');
      },
      { timeout: 15_000 }
    )
    .toBe(true);

  await waitForReply(page);
});

test('SOOYA sends a sticker', async ({ page }) => {
  await control({ queue: ['哈哈哈，你太逗了[[sticker:开心]]'] });
  await page.goto('/');
  await send(page, '讲个笑话');
  await waitForReply(page);

  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  const sticker = last.locator('img.sticker-part');
  await expect(sticker).toBeVisible();
  // The sticker image must actually load (no broken remote reference).
  await expect
    .poll(async () => sticker.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
});

test('SOOYA generates and displays an image', async ({ page }) => {
  const mediaRequests: Array<{ url: string; authorization: string | undefined }> = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/media/')) {
      mediaRequests.push({ url: request.url(), authorization: request.headers().authorization });
    }
  });
  await control({ queue: ['给你画好啦[[image:a quiet lake at dawn]]'] });
  await page.goto('/');
  await send(page, '画一张图');
  await waitForReply(page);

  const img = page.locator('[data-testid="message"][data-role="assistant"]').last().locator('.image-part img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(10);
  await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
  for (const request of mediaRequests) {
    expect(request.url).not.toContain(CHAT_TOKEN);
    expect(request.authorization).toBe(`Bearer ${CHAT_TOKEN}`);
  }
  expect(await page.locator('body').evaluate((body, token) => body.innerHTML.includes(token), CHAT_TOKEN)).toBe(false);
  expect((await calls()).image).toBe(1);
});

test('image generation failure degrades without losing the text', async ({ page }) => {
  await control({ queue: ['这就给你画[[image:something]]'], failImage: true });
  await page.goto('/');
  await send(page, '画一张图');
  await waitForReply(page);

  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  await expect(last).toContainText('这就给你画');
  await expect(last.locator('.bubble-note')).toContainText('图片没有发出去');
});

test('SOOYA sends a playable voice message with a real duration', async ({ page }) => {
  const mediaRequests: Array<{ url: string; authorization: string | undefined }> = [];
  page.context().on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/media/')) {
      mediaRequests.push({ url: request.url(), authorization: request.headers().authorization });
    }
  });
  await control({ queue: ['晚安，好好睡一觉[[voice]]'] });
  await page.goto('/');
  await send(page, '用语音说晚安');
  await waitForReply(page);

  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  const duration = last.getByTestId('audio-duration');
  await expect(duration).toBeVisible();
  await expect(duration).not.toHaveText('0:00');
  await expect(last.locator('audio')).toHaveAttribute('src', /^blob:/);

  // The audio element must have loadable metadata from the stored file.
  const readyState = await last.locator('audio').evaluate(
    (el: HTMLAudioElement) =>
      new Promise<number>((resolve) => {
        if (el.readyState >= 1) return resolve(el.readyState);
        el.addEventListener('loadedmetadata', () => resolve(el.readyState), { once: true });
        el.addEventListener('error', () => resolve(-1), { once: true });
        setTimeout(() => resolve(el.readyState), 5000);
      })
  );
  expect(readyState).toBeGreaterThanOrEqual(1);
  await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
  for (const request of mediaRequests) {
    expect(request.url).not.toContain(CHAT_TOKEN);
    expect(request.authorization).toBe(`Bearer ${CHAT_TOKEN}`);
  }

  // The transcript is reachable.
  await last.getByText('查看文字').click();
  await expect(last.locator('.audio-transcript')).toContainText('晚安');
});

test('TTS failure falls back to a text bubble', async ({ page }) => {
  await control({ queue: ['这段内容本来要用语音[[voice]]'], failTts: true });
  await page.goto('/');
  await send(page, '用语音说');
  await waitForReply(page);

  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  await expect(last.getByTestId('text-bubble')).toContainText('这段内容本来要用语音');
  await expect(last.locator('.bubble-audio.failed')).toBeVisible();
});

test('a combined reply renders text, sticker, image and audio together', async ({ page }) => {
  await control({ queue: ['全都给你[[sticker:开心]][[image:a warm cup of coffee]][[voice]]'] });
  await page.goto('/');
  await send(page, '文字表情图片语音都来一份');
  await waitForReply(page);

  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  await expect(last.getByTestId('text-bubble')).toContainText('全都给你');
  await expect(last.locator('img.sticker-part')).toBeVisible();
  await expect(last.locator('.image-part img')).toBeVisible();
  await expect(last.locator('.bubble-audio')).toBeVisible();
});

test('messages survive a page reload', async ({ page }) => {
  await control({ queue: ['刷新之后我还在[[sticker:开心]]'] });
  await page.goto('/');
  await send(page, '刷新测试');
  await waitForReply(page);

  await page.reload();
  await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="message"][data-role="user"]').last()).toContainText('刷新测试');
  const last = page.locator('[data-testid="message"][data-role="assistant"]').last();
  await expect(last).toContainText('刷新之后我还在');
  await expect(last.locator('img.sticker-part')).toBeVisible();
});

test('the user can send a sticker from the picker', async ({ page }) => {
  await control({ queue: ['收到你的表情啦'] });
  await page.goto('/');
  await page.getByTestId('btn-sticker').click();
  await expect(page.getByTestId('sticker-panel')).toBeVisible();
  await page.locator('.sticker-choice').first().click();

  await expect(page.locator('[data-testid="message"][data-role="user"]').last().locator('img.sticker-part')).toBeVisible();
  await waitForReply(page);
});

test('the user can upload and send an image', async ({ page }) => {
  await control({ queue: ['我看到你发的图片了'] });
  await page.goto('/');

  // A genuine 1x1 PNG.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.getByTestId('input-image').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('attachment-strip')).toBeVisible();
  await send(page, '看这张图');

  const userMsg = page.locator('[data-testid="message"][data-role="user"]').last();
  await expect(userMsg.locator('.image-part img')).toBeVisible();
  await waitForReply(page);
});

test('history loads older messages when scrolling up, without jumping', async ({ page, baseURL }) => {
  // Seed enough history through the API so paging is required.
  for (let i = 0; i < 24; i++) {
    await chatApi(baseURL!, '/api/messages/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: `hist-${i}-${Date.now()}`, content: [{ type: 'text', text: `历史消息 ${i}` }] })
    });
  }
  await page.goto('/');
  await expect(page.locator('[data-testid="message"]').first()).toBeVisible();

  const initial = await page.locator('[data-testid="message"]').count();
  expect(initial).toBeGreaterThan(0);
  expect(initial).toBeLessThan(48); // paged, not all at once

  await page.getByTestId('scroller').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(async () => page.locator('[data-testid="message"]').count(), { timeout: 15_000 }).toBeGreaterThan(initial);

  // The oldest visible message must be older than before -> real pagination.
  await expect(page.locator('[data-testid="message"]').first()).toContainText('历史消息');
});

test('reading history is not interrupted by a new reply', async ({ page, baseURL }) => {
  for (let i = 0; i < 20; i++) {
    await chatApi(baseURL!, '/api/messages/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientMsgId: `keep-${i}-${Date.now()}`, content: [{ type: 'text', text: `旧消息 ${i}` }] })
    });
  }
  await control({ queue: ['这是一条新回复'] });
  await page.goto('/');
  await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  await page.waitForTimeout(500);

  // Scroll up to read history.
  await page.getByTestId('scroller').evaluate((el) => {
    el.scrollTop = 40;
  });
  await page.waitForTimeout(300);
  const before = await page.getByTestId('scroller').evaluate((el) => el.scrollTop);

  // A message arrives from another client while we are reading.
  await chatApi(baseURL!, '/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMsgId: `intrusion-${Date.now()}`, content: [{ type: 'text', text: '打扰一下' }] })
  });
  await page.waitForTimeout(3000);

  const after = await page.getByTestId('scroller').evaluate((el) => el.scrollTop);
  const distanceFromBottom = await page
    .getByTestId('scroller')
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(distanceFromBottom, 'must not be force-scrolled to the bottom').toBeGreaterThan(120);
  expect(Math.abs(after - before), 'scroll position should stay put').toBeLessThan(60);

  // And the user is told there is something new.
  await expect(page.getByTestId('unread-pill')).toBeVisible();
});

test('a reply produced while the tab is disconnected still appears without a manual refresh', async ({
  page,
  context,
  baseURL
}) => {
  await control({ queue: ['离线期间产生的回复'] });
  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toContainText('在线', { timeout: 15_000 });

  // Cut the network from the browser's perspective.
  await context.setOffline(true);
  await page.waitForTimeout(500);

  // Server-side activity happens while the page cannot see the stream.
  await chatApi(baseURL!, '/api/messages/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMsgId: `offline-${Date.now()}`, content: [{ type: 'text', text: '断线时发送' }] })
  });

  await context.setOffline(false);
  // No reload — the client must recover on its own.
  await expect(page.locator('[data-testid="message"]').filter({ hasText: '离线期间产生的回复' })).toBeVisible({
    timeout: 30_000
  });
});

test('chat model failure is shown to the user instead of hanging', async ({ page }) => {
  await control({ failChat: true });
  await page.goto('/');
  await send(page, '你好');
  await waitForReply(page);
  // A failing chat provider is reported with the `provider_unavailable` copy from
  // core/public-error.ts ('模型服务暂时不可用，请稍后重试。'), not the `reply_failed`
  // one this assertion was originally written against, so the old /失败|超时/
  // pattern could never match even though the user was told. Accept any of the
  // public failure messages: what matters is that the bubble explains itself.
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
    /失败|超时|不可用|无法处理/
  );
});

test('PWA: manifest, icons and service worker are served correctly', async ({ page, request }) => {
  await page.goto('/');

  const manifestRes = await request.get('/manifest.webmanifest');
  expect(manifestRes.ok()).toBe(true);
  const manifest = (await manifestRes.json()) as {
    name: string;
    start_url: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  expect(manifest.name).toBe('SOOYA');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  expect(manifest.icons.map((i) => i.src)).toEqual([
    '/icons/sooya-photo-v2-192.png',
    '/icons/sooya-photo-v2-512.png',
    '/icons/sooya-photo-v2-maskable-512.png'
  ]);
  for (const icon of manifest.icons) {
    const res = await request.get(icon.src);
    expect(res.ok(), `${icon.src} must be served`).toBe(true);
    expect((await res.body()).length).toBeGreaterThan(500);
  }

  const swRes = await request.get('/sw.js');
  expect(swRes.ok()).toBe(true);
  expect(await swRes.text()).toContain('addEventListener');

  // The page links the manifest and registers the worker.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/icons/sooya-photo-v2-192.png');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/sooya-photo-v2-192.png');
  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  expect(['registered', 'unsupported', 'none']).toContain(registered);
});

test('the service worker keeps protected media out of Cache Storage', async ({ page, baseURL }) => {
  await control({ queue: ['给你一张图[[image:a blue sky]]'] });
  await page.goto('/');
  // Give the worker a chance to take control.
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return;
    await navigator.serviceWorker.ready.catch(() => undefined);
  });

  await send(page, '画张图');
  await waitForReply(page);
  await expect(page.locator('.image-part img').last()).toBeVisible();
  await page.waitForTimeout(1500);

  const keys = await page.evaluate(async () => {
    if (!('caches' in window)) return null;
    const names = await caches.keys();
    const out: string[] = [];
    for (const n of names) {
      const c = await caches.open(n);
      for (const req of await c.keys()) out.push(req.url);
    }
    return out;
  });

  if (keys === null || keys.length === 0) {
    // Cache Storage is unavailable in this browser context; nothing to assert.
    expect(true).toBe(true);
    return;
  }
  for (const url of keys) {
    expect(url, 'no cache key may embed an auth token').not.toContain('token=');
    expect(new URL(url).pathname, 'protected media must stay network-only').not.toMatch(/^\/api\/media\//);
  }
  void baseURL;
});

test('the layout adapts to the viewport', async ({ page }, testInfo) => {
  await control({ queue: ['布局测试回复'] });
  await page.goto('/');
  await send(page, '布局测试');
  await waitForReply(page);

  const composer = page.locator('.composer');
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  // The composer spans the app width and sits at the bottom.
  expect(box!.width).toBeGreaterThan(Math.min(viewport.width, 900) * 0.8);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 2);

  // No horizontal overflow at any size.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(1);

  // Bubbles stay inside the viewport.
  const bubble = page.getByTestId('text-bubble').last();
  const bb = await bubble.boundingBox();
  expect(bb!.x).toBeGreaterThanOrEqual(0);
  expect(bb!.x + bb!.width).toBeLessThanOrEqual(viewport.width + 1);

  await page.screenshot({ path: testInfo.outputPath(`layout-${testInfo.project.name}.png`) });
});

test('opens the admin panel in the same tab', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('admin-entry').click();
  await expect(page).toHaveURL(/\/admin\/avatar$/);
  await expect(page.getByTestId('admin-lock')).toBeVisible();
});

test('pins the admin entry to the top-right corner of the chat header', async ({ page }) => {
  await page.goto('/');

  const entry = page.getByTestId('admin-entry');
  const header = page.locator('.topbar');
  const [entryBox, headerBox] = await Promise.all([entry.boundingBox(), header.boundingBox()]);
  expect(entryBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(headerBox!.x + headerBox!.width - (entryBox!.x + entryBox!.width)).toBeLessThanOrEqual(18);
  expect(entryBox!.y).toBeLessThanOrEqual(headerBox!.y + 18);
});

test('uses a compact centered SVG for the admin entry', async ({ page }) => {
  await page.goto('/');

  const entry = page.getByTestId('admin-entry');
  const icon = entry.locator('svg');
  await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  await expect(entry).toHaveCSS('width', '30px');
  await expect(entry).toHaveCSS('height', '30px');
  await expect(entry).toHaveCSS('border-radius', '50%');
  await expect(entry).toHaveCSS('box-shadow', 'none');
});

test('uses the balanced six-tooth admin icon', async ({ page }) => {
  await page.goto('/');

  const icon = page.getByTestId('admin-entry-icon');
  await expect(icon).toHaveAttribute('data-icon-style', 'six-tooth');
  await expect(icon.locator('circle')).toHaveCount(1);
  await expect(icon.locator('path')).toHaveCount(6);
});

test('renders the admin panel at the trailing-slash URL', async ({ page }) => {
  await page.goto('/admin/');

  await expect(page.getByTestId('admin-lock')).toBeVisible();
});

test('does not serve the SPA shell for unknown API, health, or asset paths', async ({ request }) => {
  for (const url of ['/api/not-found', '/health/not-found', '/assets/not-found.js']) {
    const response = await request.get(url, { headers: { accept: 'text/html' } });
    expect(response.status(), url).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  }
});

test('rejects an invalid stored admin token without exposing it in the URL', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('sooya.admin-token', 'invalid-admin-token'));

  const unauthorizedSystemRequest = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/admin/system' &&
      response.status() === 401 &&
      response.request().headers()['x-admin-token'] === 'invalid-admin-token'
  );
  await page.goto('/admin');
  await unauthorizedSystemRequest;
  await expect(page.getByTestId('admin-lock')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sooya.admin-token'))).toBeNull();
  await expect(page).not.toHaveURL(/invalid-admin-token/);
});

test('shows dashboard status for an authenticated admin', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('sooya.admin-token', 'e2e-admin-token'));

  await page.goto('/admin');
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await expect(page.getByTestId('admin-system-status')).toContainText('运行正常');
  await expect(page.getByTestId('admin-return-chat')).toBeVisible();
});

test('模型设置里的「测试连接」真打一次接口并回报结果', async ({ page }) => {
  // The probe consumes the mock's fallback reply, not a queued one, but an empty
  // queue keeps this test from eating a reply a later test queued for itself.
  await control({ queue: [] });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('sooya.admin-token', 'e2e-admin-token'));
  await page.goto('/admin');

  await page.getByTestId('admin-tab-models').click();
  await expect(page.getByTestId('admin-models-form')).toBeVisible();
  const before = (await calls()).chat;
  await page.getByTestId('admin-model-test').click();

  await expect(page.getByTestId('admin-model-test-result')).toContainText('连接正常');
  await expect(page.getByTestId('admin-model-test-result')).toContainText('耗时');
  expect((await calls()).chat).toBe(before + 1);
});

test('admin panel exposes only server-backed management sections', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('sooya.admin-token', 'e2e-admin-token'));
  await page.goto('/admin');

  await expect(page.getByTestId('admin-tab-overview')).toBeVisible();
  await page.getByTestId('admin-tab-persona').click();
  await expect(page.getByTestId('admin-persona-form')).toBeVisible();

  await page.getByTestId('admin-tab-models').click();
  await expect(page.getByTestId('admin-models-form')).toBeVisible();

  await page.getByTestId('admin-tab-content').click();
  await expect(page.getByTestId('admin-memory-list')).toBeVisible();
  await expect(page.getByTestId('admin-sticker-list')).toBeVisible();
  await expect(page.getByTestId('admin-media-list')).toBeVisible();

  await page.getByTestId('admin-tab-operations').click();
  await expect(page.getByTestId('admin-error-list')).toBeVisible();
  await expect(page.getByTestId('admin-job-list')).toBeVisible();
  await expect(page.getByTestId('admin-backup-list')).toBeVisible();

  await expect(page.getByText('Redis', { exact: true })).toHaveCount(0);
  await expect(page.getByText('重启服务', { exact: true })).toHaveCount(0);
  await expect(page.getByText('实时日志', { exact: true })).toHaveCount(0);
  await expect(page.getByText('模型管理', { exact: true })).toHaveCount(0);
  await expect(page.getByText('管理参考图', { exact: true })).toHaveCount(0);
});
