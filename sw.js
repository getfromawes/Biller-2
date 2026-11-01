// Offline cache. Serves the app from cache first and refreshes it in the background,
// so the shop keeps working without internet and picks up updates on the next open.
const CACHE = 'shawear-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app.js',
  './db.js',
  './billing.js',
  './invoice-view.js',
  './pdf.js',
  './styles.css',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      const network = fetch(event.request)
        .then((res) => { if (res.ok) cache.put(event.request, res.clone()); return res; })
        .catch(() => null);
      return hit || (await network) || cache.match('./index.html');
    }),
  );
});
