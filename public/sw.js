'use strict';

const CACHE = 'ctrl-ppto-v25';
const SHELL = [
  '/',
  '/index.html',
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
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
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

  // Never cache API calls — always go to the network so data stays fresh.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'Sin conexión' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })));
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
