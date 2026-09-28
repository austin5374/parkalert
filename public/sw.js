const CACHE = 'parkalert-v9';
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

// API: network only (live data). The app's own files: the network if it
// answers within 3 seconds, else the cached copy, with the network answer
// still saved for next time. With no signal the cache answers at once; on
// one bar that connects but barely moves ("lie-fi", common in queues) the
// app no longer waits out the browser's own long timeout. A cached page
// that turns out older than the server is caught by the app's version
// check. Only good responses are kept, and every page load (/, /?join=CODE,
// a deep link) is the same shell, cached once as "/".
const NETWORK_WAIT_MS = 3000;
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const page = e.request.mode === 'navigate';
  if (!page && !ASSETS.includes(url.pathname)) return;
  const key = page ? '/' : url.pathname;
  const network = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
    }
    return res;
  });
  e.respondWith((async () => {
    const cached = await caches.match(key);
    if (!cached) return network.catch(() => Response.error());
    e.waitUntil(network.catch(() => {}));
    const slow = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
    try {
      return await Promise.race([network, slow]);
    } catch {
      return cached;
    }
  })());
});
