import fs from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  ADMIN_TOKEN, PORT, killQuietly, readRuntime, spawnServer, waitFor, waitUntilDown, writeRuntime
} from './server.js';

export { ADMIN_TOKEN };

/** 1×1 PNG, small enough to upload many times. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export const ADMIN_HEADERS = { 'x-admin-token': ADMIN_TOKEN };

/**
 * Every console page, in navigation order (packages/web/src/console/routes.ts).
 * `heading` is the page's <h1>; the landing page hides its title visually but
 * still names itself for screen readers.
 */
export const CONSOLE_PAGES: Array<{ slug: string; label: string; path: string }> = [
  { slug: '', label: '此刻', path: '/admin' },
  { slug: 'persona', label: '人设与声音', path: '/admin/persona' },
  { slug: 'look', label: '形象', path: '/admin/look' },
  { slug: 'life', label: '生活', path: '/admin/life' },
  { slug: 'memory', label: '记忆', path: '/admin/memory' },
  { slug: 'media', label: '相册与表情', path: '/admin/media' },
  { slug: 'chats', label: '聊天记录', path: '/admin/chats' },
  { slug: 'models', label: '模型', path: '/admin/models' },
  { slug: 'qq', label: 'QQ 通道', path: '/admin/qq' },
  { slug: 'tools', label: '工具', path: '/admin/tools' },
  { slug: 'video', label: '视频生成', path: '/admin/video' },
  { slug: 'storage', label: '存储与备份', path: '/admin/storage' },
  { slug: 'ops', label: '运行状况', path: '/admin/ops' }
];

/** The console keeps the token in localStorage; seed it before any page script runs. */
export async function installAdminToken(page: Page): Promise<void> {
  await page.addInitScript((token: string) => localStorage.setItem('sooya.admin-token', token), ADMIN_TOKEN);
}

/** The page title (<h1>) of the page currently shown. */
export function pageTitle(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name, exact: true });
}

/** Open a console page and wait until its <h1> is rendered. */
export async function openConsolePage(page: Page, pathName: string, title: string): Promise<void> {
  await page.goto(pathName);
  await expect(pageTitle(page, title)).toBeAttached();
}

/**
 * A titled Section (ui.tsx). On desktop its <h2> holds the title; on phones the
 * <h2> wraps a toggle button with the same name. Either way the section is the
 * closest `section.cs-section` around that heading.
 */
export function section(page: Page | Locator, title: string): Locator {
  return page.locator('section.cs-section').filter({
    has: page.getByRole('heading', { level: 2, name: title, exact: true })
  });
}

/**
 * Type into a console form field, check it took, and leave the field. One try only: the console
 * once dropped the first edit on a page, and a retrying helper would hide that from the suite.
 */
export async function fillField(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await expect(field).toHaveValue(value);
  await field.blur();
}

/** Same as fillField for <select>. */
export async function selectField(field: Locator, value: string): Promise<void> {
  await field.selectOption(value);
  await expect(field).toHaveValue(value);
  await field.blur();
}

/** Import one ordinary image through the admin media endpoint (the only way media enters the album now). */
export async function uploadGalleryImage(request: APIRequestContext, name: string): Promise<string> {
  const uploaded = await request.post('/api/admin/media', {
    headers: ADMIN_HEADERS,
    multipart: { image: { name, mimeType: 'image/png', buffer: PNG } }
  });
  expect(uploaded.ok()).toBeTruthy();
  const body = await uploaded.json() as { media: Array<{ id: string }> };
  expect(body.media).toHaveLength(1);
  return body.media[0]!.id;
}

export async function expectNoHorizontalOverflow(page: Page, where = ''): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(metrics.document, `document scrollWidth ${where}`).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.body, `body scrollWidth ${where}`).toBeLessThanOrEqual(metrics.viewport);
}

/** Wait until no loading indicator of the console (ui.tsx <Loading>) is left on screen. */
export async function waitForLoaded(page: Page): Promise<void> {
  await expect(page.locator('.cs-loading:visible')).toHaveCount(0);
}

/**
 * Stop the running e2e server and start a new one on the same data directory,
 * the way a deploy or crash-restart would. The pid file is updated so the
 * global teardown stops the new process.
 */
export async function restartServer(): Promise<void> {
  const runtime = readRuntime();
  const health = `http://127.0.0.1:${PORT}/health/ready`;
  killQuietly(runtime.server, 'SIGTERM');
  await waitUntilDown(health);
  const server = spawnServer(runtime, true);
  writeRuntime({ ...runtime, server });
  await waitFor(health, 45_000);
}

/** The SQLite file of the running e2e server. */
export function databaseFile(): string {
  const { dataRoot } = readRuntime();
  const stack = [dataRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'sooya.db') return full;
    }
  }
  throw new Error(`sooya.db not found under ${dataRoot}`);
}
