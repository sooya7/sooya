/**
 * SOOYA service worker.
 *
 * Deliberately minimal and dependency-free:
 *  - precaches the app shell so the UI opens offline / on a flaky network
 *  - never caches /api or /health (chat data must always come from the server)
 *  - serves the shell for navigation requests (SPA offline support)
 *  - caches media files opportunistically so replaying an old voice clip works
 *  - focuses the existing chat window when a reply notification is tapped
 */

const VERSION = 'sooya-v4';
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
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        if ('navigate' in existing && existing.url !== target) await existing.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })
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

  if (url.pathname.startsWith('/health') || url.pathname === '/api/stream' || url.pathname === '/api/events') return;

  if (url.pathname.startsWith('/api/media/') && !url.pathname.endsWith('/meta')) {
    const cacheKey = new Request(url.origin + url.pathname, { method: 'GET' });
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
        try {
          const response = await fetch(request);
          if (response.ok && response.status === 200) {
            void cache.put(cacheKey, response.clone()).then(() => trimCache(MEDIA_CACHE, MEDIA_LIMIT));
          }
          return response;
        } catch (error) {
          const stale = await cache.match(cacheKey);
          if (stale) return stale;
          throw error;
        }
      })
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (await cache.match('/index.html')) ?? (await cache.match('/')) ?? Response.error();
        })
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL_CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => hit ?? Response.error());
      return hit ?? network;
    })
  );
});
