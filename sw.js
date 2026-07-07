'use strict';

// Bei Änderungen an index.html/app.js/style.css die Versionsnummer erhöhen,
// damit die Handys die neue App-Version bekommen.
const SHELL_CACHE = 'rezeptbuch-shell-v5-23';
const IMG_CACHE = 'rezept-bilder-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'app.js',
  'editor.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // "reload" erzwingt frische Dateien vom Server statt aus dem HTTP-Cache
      .then(cache => cache.addAll(SHELL_FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Lösche ALLE rezeptbuch-* Caches außer der aktuellen Version
    for (const key of await caches.keys()) {
      if (key.startsWith('rezeptbuch-') && key !== SHELL_CACHE) {
        console.log('Deleting old cache:', key);
        await caches.delete(key);
      }
    }

    // Lösche auch die Bild-Caches um sicherzustellen
    for (const key of await caches.keys()) {
      if (key.startsWith('rezept-bilder-') && key !== IMG_CACHE) {
        console.log('Deleting old image cache:', key);
        await caches.delete(key);
      }
    }

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // index.html: ABSOLUT KRITISCH - IMMER vom Netz, NIEMALS cachen
  // Grund: version-check Script muss laufen, alte v3.1 darf nicht vom Cache kommen
  if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
    event.respondWith((async () => {
      console.log('[SW] Fetching index.html from network (never from cache)');
      try {
        // Fetch IMMER vom Netz, bypass ALLES (HTTP cache + SW cache)
        const res = await fetch(new Request(event.request, { cache: 'reload' }));
        if (res.ok) {
          console.log('[SW] Got fresh index.html from server');
          return res;
        }
        throw new Error('Bad response: ' + res.status);
      } catch (err) {
        console.error('[SW] Failed to fetch index.html:', err);
        // Offline fallback - ABER NUR älteste Version, keine gecachte alte Version
        return new Response('Offline - bitte Internet verbindung', { status: 503 });
      }
    })());
    return;
  }

  // recipes.json: IMMER vom Netz (App verwaltet lokale Kopie)
  // WICHTIG: Nicht im Service Worker cachen - nur im RAM der App
  if (url.pathname.endsWith('/data/recipes.json')) {
    event.respondWith((async () => {
      console.log('[SW] Fetching recipes.json from network');
      try {
        const res = await fetch(new Request(event.request, { cache: 'reload' }));
        console.log('[SW] Got recipes.json, status:', res.status);
        return res;
      } catch (err) {
        console.error('[SW] Failed to fetch recipes.json:', err);
        return new Response(JSON.stringify({ version: '0', recipes: [] }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

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

  // App-Dateien: IMMER vom Netz zuerst (app.js, style.css, etc.)
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);

    // Versuche ZUERST vom Netz
    try {
      const network = await fetch(event.request, { cache: 'no-cache' });
      if (network.ok) {
        // Speichere neue Version
        cache.put(event.request, network.clone());
        return network;
      }
    } catch (e) {
      // Netz nicht verfügbar, nutze Cache
    }

    // Fallback zu Cache
    const hit = await cache.match(event.request, { ignoreSearch: true });
    return hit || new Response('Offline', { status: 503 });
  })());
});
