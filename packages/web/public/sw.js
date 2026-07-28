/**
 * SOOYA service worker.
 *
 * Deliberately minimal and dependency-free:
 *  - precaches the app shell so the UI opens offline / on a flaky network
 *  - never caches /api or /health (chat data must always come from the server)
 *  - serves the shell for navigation requests (SPA offline support)
 *  - caches media files opportunistically so replaying an old voice clip works
 */

const VERSION = 'sooya-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const MEDIA_CACHE = `${VERSION}-media`;
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];
const MEDIA_LIMIT = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept live data or the event stream.
  if (url.pathname.startsWith('/health') || url.pathname === '/api/stream' || url.pathname === '/api/events') return;

  // Media: cache-first, since media ids are immutable.
  if (url.pathname.startsWith('/api/media/') && !url.pathname.endsWith('/meta')) {
    // The auth token travels in the query string. Cache under the bare path so
    // the secret is never written into Cache Storage keys, and so rotating the
    // token does not orphan every previously cached file.
    const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          // Range responses (206) must not be cached as if they were complete.
          if (res.ok && res.status === 200) {
            void cache.put(cacheKey, res.clone()).then(() => trimCache(MEDIA_CACHE, MEDIA_LIMIT));
          }
          return res;
        } catch (err) {
          const stale = await cache.match(cacheKey);
          if (stale) return stale;
          throw err;
        }
      })
    );
    return;
  }

  // All other API calls: network only.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: network-first with the cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          void caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('/index.html')) ?? (await cache.match('/')) ?? Response.error();
        })
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) void cache.put(request, res.clone());
          return res;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    })
  );
});
