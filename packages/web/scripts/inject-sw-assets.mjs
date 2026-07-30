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

/** Build the sorted asset url list plus a version derived from it. */
export function buildManifest(distDir) {
  if (!fs.existsSync(distDir)) throw new Error(`dist directory not found: ${distDir}`);
  const files = walk(distDir).filter(isShellAsset);
  if (!files.some((file) => file === 'index.html')) {
    throw new Error(`no index.html in ${distDir}; did vite build run?`);
  }
  if (!files.some((file) => file.startsWith('assets/') && file.endsWith('.js'))) {
    throw new Error(`no hashed js bundle in ${distDir}/assets; refusing to ship an empty shell`);
  }
  const assets = ['/', ...files.map((file) => `/${file}`)].sort();
  const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 12);
  return { version, assets };
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

  const next = source.replace(PATTERN, `$1${JSON.stringify(manifest, null, 2)};`);
  if (next === source) throw new Error('manifest substitution produced no change');
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
    console.log(`sw manifest ${manifest.version}: ${manifest.assets.length} shell assets precached`);
  } catch (err) {
    console.error(`inject-sw-assets failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
