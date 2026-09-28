const CACHE = 'parkalert-v7';
const ASSETS = [
  '/', '/style.css', '/time.js', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// API: network only (live data). The app's own files: network first, with
// the cached copy when offline. Only good responses are kept, and every page
// load (/, /?join=CODE, a deep link) is the same shell, cached once as "/".
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const page = e.request.mode === 'navigate';
  if (!page && !ASSETS.includes(url.pathname)) return;
  const key = page ? '/' : url.pathname;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || Response.error()))
  );
});
