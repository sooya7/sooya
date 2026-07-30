/** SOOYA offline shell, media cache and Web Push service worker. */
// Replaced at build time by scripts/inject-sw-assets.mjs with the real Vite
// output. The values below are only what `vite dev` needs to stay valid.
const BUILD_MANIFEST = /*__SOOYA_BUILD_MANIFEST__*/ {
  "version": "development",
  "assets": ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg']
};
const SHELL_CACHE = `sooya-shell-${BUILD_MANIFEST.version}`;
const SHELL_ASSETS = BUILD_MANIFEST.assets;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE && key.startsWith('sooya')).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/health') || url.pathname === '/api/stream' || url.pathname === '/api/events') return;

  if (url.pathname.startsWith('/api/media/') && !url.pathname.endsWith('/meta')) {
    // Protected media is fetched with Authorization and is never persisted in Cache API.
    event.respondWith(fetch(request));
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
