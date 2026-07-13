'use strict';

const CACHE = 'ctrl-ppto-v137';
const SHELL = [
  '/',
  '/index.html',
  '/theme-init.js',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/chart.umd.min.js',
  '/vendor/vercel-blob-client.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/assets/logo-roforb.png',
  '/assets/logo-roforb-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // La API nunca se intercepta: ni event.respondWith() se dispara para estas
  // rutas. No solo "no cachear" (como antes) — el SW ni siquiera debe hacer
  // de intermediario, porque event.respondWith(fetch(request)) crea una
  // segunda petición real (visible en Network tab con Initiator sw.js,
  // además de la de app.js), y toda petición que muta datos (login, POST/PUT/
  // DELETE) no debe pasar por ahí. Sin respondWith(), el navegador despacha
  // la petición nativamente, sin que el SW la toque en absoluto.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell: cache-first, falling back to network, then refresh cache.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request).then((resp) => {
        if (resp.ok) caches.open(CACHE).then((c) => c.put(request, resp.clone()));
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
