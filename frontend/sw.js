const CACHE_NAME = 'gestiva-v9-app-instalable';

// Shells que guardamos para que la app abra aunque no haya internet.
// /mozo  → app del equipo (mozos)
// /app   → panel del dueño
// /cocina → pantalla de cocina (KDS)
const APP_SHELL = [
  './mozo.html',
  './app.html',
  './cocina.html',
  './gestiva-config.js',
  './install-app.js',
  './manifest.json',
  './manifest-app.json',
  './assets/favicon.png?v=2',
  './assets/logo-gestiva-icon.png?v=2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll falla entero si un archivo falla: los agregamos de a uno para
      // que un 404 puntual no rompa la instalación del service worker.
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
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

// Devuelve el shell que corresponde según a dónde estaba navegando el usuario.
function shellFor(url) {
  const p = (url.pathname || '').toLowerCase();
  if (p.startsWith('/cocina')) return './cocina.html';
  if (p.startsWith('/mozo')) return './mozo.html';
  return './app.html';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navegaciones: siempre intentamos red primero (para tomar la última versión)
  // y si no hay internet servimos el shell cacheado que corresponda.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(new Request(req, { cache: 'reload' }))
        .catch(() => caches.match(shellFor(new URL(req.url))))
    );
    return;
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
