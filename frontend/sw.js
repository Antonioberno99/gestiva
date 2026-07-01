const CACHE_NAME = 'gestiva-equipo-v5-item-notes';
const APP_SHELL = [
  './mozo.html',
  './gestiva-config.js',
  './manifest.json',
  './assets/favicon.png',
  './assets/logo-gestiva-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(new Request(req, { cache: 'reload' })).catch(() => caches.match('./mozo.html'))
    );
    return;
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
