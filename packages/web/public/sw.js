/** SOOYA offline shell, media cache and Web Push service worker. */
// Replaced at build time by scripts/inject-sw-assets.mjs with the real Vite
// output. The values below are only what `vite dev` needs to stay valid.
const BUILD_MANIFEST = /*__SOOYA_BUILD_MANIFEST__*/ {
  "version": "development",
  "assets": ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg']
};
const SHELL_CACHE = `sooya-shell-${BUILD_MANIFEST.version}`;
const SHELL_ASSETS = BUILD_MANIFEST.assets;

/** Drop every shell cache except the one this worker serves. */
async function deleteObsoleteShellCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key !== SHELL_CACHE && key.startsWith('sooya')).map((key) => caches.delete(key)));
}

self.addEventListener('install', (event) => {
  // No skipWaiting here on purpose: a new build must not replace the running one
  // while the user is mid-conversation. It waits until the page says to go ahead.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined)));
});

self.addEventListener('activate', (event) => {
  // Claim clients, but keep the previous shell cache: if the reload that follows
  // fails, the old shell is still the only thing left to serve from.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'CLIENT_READY') {
    // A controlled client reloaded successfully, so the old shell is now dead weight.
    event.waitUntil(deleteObsoleteShellCaches());
  }
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
  // Anything carrying credentials is per-user and must never land in a shared cache.
  if (request.headers.has('authorization') || url.searchParams.has('token')) return;

  if (url.pathname.startsWith('/api/media/') && !url.pathname.endsWith('/meta')) {
    // Protected media is fetched with Authorization and is never persisted in Cache API.
    event.respondWith(fetch(request));
    return;
  }

  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    // 整页导航用 stale-while-revalidate：先返回缓存的 shell（近零延迟），网络响应只
    // 在后台刷新缓存。原 network-first 在经 Cloudflare 回源时（实测单次往返约 1s+），
    // 每次聊天↔管理后台切换都要在关键路径上等一次网络，页面才明显卡顿。
    event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = (await cache.match('/index.html')) ?? (await cache.match('/'));
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void cache.put('/index.html', copy);
        }
        return response;
      }).catch(() => cached ?? Response.error());
      return cached ?? network;
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
