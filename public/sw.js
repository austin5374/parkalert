// One cache per deployed version, filled all at once when the version
// installs and served from as a set. A page from one version can then never
// run a script from another, which a per-file network/cache race allowed on
// slow park Wi-Fi. The server stamps the version in, so each deploy is a
// changed worker the browser picks up on its own.
const VERSION = '__APP_VERSION__';
const CACHE = `parkalert-${VERSION}`;
const ASSETS = [
  '/', '/style.css', '/time.js', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))));
    // Normally a new version waits until the page says the guest is ready
    // (tapped Reload, or put the app away), so nothing changes under a
    // finger mid-use. Pages from before versioned caches (parkalert-v1 to
    // v9) don't know to say so, so replacing one of those takes over at
    // once; their page then offers Reload itself.
    const keys = await caches.keys();
    if (keys.some((k) => /^parkalert-v\d+$/.test(k))) await self.skipWaiting();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'activate') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('parkalert-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app's own files come from this version's cache, instantly and with or
// without signal; every page address (/, /ride/<id>, a push's link) is the
// same shell. The API is never cached: live data only.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? '/' : url.pathname;
  if (key !== '/' && !ASSETS.includes(key)) return;
  e.respondWith(
    caches.open(CACHE)
      .then((c) => c.match(key))
      .then((hit) => hit || fetch(e.request))
  );
});
