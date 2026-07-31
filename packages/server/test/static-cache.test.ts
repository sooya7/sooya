import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticCacheControl } from '../src/app.js';
import { createHarness, type Harness } from './helpers/harness.js';

/*
 * 静态资源以前走 @fastify/static 的默认值，也就是 `Cache-Control: public, max-age=0`：
 * 每次打开页面，每个 JS/CSS/图标都要回源验证一次。线上是 Cloudflare 隧道回源，实测每次
 * 往返 0.3–0.5s，cf-cache-status 永远是 REVALIDATED 而不是 HIT。
 * 这些用例守住三件事：带哈希的产物可以永久缓存；入口文件永远不缓存（否则发版发不出去）；
 * 其余静态文件缓存一天。
 */

let h: Harness | null = null;
let webDir: string | null = null;

afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
  if (webDir) await fsp.rm(webDir, { recursive: true, force: true });
  webDir = null;
});

async function makeWebDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-web-'));
  await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'icons'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>SOOYA</title>');
  await fsp.writeFile(path.join(dir, 'sw.js'), '// service worker');
  await fsp.writeFile(path.join(dir, 'manifest.webmanifest'), '{"name":"SOOYA"}');
  await fsp.writeFile(path.join(dir, 'assets', 'index-D9-2lj-S.js'), 'export const a = 1;');
  await fsp.writeFile(path.join(dir, 'icons', 'sooya-photo-v2-192.png'), 'not-a-real-png');
  return dir;
}

describe('staticCacheControl', () => {
  it('带内容哈希的产物是 immutable 一年', () => {
    expect(staticCacheControl('/srv/web/assets/index-D9-2lj-S.js')).toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('/srv/web/assets/index-5xAJsPzc.css')).toBe('public, max-age=31536000, immutable');
  });

  it('入口文件必须每次验证，否则发新版用户拿不到', () => {
    expect(staticCacheControl('/srv/web/index.html')).toBe('no-cache');
    expect(staticCacheControl('/srv/web/sw.js')).toBe('no-cache');
    expect(staticCacheControl('/srv/web/manifest.webmanifest')).toBe('no-cache');
  });

  it('其余静态文件缓存一天，而不是 max-age=0', () => {
    expect(staticCacheControl('/srv/web/icons/sooya-photo-v2-192.png')).toBe('public, max-age=86400');
    expect(staticCacheControl('/srv/web/avatars/sooya.svg')).toBe('public, max-age=86400');
  });

  it('assets 目录下没有哈希的文件不当作 immutable', () => {
    expect(staticCacheControl('/srv/web/assets/logo.png')).toBe('public, max-age=86400');
  });

  it('按平台分隔符拼出来的路径也能识别', () => {
    expect(staticCacheControl(['', 'srv', 'web', 'assets', 'index-D9-2lj-S.js'].join(path.sep)))
      .toBe('public, max-age=31536000, immutable');
  });
});

describe('静态资源响应头', () => {
  it('真实响应带上正确的 cache-control', async () => {
    webDir = await makeWebDir();
    h = await createHarness({ startWorkers: false, env: { WEB_DIR: webDir } });
    const cases: Array<[string, string]> = [
      ['/assets/index-D9-2lj-S.js', 'public, max-age=31536000, immutable'],
      ['/index.html', 'no-cache'],
      ['/sw.js', 'no-cache'],
      ['/manifest.webmanifest', 'no-cache'],
      ['/icons/sooya-photo-v2-192.png', 'public, max-age=86400']
    ];
    for (const [url, expected] of cases) {
      const res = await h.app.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe(expected);
    }
  });

  it('根路径回的是 index.html，也必须 no-cache', async () => {
    webDir = await makeWebDir();
    h = await createHarness({ startWorkers: false, env: { WEB_DIR: webDir } });
    const res = await h.app.server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('SPA 回退到 index.html 时不会被当成可缓存资源', async () => {
    webDir = await makeWebDir();
    h = await createHarness({ startWorkers: false, env: { WEB_DIR: webDir } });
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/gallery',
      headers: { accept: 'text/html' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});
