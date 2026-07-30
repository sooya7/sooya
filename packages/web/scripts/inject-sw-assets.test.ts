import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain .mjs build script, no types needed
import { buildManifest, iconAllowList, injectSwManifest, isShellAsset } from './inject-sw-assets.mjs';

const WORKER_SOURCE = path.resolve(__dirname, '..', 'public', 'sw.js');
const created: string[] = [];

/** Build a throwaway `dist` that looks like real Vite output. */
function makeDist(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-dist-'));
  created.push(dir);
  const files: Record<string, string> = {
    'index.html': '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>',
    'assets/index-abc123.js': 'console.log("app")',
    'assets/index-abc123.js.map': '{"version":3}',
    'assets/index-def456.css': '.app{color:#fff}',
    'manifest.webmanifest': '{"name":"SOOYA"}',
    'icons/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'avatars/user.png': 'not really a png',
    'sw.js': fs.readFileSync(WORKER_SOURCE, 'utf8'),
    ...extra
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe('inject-sw-assets', () => {
  it('keeps the app shell and drops everything else', () => {
    expect(isShellAsset('index.html')).toBe(true);
    expect(isShellAsset('manifest.webmanifest')).toBe(true);
    expect(isShellAsset('icons/icon.svg')).toBe(true);
    expect(isShellAsset('assets/index-abc123.js')).toBe(true);
    expect(isShellAsset('assets/index-def456.css')).toBe(true);
    // never: the worker itself, source maps, user uploads, unknown types
    expect(isShellAsset('sw.js')).toBe(false);
    expect(isShellAsset('assets/index-abc123.js.map')).toBe(false);
    expect(isShellAsset('avatars/user.png')).toBe(false);
    expect(isShellAsset('assets/data.json')).toBe(false);
  });

  it('produces a sorted manifest with a content-derived version', () => {
    const dist = makeDist();
    const manifest = buildManifest(dist);
    expect(manifest.assets).toEqual([
      '/',
      '/assets/index-abc123.js',
      '/assets/index-def456.css',
      '/icons/icon.svg',
      '/index.html',
      '/manifest.webmanifest'
    ]);
    expect(manifest.version).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.version).not.toBe('development');
    // same input, same version; different bundle hash, different version
    expect(buildManifest(dist).version).toBe(manifest.version);
    const other = makeDist({ 'assets/index-zzz999.js': 'console.log("other")' });
    expect(buildManifest(other).version).not.toBe(manifest.version);
  });

  it('rewrites the built worker with the real assets', () => {
    const dist = makeDist();
    const manifest = injectSwManifest({ dist });
    const worker = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8');
    expect(worker).toContain(`"version": "${manifest.version}"`);
    expect(worker).toContain('"/assets/index-abc123.js"');
    expect(worker).toContain('"/assets/index-def456.css"');
    expect(worker).not.toContain('"version": "development"');
    // the manifest must not name files that are not shipped
    expect(worker).not.toContain('index-abc123.js.map');
    expect(worker).not.toContain('"/sw.js"');
    expect(worker).not.toContain('avatars');
    // marker survives so a second run is idempotent, not a hard failure
    expect(worker).toContain('__SOOYA_BUILD_MANIFEST__');
    expect(() => injectSwManifest({ dist })).not.toThrow();
  });

  it('precaches only the icons the manifest declares', () => {
    const dist = makeDist({
      'manifest.webmanifest': JSON.stringify({
        name: 'SOOYA',
        icons: [{ src: '/icons/small-192.png', sizes: '192x192', type: 'image/png' }]
      }),
      'icons/small-192.png': 'declared',
      // unreferenced source artwork: exactly what must stay out of the install
      'icons/photo-1024.png': 'x'.repeat(2_500_000)
    });
    expect([...iconAllowList(dist)].sort()).toEqual(['/icons/icon.svg', '/icons/small-192.png']);

    const manifest = buildManifest(dist);
    expect(manifest.assets).toContain('/icons/small-192.png');
    expect(manifest.assets).toContain('/icons/icon.svg');
    expect(manifest.assets).not.toContain('/icons/photo-1024.png');
    expect(manifest.bytes).toBeLessThan(3_000_000);
  });

  it('refuses to precache a shell that is too heavy to install', () => {
    const heavy = makeDist({
      'manifest.webmanifest': JSON.stringify({ icons: [{ src: '/icons/huge.png', sizes: '512x512' }] }),
      'icons/huge.png': 'x'.repeat(3_100_000)
    });
    expect(() => buildManifest(heavy)).toThrow(/too much to fetch on install/);
  });

  it('keeps build-time reporting out of the worker', () => {
    const dist = makeDist();
    injectSwManifest({ dist });
    expect(fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')).not.toContain('"bytes"');
  });

  it('fails loudly instead of shipping an un-injected worker', () => {
    const noPlaceholder = makeDist({ 'sw.js': 'const SHELL_ASSETS = [];' });
    expect(() => injectSwManifest({ dist: noPlaceholder })).toThrow(/placeholder/);

    const doubled = makeDist({
      'sw.js': `${fs.readFileSync(WORKER_SOURCE, 'utf8')}\n/*__SOOYA_BUILD_MANIFEST__*/ {};`
    });
    expect(() => injectSwManifest({ dist: doubled })).toThrow(/found 2/);

    const noBundle = makeDist();
    fs.rmSync(path.join(noBundle, 'assets'), { recursive: true, force: true });
    expect(() => injectSwManifest({ dist: noBundle })).toThrow(/hashed js bundle/);

    const noShell = makeDist();
    fs.rmSync(path.join(noShell, 'index.html'));
    expect(() => injectSwManifest({ dist: noShell })).toThrow(/index\.html/);

    expect(() => injectSwManifest({ dist: path.join(os.tmpdir(), 'sooya-missing-dist') }))
      .toThrow(/service worker not found/);
  });
});
