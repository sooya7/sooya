/** SOOYA offline shell, media cache and Web Push service worker. */
const VERSION = 'sooya-v5';
const SHELL_CACHE = `${VERSION}-shell`;
const MEDIA_CACHE = `${VERSION}-media`;
const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];
const MEDIA_LIMIT = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'SOOYA';
  const body = typeof data.body === 'string' && data.body ? data.body.slice(0, 180) : 'SOOYA 回复你了';
  const url = typeof data.url === 'string' ? data.url : '/';
  const tag = typeof data.tag === 'string' ? data.tag : 'sooya-reply';
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag,
    renotify: false,
    data: { url, messageId: data.messageId || null }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing && existing.url !== target) await existing.navigate(target);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target);
  }));
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
    event.respondWith(caches.open(MEDIA_CACHE).then(async (cache) => {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) void cache.put(cacheKey, response.clone()).then(() => trimCache(MEDIA_CACHE, MEDIA_LIMIT));
        return response;
      } catch (error) {
        const stale = await cache.match(cacheKey);
        if (stale) return stale;
        throw error;
      }
    }));
    return;
  }

  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      void caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
      return response;
    }).catch(async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (await cache.match('/index.html')) ?? (await cache.match('/')) ?? Response.error();
    }));
    return;
  }

  event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
    const hit = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }).catch(() => hit ?? Response.error());
    return hit ?? network;
  }));
});
