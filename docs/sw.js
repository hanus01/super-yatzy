'use strict';

const scope = new URL(self.registration.scope);
const cachePrefix = `super-yatzy:${scope.pathname}:`;
const cacheName = `${cachePrefix}4`;
const urls = ['index.html', 'style.css', 'game.js', 'ui.js', 'register.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
  .map((file) => new URL(file, scope).href);
const appFiles = new Set(urls);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(urls.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(cachePrefix) && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const fileUrl = url.pathname === scope.pathname && request.mode === 'navigate'
    ? new URL('index.html', scope).href : `${url.origin}${url.pathname}`;
  if (!appFiles.has(fileUrl)) return;
  event.respondWith(serveFile(request, fileUrl));
});

async function serveFile(request, fileUrl) {
  const cache = await caches.open(cacheName);
  // Revalidate online so an installed copy picks up published changes.
  try {
    const response = await fetch(request, { cache: 'no-cache', credentials: 'omit' });
    if (response.ok && !response.redirected) {
      try { await cache.put(fileUrl, response.clone()); } catch { /* A full cache still permits online play. */ }
      return response;
    }
    return await cache.match(fileUrl) ?? response;
  } catch (error) {
    const saved = await cache.match(fileUrl);
    if (saved) return saved;
    throw error;
  }
}
