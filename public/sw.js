// One cache per deployed version, filled all at once when the version
// installs and served from as a set. A page from one version can then never
// run a script from another, which a per-file network/cache race allowed on
// slow park Wi-Fi. The server stamps the version in, so each deploy is a
// changed worker the browser picks up on its own.
// localClock, to write pushes' times the phone's way, as the app does.
importScripts('/time.js');

const VERSION = '__APP_VERSION__';
const CACHE = `parkalert-${VERSION}`;
const ASSETS = [
  '/', '/style.css', '/time.js', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg', '/icons/apple-touch-icon.png', '/icons/badge-96.png',
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
      // Old versions' files go; the phone left for pushsubscriptionchange stays.
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('parkalert-') && k !== CACHE && k !== 'parkalert-phone').map((k) => caches.delete(k))))
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
  // A file asked for with a query (a trip's own manifest) is not the cached one.
  if (key !== '/' && (!ASSETS.includes(key) || url.search)) return;
  e.respondWith(
    caches.open(CACHE)
      .then((c) => c.match(key))
      .then((hit) => hit || fetch(e.request))
  );
});

// The app's own notifications. The server sends { title, body, url, tag,
// quiet, badge, ride }; a newer notification with the same tag (the same
// ride, or the same storm) replaces the older. A quiet one replaces it
// without a sound. ride: { id, status, downSince } for a one-ride push.
self.addEventListener('push', (e) => {
  let d;
  try { d = e.data.json(); } catch { d = { title: 'ParkAlert', body: e.data?.text() || '' }; }
  // The Home Screen badge follows the rides down, even with the app closed.
  if (Number.isInteger(d.badge)) {
    try { (d.badge ? self.navigator.setAppBadge?.(d.badge) : self.navigator.clearAppBadge?.())?.catch?.(() => {}); } catch {}
  }
  // An open app refreshes at once, so what it shows matches what just
  // arrived, and patches the ride the push is about straight away.
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((ws) => ws.forEach((w) => w.postMessage({ type: 'refresh', ride: d.ride || null }))).catch(() => {}));
  e.waitUntil(self.registration.showNotification(localClock(d.title) || 'ParkAlert', {
    body: localClock(d.body) || '',
    tag: d.tag || undefined,
    renotify: !!d.tag && !d.quiet,
    silent: !!d.quiet,
    icon: '/icons/icon-192.png',
    // Android draws the badge from its alpha alone: a full-colour square
    // came out as a solid white block in the status bar.
    badge: '/icons/badge-96.png',
    data: { url: d.url || '/', ride: d.ride || null },
  }));
});

// A tapped notification opens what it is about, in the app window if one is
// open (it is told where to go) or in a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin);
  const target = url.origin === self.location.origin ? url.href : self.location.origin + '/';
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', url: target, ride: e.notification.data?.ride || null });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// The push service can replace a subscription while the app is closed.
// Left alone, the old address stops working, the server drops the phone
// and it hears nothing until the app is next opened, while it still says
// "Alerts on". So the worker subscribes again and tells the server itself,
// using the trip and phone the page left it (it can't read the page's
// storage).
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const saved = await (await caches.open('parkalert-phone')).match('/phone');
    if (!saved) return;
    const { trip, id } = await saved.json();
    let sub = e.newSubscription;
    if (!sub) {
      const { publicKey } = await (await fetch('/api/push-key')).json();
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    await fetch(`/api/trips/${encodeURIComponent(trip)}/devices/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  })().catch(() => {}));
});
