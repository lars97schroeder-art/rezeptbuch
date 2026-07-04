'use strict';

// Bei Änderungen an index.html/app.js/style.css die Versionsnummer erhöhen,
// damit die Handys die neue App-Version bekommen.
const SHELL_CACHE = 'rezeptbuch-shell-v2';
const IMG_CACHE = 'rezept-bilder-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('rezeptbuch-shell-') && key !== SHELL_CACHE) {
        await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Rezeptfotos: erst Cache (fürs Offline-Kochen), sonst Netz + merken
  if (url.pathname.includes('/data/images/')) {
    event.respondWith((async () => {
      const cache = await caches.open(IMG_CACHE);
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })());
    return;
  }

  // recipes.json geht immer übers Netz – die App verwaltet ihre eigene Kopie
  if (url.pathname.endsWith('/data/recipes.json')) return;

  // App-Dateien: sofort aus dem Cache, im Hintergrund frisch nachladen
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(event.request, { ignoreSearch: true });
    const network = fetch(event.request)
      .then(res => {
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      })
      .catch(() => null);
    return hit || (await network) || new Response('Offline', { status: 503 });
  })());
});
