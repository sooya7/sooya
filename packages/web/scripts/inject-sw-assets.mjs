#!/usr/bin/env node
/**
 * Inject the real Vite build manifest into the built service worker.
 *
 * `public/sw.js` ships a development placeholder so the worker stays valid
 * JavaScript on its own. After `vite build` this script rewrites the copy in
 * `dist/` with the actual emitted shell files and a content-derived cache
 * version, then fails loudly if anything about that substitution is off — a
 * silently un-injected worker would precache a shell that no longer exists.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '/*__SOOYA_BUILD_MANIFEST__*/';
const PATTERN = /(\/\*__SOOYA_BUILD_MANIFEST__\*\/\s*)\{[\s\S]*?\};/;

/** Files that must never be precached, whatever their extension. */
const EXCLUDED_NAMES = new Set(['sw.js', '.DS_Store', 'stats.html']);
const PRECACHE_EXTENSIONS = new Set(['.js', '.css', '.html', '.webmanifest', '.svg', '.png', '.ico', '.webp']);

/** Recursively list files under `dir` as posix-style paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs, base));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Decide whether a dist-relative path belongs in the offline shell.
 * Deliberately narrow: the app shell, its hashed bundles, the manifest and
 * icons. Everything else (user avatars, source maps, server-only files) is
 * left to the runtime stale-while-revalidate path.
 */
export function isShellAsset(relative) {
  const name = relative.split('/').pop() ?? '';
  if (EXCLUDED_NAMES.has(name)) return false;
  if (relative.endsWith('.map')) return false;
  if (!PRECACHE_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
  if (relative === 'index.html') return true;
  if (relative === 'manifest.webmanifest') return true;
  if (relative.startsWith('icons/')) return true;
  if (relative.startsWith('assets/')) return name.endsWith('.js') || name.endsWith('.css');
  return false;
}

/**
 * Which icons deserve a place in the install-time precache: the ones the web app
 * manifest actually declares, plus `icon.svg` because the push handler names it.
 * `dist/icons/` also carries big unreferenced source images — multi-hundred-KB
 * 1024px photos among them — and precaching those would make every install pay
 * for artwork nothing renders.
 */
export function iconAllowList(distDir) {
  const allowed = new Set(['/icons/icon.svg']);
  const manifestPath = path.join(distDir, 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const icon of Array.isArray(parsed.icons) ? parsed.icons : []) {
        if (typeof icon?.src === 'string' && icon.src.startsWith('/')) allowed.add(icon.src);
      }
    } catch {
      // A malformed manifest is the build's problem, not a reason to precache 7 MB.
    }
  }
  return allowed;
}

/** Build the sorted asset url list plus a version derived from it. */
export function buildManifest(distDir) {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory not found: ${distDir}`);
  const allowedIcons = iconAllowList(distDir);
  const files = walk(distDir)
    .filter(isShellAsset)
    .filter((file) => !file.startsWith('icons/') || allowedIcons.has(`/${file}`));
  if (!files.some((file) => file === 'index.html')) {
    throw new Error(`no index.html in ${distDir}; did vite build run?`);
  }
  if (!files.some((file) => file.startsWith('assets/') && file.endsWith('.js'))) {
    throw new Error(`no hashed js bundle in ${distDir}/assets; refusing to ship an empty shell`);
  }
  const assets = ['/', ...files.map((file) => `/${file}`)].sort();
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(distDir, file)).size, 0);
  if (bytes > 3_000_000) {
    throw new Error(`shell precache is ${(bytes / 1e6).toFixed(1)} MB; that is too much to fetch on install`);
  }
  const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 12);
  return { version, assets, bytes };
}

/** Rewrite the worker in place. Returns the manifest that was injected. */
export function injectSwManifest({ dist, worker } = {}) {
  const distDir = path.resolve(dist ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
  const workerPath = path.resolve(worker ?? path.join(distDir, 'sw.js'));
  if (!fs.existsSync(workerPath)) throw new Error(`service worker not found: ${workerPath}`);

  const source = fs.readFileSync(workerPath, 'utf8');
  const occurrences = source.split(MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one ${MARKER} placeholder in ${workerPath}, found ${occurrences}`);
  }
  if (!PATTERN.test(source)) {
    throw new Error(`placeholder in ${workerPath} is not followed by an object literal ending in "};"`);
  }

  const manifest = buildManifest(distDir);
  for (const url of manifest.assets) {
    if (url === '/') continue;
    const onDisk = path.join(distDir, url.slice(1));
    if (!fs.existsSync(onDisk)) throw new Error(`manifest lists a file that does not exist: ${url}`);
  }

  // Only version + assets belong in the worker; `bytes` is build-time reporting.
  const injected = { version: manifest.version, assets: manifest.assets };
  const next = source.replace(PATTERN, `$1${JSON.stringify(injected, null, 2)};`);
  // Re-running on an already-injected worker must be a no-op, not a failure: a build
  // can legitimately run twice. What must never pass silently is a substitution that
  // failed to take effect.
  if (!next.includes(`"version": "${manifest.version}"`)) {
    throw new Error('manifest substitution did not take effect');
  }
  fs.writeFileSync(workerPath, next);
  return manifest;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    const readFlag = (flag) => {
      const at = args.indexOf(flag);
      return at === -1 ? undefined : args[at + 1];
    };
    const manifest = injectSwManifest({ dist: readFlag('--dist'), worker: readFlag('--worker') });
    console.log(`sw manifest ${manifest.version}: ${manifest.assets.length} shell assets, ${(manifest.bytes / 1e6).toFixed(2)} MB precached`);
  } catch (err) {
    console.error(`inject-sw-assets failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
