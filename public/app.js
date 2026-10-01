/* ParkAlert client. No framework, no build step. */
const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 30_000;
const TICK_MS = 15_000;
const STALE_MS = 3 * 60_000;
const APP_STORE = 'https://apps.apple.com/app/ntfy/id1625396347';
const PLAY_STORE = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';

let tripCode = localStorage.getItem('parkalert.trip');
let dash = null; // last /dashboard payload
let parks = [];
let offline = false; // the last refresh failed; `failure` says how
// Why: 'offline' (no connection), 'server' (ParkAlert answered with an
// error, as Railway's proxy does when the app is down), 'busy' (429) or
// 'slow' (no answer in time). A phone that is online is never told it's
// offline because the server is down.
let failure = 'offline';
function failureOf(err) {
  if (navigator.onLine === false) return 'offline';
  if (err?.status === 429) return 'busy';
  if (err?.status >= 500) return 'server';
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'slow';
  if (err?.status) return 'server';
  return 'offline';
}
const FAILURE_META = {
  offline: 'Offline',
  server: "ParkAlert isn't responding",
  busy: 'Busy, trying again shortly',
  slow: 'Slow connection',
};
let refreshTimer = null;
let view = 'down';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const platform = /android/i.test(navigator.userAgent)
  ? 'android'
  : /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform))
    ? 'ios'
    : 'desktop';

/* ---------- Helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Times are shown in the park's own zone: planning from home should still say
// 3:30 PM for 3:30 PM at the park. They are written the phone's way (12 or
// 24 hours, its language), and the service worker writes pushes' times the
// same way (localClock in time.js), so an alert and the card it opens never
// read "2:10 PM" and "14:10" for one moment. ntfy pushes stay as sent.
const LOCALE = navigator.language || 'en-US';
// The space before AM or PM never breaks: "5:53 AM" stays on one line.
function fmtTime(ts) {
  if (ts == null) return '';
  return new Intl.DateTimeFormat(LOCALE, {
    hour: 'numeric', minute: '2-digit', timeZone: dash?.park.timezone || undefined,
  }).format(new Date(ts)).replace(/\s(?=[AP]M\b)/, '\u00a0');
}

// A time that may not be today, said the way a person would: "9:30 PM",
// "tomorrow at 7:00 AM", "yesterday at 3:42 PM" or "Mon at 7:00 AM". Park
// days, not phone days.
function fmtUntil(ts) {
  const tz = dash?.park.timezone || undefined;
  const today = localDay(Date.now(), tz);
  const day = localDay(ts, tz);
  if (day === today) return fmtTime(ts);
  if (day === localDay(Date.now() + 24 * 3600_000, tz)) return `tomorrow at ${fmtTime(ts)}`;
  if (day === localDay(Date.now() - 24 * 3600_000, tz)) return `yesterday at ${fmtTime(ts)}`;
  const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', timeZone: tz }).format(new Date(ts));
  return `${weekday} at ${fmtTime(ts)}`;
}

function sortKey(name) {
  return name.replace(/^[^a-z0-9]+/i, '').replace(/^the\s+/i, '').toLowerCase();
}

const alertsReadyKey = () => `parkalert.alertsReady.${tripCode}`;
const alertsReady = () => !!phone.id || localStorage.getItem(alertsReadyKey()) === '1';

/* ---------- API ---------- */
// Park signal can stall a request indefinitely; give up and say so instead.
const API_TIMEOUT_MS = 15_000;

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout?.(API_TIMEOUT_MS),
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

const patchTrip = (body) => api(`/trips/${tripCode}`, { method: 'PATCH', body });

// Optimistic change with an honest rollback: the UI moves first, and if the
// server refuses, it moves back and says so. Saves go out one at a time, in
// order, and a failure shows the trip exactly as the server last confirmed
// it. Restoring a snapshot taken before this change instead used to undo
// the wrong thing when two saves overlapped and both failed, leaving a
// switch showing a change that was never saved.
let confirmedTrip = null; // the trip as the server last returned it
let savesPending = 0;
let saveChain = Promise.resolve();
function confirmTrip(trip) {
  confirmedTrip = structuredClone(trip);
}
// Two tabs on one trip (or Safari and the Home Screen app on a computer):
// a change saved in one shows in the other at once, instead of at its next
// refresh. A trip joined or left in another tab reloads this one onto it.
const otherTabs = 'BroadcastChannel' in self ? new BroadcastChannel('parkalert') : null;
otherTabs?.addEventListener('message', (e) => {
  if (!e.data || e.data.code !== tripCode || !dash) return;
  if (e.data.what === 'phone') syncPhone();
  else refresh();
});
const tellOtherTabs = (what = 'trip') => otherTabs?.postMessage({ code: tripCode, what });
addEventListener('storage', (e) => {
  if (e.key === 'parkalert.trip' && (e.newValue || null) !== (tripCode || null)) location.reload();
});

function save(apply, body, afterSave) {
  const before = structuredClone(dash.trip);
  apply(dash.trip);
  renderAll();
  savesPending++;
  const run = saveChain.then(async () => {
    try {
      const { trip } = await patchTrip(body);
      confirmTrip(trip);
      tellOtherTabs();
      // Later saves still on their way keep their optimistic changes.
      if (savesPending === 1) {
        Object.assign(dash.trip, trip);
        renderAll();
      }
      afterSave?.(before);
      return true;
    } catch {
      if (confirmedTrip) dash.trip = structuredClone(confirmedTrip);
      renderAll();
      toast("Couldn't save that. Check your connection and try again.");
      return false;
    } finally {
      savesPending--;
    }
  });
  saveChain = run.catch(() => {});
  return run;
}

/* ---------- Toast ---------- */
// One at a time. A plain message never cuts short a toast with an action
// (Undo, Reload): it waits its turn. A newer action replaces an older one,
// since the Undo for what the guest just did is the one that matters (as
// iOS keeps only the latest undo). Plain ones give way to whatever comes
// next. With a sheet open, toasts show at the top, clear of its buttons.
let toastTimer = null;
let toastNow = null; // { text, action }
const toastQueue = [];
function toast(text, action) {
  const item = { text, action };
  // An offer that can wait (a new version) never replaces an Undo either.
  if (toastNow?.action && (!action || action.defer)) {
    toastQueue.push(item);
    return;
  }
  showToast(item);
}
function showToast(item) {
  const t = $('#toast');
  toastNow = item;
  const { text, action } = item;
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { hideToast(); action.run(); };
  t.classList.toggle('top', sheet.isOpen);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action?.sticky ? 12000 : action ? 5000 : 2800);
}
function hideToast() {
  clearTimeout(toastTimer);
  const t = $('#toast');
  if (t.classList.contains('show')) toastGone = { rect: t.getBoundingClientRect(), at: Date.now() };
  t.classList.remove('show');
  toastNow = null;
  const next = toastQueue.shift();
  if (next) setTimeout(() => showToast(next), 250);
}
// A tap aimed at a toast that faded just as it landed does nothing, rather
// than hitting whatever was underneath (the Trip tab's park row, say).
let toastGone = null;
document.addEventListener('click', (e) => {
  if (!toastGone || Date.now() - toastGone.at > 400 || e.target.closest('#toast')) return;
  const r = toastGone.rect;
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// iOS Safari only shows :active press states under an element with a touch
// listener; main has one, sheets and the setup screen didn't. One empty
// passive listener on the document covers every control.
document.addEventListener('touchstart', () => {}, { passive: true });

/* ---------- Haptics ---------- */
// A light tick where native apps give one. Android has vibrate(); iOS
// Safari doesn't, but toggling a native switch input (iOS 17.4+) plays the
// system tick, so a hidden one is flipped inside the gesture.
const haptic = (() => {
  let label = null;
  return () => {
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    if (platform !== 'ios') return;
    if (!label) {
      label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
    }
    label.click();
  };
})();

// Moving focus for screen readers when a page or sheet opens, without the
// keyboard focus ring: iOS drew a heavy blue box round every page's back
// button, which read as a glitch. A keyboard user (last input a key) still
// gets the ring.
let keyboardUser = false;
addEventListener('keydown', (e) => { if (e.key === 'Tab') keyboardUser = true; }, true);
addEventListener('pointerdown', () => { keyboardUser = false; }, true);
function quietFocus(node) {
  if (!node) return;
  if (!keyboardUser) {
    node.classList.add('quiet-focus');
    node.addEventListener('blur', () => node.classList.remove('quiet-focus'), { once: true });
  }
  node.focus({ preventScroll: true });
}

/* ---------- In-place updates ---------- */
// Refreshes patch what is on screen instead of replacing it. Replacing the
// nodes every 15 seconds was the root of most of the jank: a tap landing
// mid-rebuild hit a node that no longer existed, press states and focus cut
// out, and a switch was redrawn already in its new position, so it never
// slid. Nodes are matched by data-key (or data-ride, data-id, id) and
// otherwise by position and tag; only changed attributes and text are
// touched. A chart box is rebuilt only when its data-sig changes.
// Which attribute a key came from is part of it: a row's name button
// (data-ride) and its switch (data-id) carry the same ride id.
const keyOf = (n) => {
  if (n.nodeType !== 1) return null;
  for (const [attr, tag] of [['data-key', 'k'], ['data-ride', 'r'], ['data-id', 'i'], ['id', '#']]) {
    const v = n.getAttribute(attr);
    if (v) return `${tag}:${v}`;
  }
  return null;
};

function fragment(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content;
}

function morph(target, next) {
  morphChildren(target, typeof next === 'string' ? fragment(next) : next);
}

function morphChildren(parent, src) {
  const keyed = new Map();
  for (const n of parent.childNodes) {
    const k = keyOf(n);
    if (k != null) keyed.set(`${n.nodeName}#${k}`, n);
  }
  let ref = parent.firstChild;
  for (const nn of [...src.childNodes]) {
    if (nn.nodeType === 8) continue; // comments
    const k = keyOf(nn);
    let match = null;
    if (k != null) {
      match = keyed.get(`${nn.nodeName}#${k}`) || null;
      if (match) keyed.delete(`${nn.nodeName}#${k}`);
    } else if (ref && keyOf(ref) == null && ref.nodeName === nn.nodeName) {
      match = ref;
    }
    if (match) {
      if (match === ref) ref = ref.nextSibling;
      else parent.insertBefore(match, ref);
      patchNode(match, nn);
    } else {
      parent.insertBefore(nn, ref);
    }
  }
  while (ref) {
    const next = ref.nextSibling;
    ref.remove();
    ref = next;
  }
}

function patchNode(a, b) {
  if (a.nodeType === 3) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeType !== 1) return;
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  if (a.hasAttribute('data-chart')) {
    // Same data: keep the drawn chart, with its scrub position and listeners.
    // While a finger is on it, keep it even if the data moved; the next
    // refresh after the finger lifts redraws it.
    if (a._busy) return;
    if (a._drawn !== a.getAttribute('data-sig')) a.replaceChildren();
    return;
  }
  morphChildren(a, b);
}

/* ---------- Spring (damping ratio + response, as Apple frames it) ---------- */
function spring({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone }) {
  const k = (2 * Math.PI / response) ** 2;
  const c = (4 * Math.PI * damping) / response;
  let x = from, v = velocity, last = performance.now(), raf = 0;
  const step = (now) => {
    // Large gaps (a throttled or busy phone) are integrated in small sub-steps
    // rather than dropped, so the motion still lands on time.
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    for (let i = 0; i < n; i++) {
      v += (-k * (x - to) - c * v) * (dt / n);
      x += v * (dt / n);
    }
    if (Math.abs(x - to) < 0.4 && Math.abs(v) < 8) {
      onUpdate(to);
      onDone?.();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop() { cancelAnimationFrame(raf); } };
}

// Where a flick would come to rest, the way scroll deceleration projects it.
const project = (v, rate = 0.99) => ((v / 1000) * rate) / (1 - rate);

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Velocity in px/s from the last 80 ms of samples: a finger that stopped
// before lifting has none, however fast it moved earlier.
function releaseVelocity(samples, t) {
  const s = samples.filter((p) => t - p.t <= 80);
  const a = s[0], b = s[s.length - 1];
  return s.length > 1 && b.t > a.t ? ((b.v - a.v) / (b.t - a.t)) * 1000 : 0;
}

/* ---------- Back ---------- */
// Each page and the sheet add one history entry, so Back (the browser's,
// Android's, or a page's own chevron) closes the top one instead of leaving
// the app. Closing one any other way (a swipe, the scrim, a button) closes it
// at once and then takes its entry back off, quietly.
const backStack = []; // { onBack, done, queued }
let quietPops = 0;
// history.back() and go() land later, in a popstate. A layer opened before
// that lands must not push its entry yet, or the pending jump takes that
// entry instead, history ends up a step short, and a later Back walks out of
// the app (found by the random-tap test: switch tab with a page open, then
// open a ride at once). Entries wait here until our own jumps have landed.
const queued = [];
function addBack(onBack, url) {
  const entry = { onBack, done: false, queued: false };
  backStack.push(entry);
  const push = () => { entry.queued = false; history.pushState({ parkalert: backStack.length }, '', url || location.pathname + location.search); };
  if (quietPops) { entry.queued = true; queued.push({ entry, push }); } else push();
  return entry;
}
function leave(entry, closeNow) {
  if (!entry || entry.done) return;
  entry.done = true;
  const i = backStack.indexOf(entry);
  if (i !== -1) backStack.splice(i, 1);
  closeNow?.();
  // Its entry was never pushed: drop it, nothing to take back.
  if (entry.queued) {
    queued.splice(queued.findIndex((q) => q.entry === entry), 1);
    return;
  }
  quietPops++;
  history.back();
}
addEventListener('popstate', () => {
  // Our own history.back()/go(): the layers are already closed and their
  // entries already off backStack. Once the last lands, queued entries go in.
  if (quietPops) {
    quietPops--;
    if (!quietPops) while (queued.length) queued.shift().push();
    return;
  }
  const entry = backStack.pop();
  if (entry && !entry.done) {
    entry.done = true;
    entry.onBack();
  }
});

/* ---------- Sheet ---------- */
// For short tasks only (pause, park, leave, alert setup, an invite): one at a
// time, never stacked. Detail lives on pages. It drags down from anywhere
// while its content is scrolled to the top, and a flick closes it.
const sheet = (() => {
  const layer = $('#sheet-layer'), panel = $('#sheet'), scrim = $('#scrim'), body = $('#sheet-body');
  let y = 0, h = 1, anim = null, isOpen = false, closing = false, entry = null, returnFocus = null, onClosed = null;
  const measure = () => { h = panel.getBoundingClientRect().height || h; return h; };
  const paint = (v) => {
    y = v;
    panel.style.transform = `translate3d(0,${v}px,0)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v / h)));
  };
  function animateTo(target, velocity = 0, damping = 1, done) {
    anim?.stop();
    // Hidden, frames don't run: land at once rather than wait for the next look.
    if (reducedMotion() || document.hidden) { paint(target); done?.(); return; }
    // Always from the live, on-screen value, so a sheet grabbed mid-flight never jumps.
    anim = spring({ from: y, to: target, velocity, damping, response: 0.32, onUpdate: paint, onDone: done });
  }
  const background = () => [$('#app'), $('#setup'), $('#pages')];
  const setInert = (on) => background().forEach((n) => { n.inert = on; });

  function finish() {
    closing = false;
    layer.classList.add('hidden');
    setInert(false);
    body.replaceChildren();
    returnFocus?.focus?.({ preventScroll: true });
    const cb = onClosed;
    onClosed = null;
    cb?.();
  }
  function slideAway(velocity = 0) {
    isOpen = false;
    closing = true;
    animateTo(measure(), velocity, 1, finish);
  }

  function open(content, { onClose } = {}) {
    if (isOpen) {
      // Already up: a new task replaces the old one in place.
      onClosed?.();
      onClosed = onClose || null;
      body.replaceChildren(content);
      body.scrollTop = 0;
      measure();
      return;
    }
    if (closing) { closing = false; onClosed?.(); }
    else returnFocus = document.activeElement;
    onClosed = onClose || null;
    body.replaceChildren(content);
    body.scrollTop = 0;
    layer.classList.remove('hidden');
    setInert(true);
    const wasHidden = !closing && y >= h - 1;
    measure();
    if (wasHidden || !anim) paint(h);
    isOpen = true;
    entry = addBack(() => slideAway());
    animateTo(0);
    quietFocus(panel);
  }
  function close(velocity = 0) {
    if (!isOpen) return;
    leave(entry, () => slideAway(velocity));
  }

  // Drag, 1:1 from where the finger landed, rubber-banded above the top.
  let drag = null;
  const begin = (cy, t) => { anim?.stop(); measure(); drag = { startY: cy, from: y, samples: [{ t, v: y }] }; };
  const follow = (cy, t) => {
    let next = drag.from + (cy - drag.startY);
    if (next < 0) next = rubberband(next, h);
    paint(next);
    drag.samples.push({ t, v: next });
    if (drag.samples.length > 8) drag.samples.shift();
  };
  const release = (t) => {
    const v = releaseVelocity(drag.samples, t);
    drag = null;
    if (y + project(v, 0.995) > h * 0.45) close(v);
    else animateTo(0, v, Math.abs(v) > 300 ? 0.82 : 1);
  };

  const grabber = $('#grabber');
  grabber.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !isOpen) return;
    begin(e.clientY, e.timeStamp);
    drag.id = e.pointerId;
    grabber.setPointerCapture(e.pointerId);
  });
  grabber.addEventListener('pointermove', (e) => { if (drag?.id === e.pointerId) follow(e.clientY, e.timeStamp); });
  for (const type of ['pointerup', 'pointercancel']) {
    grabber.addEventListener(type, (e) => { if (drag?.id === e.pointerId) release(e.timeStamp); });
  }

  // Anywhere else: a downward pull while the content is at its top moves the
  // sheet; otherwise the content scrolls. One continuous motion either way.
  let touch = null;
  body.addEventListener('touchstart', (e) => {
    touch = !isOpen || e.touches.length > 1 || e.target.closest('.chart, input')
      ? null
      : { startY: e.touches[0].clientY, lastY: e.touches[0].clientY, mode: null };
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const cy = e.touches[0].clientY;
    const goingDown = cy > touch.lastY;
    touch.lastY = cy;
    if (touch.mode === 'sheet') {
      if (e.cancelable) e.preventDefault();
      follow(cy, e.timeStamp);
      return;
    }
    if (touch.mode || Math.abs(cy - touch.startY) < 6) return;
    if (body.scrollTop <= 0 && goingDown && e.cancelable) {
      touch.mode = 'sheet';
      e.preventDefault();
      begin(cy, e.timeStamp);
      return;
    }
    touch.mode = 'scroll';
  }, { passive: false });
  const touchEnd = (e) => {
    if (touch?.mode === 'sheet' && drag) release(e.timeStamp);
    touch = null;
  };
  body.addEventListener('touchend', touchEnd);
  body.addEventListener('touchcancel', touchEnd);

  scrim.addEventListener('click', () => close());
  // A drag on the dimmed page is not a scroll of the page under it.
  scrim.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });

  return { open, close: () => close(), get isOpen() { return isOpen; } };
})();

function sheetHead(title, html) {
  return `<div class="sheet-head"><h2 class="title-2" id="sheet-title">${esc(title)}</h2>${html ? `<p>${html}</p>` : ''}</div>`;
}

/* ---------- Pages ---------- */
// A ride, the park or a hold opens as a page that slides in from the right,
// as a detail screen does in any iPhone app (and in the WDW transport app):
// a back chevron naming where you came from, its own address, Back and a
// swipe from the left edge to go back. Pages stack (a ride from a hold) and
// each stays live: refreshes patch it in place.
//
// A page is { key, url, back, title(), render() -> html, charts?() -> data,
// load?() }. The page underneath is never transformed when it is the app
// itself: a transform there would break the fixed tab bar.
const pages = (() => {
  const host = $('#pages');
  const shade = host.querySelector('.page-shade');
  const stack = [];
  const width = () => innerWidth;

  const paint = (p, x) => {
    p.x = x;
    p.el.style.transform = `translate3d(${x}px,0,0)`;
    const i = stack.indexOf(p);
    const below = stack[i - 1];
    const progress = 1 - x / width();
    if (below) below.el.style.transform = `translate3d(${(-0.3 * width() * progress).toFixed(1)}px,0,0)`;
    else shade.style.opacity = String(progress);
  };
  // Each page has its own animation. One shared animation let a page opened
  // right after a Back cancel the old page's slide-out halfway, so its
  // removal never ran and it stayed on screen as a ghost duplicate.
  function animate(p, to, velocity = 0, done) {
    p.anim?.stop();
    if (reducedMotion() || document.hidden) { paint(p, to); done?.(); return; }
    p.anim = spring({ from: p.x, to, velocity, damping: 1, response: 0.38, onUpdate: (x) => { if (p.el.isConnected) paint(p, x); }, onDone: done });
  }

  function syncInert() {
    // Everything under the page is out of reach, except the tab bar.
    for (const sel of ['#nav', '#nav-bar', '#app main']) $(sel).inert = stack.length > 0;
    stack.forEach((p, i) => { p.el.inert = i < stack.length - 1; });
    host.classList.toggle('hidden', !stack.length);
    // The tab bar goes solid over a page, or the list under the page shows
    // through it.
    document.body.classList.toggle('paging', stack.length > 0);
  }

  // A page with a scene opens on a strip of the Down now sky, its title on
  // it and Back over it; the rest scroll up underneath.
  function draw(p) {
    if (!p.el.isConnected) return;
    const strip = p.scene?.();
    p.el.classList.toggle('has-strip', !!strip);
    const title = `<h1 class="page-title large-title" data-key="page-title">${esc(p.title())}</h1>`;
    const head = strip
      ? `<div class="page-strip" data-key="strip"><div class="sky-art" data-key="art">${sceneSvg(skyMood(), dash?.park.name || '', { strip: true, train: strip.train })}</div>${title}${strip.action || ''}</div>`
      : title;
    morph(p.body, `${head}${p.render()}`);
    p.el.querySelector('.page-nav-title').textContent = p.title();
    mountCharts(p.body, p.charts?.());
  }

  function push(p) {
    const top = stack[stack.length - 1];
    if (top?.key === p.key) return top;
    p.returnFocus = document.activeElement;
    p.el = el(`
      <section class="page" aria-label="${esc(p.title())}">
        <header class="page-nav">
          <button class="page-back pressable" type="button" data-act="page-back">${icon('chevron', 'back-chevron')}<span>${esc(p.back)}</span></button>
          <span class="page-nav-title" aria-hidden="true"></span>
        </header>
        <div class="page-body"></div>
      </section>`);
    p.body = p.el.querySelector('.page-body');
    // Pull down on a page to refresh it too, as on the tabs.
    const ptr = el('<div class="ptr" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/></svg></div>');
    p.el.insertBefore(ptr, p.body);
    pullToRefresh(p.body, ptr, async () => { await refresh(); await p.load?.(); }, {
      scrollTop: () => p.body.scrollTop,
      blocked: () => sheet.isOpen || pages.top !== p,
    });
    p.body.addEventListener('scroll', () => p.el.classList.toggle('titled', p.body.scrollTop > 36), { passive: true });
    host.appendChild(p.el);
    stack.push(p);
    syncInert();
    draw(p);
    paint(p, width());
    p.entry = addBack(() => slideOut(p), p.url);
    animate(p, 0);
    quietFocus(p.el.querySelector('.page-back'));
    p.load?.();
    return p;
  }

  function remove(p) {
    p.anim?.stop();
    if (!stack.includes(p)) return;
    p.el.remove();
    stack.splice(stack.indexOf(p), 1);
    const below = stack[stack.length - 1];
    if (below) below.el.style.transform = '';
    else shade.style.opacity = '0';
    syncInert();
    p.returnFocus?.focus?.({ preventScroll: true });
  }
  function slideOut(p, velocity = 0) {
    // Safari's own swipe-back already slid the page away on screen; animating
    // it out again showed it twice. Such a Back lands just after a touch at
    // the left edge, so that one is removed at once.
    if (performance.now() - edgeTouchAt < 900) { remove(p); return; }
    animate(p, width(), velocity, () => remove(p));
  }
  function back() {
    const p = stack[stack.length - 1];
    if (p) leave(p.entry, () => slideOut(p));
  }

  // Swipe back from the left edge, 1:1 with the finger; release past the
  // middle (or with a flick) completes it, otherwise it springs home.
  let swipe = null;
  let edgeTouchAt = -Infinity;
  // In Safari itself (not the Home Screen app), iOS has its own edge swipe
  // for Back; ours on top of it fought it. There, only Safari's runs.
  const nativeSwipe = platform === 'ios' && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
  addEventListener('touchstart', (e) => { if (e.touches[0]?.clientX < 30) edgeTouchAt = performance.now(); }, { passive: true, capture: true });
  host.addEventListener('touchstart', (e) => {
    const p = stack[stack.length - 1];
    const t = e.touches[0];
    swipe = !nativeSwipe && p && e.touches.length === 1 && t.clientX < 28
      ? { p, x0: t.clientX, y0: t.clientY, mode: null, samples: [{ t: e.timeStamp, v: 0 }] }
      : null;
    if (swipe) p.anim?.stop();
  }, { passive: true });
  host.addEventListener('touchmove', (e) => {
    if (!swipe) return;
    const t = e.touches[0];
    const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
    if (!swipe.mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.mode = dx > Math.abs(dy) ? 'back' : 'none';
    }
    if (swipe.mode !== 'back') return;
    if (e.cancelable) e.preventDefault();
    const x = Math.max(0, dx);
    paint(swipe.p, x);
    swipe.samples.push({ t: e.timeStamp, v: x });
    if (swipe.samples.length > 8) swipe.samples.shift();
  }, { passive: false });
  const endSwipe = (e) => {
    if (!swipe) return;
    const { p, mode, samples } = swipe;
    swipe = null;
    if (mode !== 'back') return;
    const v = releaseVelocity(samples, e.timeStamp);
    if (p.x + project(v, 0.995) > width() * 0.5) {
      haptic();
      edgeTouchAt = -Infinity; // our own swipe: finish it with its momentum
      leave(p.entry, () => animate(p, width(), v, () => remove(p)));
    } else {
      animate(p, 0, v);
    }
  };
  host.addEventListener('touchend', endSwipe);
  host.addEventListener('touchcancel', endSwipe);
  host.addEventListener('click', (e) => { if (e.target.closest('[data-act=page-back]')) back(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length && !sheet.isOpen) back(); });

  return {
    push,
    back,
    draw,
    refresh() { stack.forEach(draw); },
    get top() { return stack[stack.length - 1] || null; },
    get depth() { return stack.length; },
    // Everything off at once, no animation (the trip changed underneath).
    clear() {
      if (!stack.length) return;
      // Only entries already in history are taken back; queued ones are dropped.
      let pushed = 0;
      for (const p of [...stack]) {
        // Already on its way out (Back taken, sliding away): its entry is
        // gone from history. Counting it again walked out of the app.
        if (p.entry.done) { remove(p); continue; }
        p.entry.done = true;
        const i = backStack.indexOf(p.entry);
        if (i !== -1) backStack.splice(i, 1);
        if (p.entry.queued) queued.splice(queued.findIndex((q) => q.entry === p.entry), 1);
        else pushed++;
        remove(p);
      }
      if (!pushed) return;
      quietPops++;
      history.go(-pushed);
    },
  };
})();

/* ---------- Parks ---------- */
const parkLabel = (name) => name.replace(' (CA)', '');

// The park list is only needed to pick a park, so a phone that already has a
// trip never waits on it (or fails without it) at launch.
async function loadParks() {
  if (!parks.length) ({ parks } = await api('/parks'));
  return parks;
}

function parkGroups(currentId, onPick) {
  const wrap = document.createElement('div');
  // Grouped under each park's resort, in the order the server lists them.
  for (const resort of new Set(parks.map((p) => p.resort || 'Other parks'))) {
    const list = parks.filter((p) => (p.resort || 'Other parks') === resort);
    wrap.appendChild(el(`<h2 class="section-label">${esc(resort)}</h2>`));
    const group = el('<div class="group plain"></div>');
    for (const p of list) {
      const selected = p.id === currentId;
      const row = el(`
        <button class="row pressable ${selected ? 'selected' : ''}" type="button" ${selected ? 'aria-current="true"' : ''}>
          <span class="row-label">${esc(parkLabel(p.name))}</span>
          ${selected ? icon('check', 'check') : icon('chevron', 'chevron')}
        </button>`);
      row.onclick = () => onPick(p, row);
      group.appendChild(row);
    }
    wrap.appendChild(group);
  }
  return wrap;
}

function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestPark(coords) {
  let best = null;
  for (const p of parks) {
    const d = haversineKm(coords, p);
    if (d <= p.radiusKm && (!best || d < best.d)) best = { park: p, d };
  }
  return best?.park || null;
}

/* ---------- Setup ---------- */
function setupStatus(text, warn = false) {
  const s = $('#setup-status');
  s.textContent = text;
  s.classList.toggle('warn', warn);
}

const OFFLINE_SETUP = "Can't reach ParkAlert right now. This will retry when you're back online.";

async function renderSetupParks() {
  try {
    await loadParks();
  } catch {
    setupStatus(OFFLINE_SETUP, true);
    return;
  }
  if ($('#setup-status').textContent === OFFLINE_SETUP) setupStatus('');
  $('#setup-parks').replaceChildren(parkGroups(null, (p, row) => startTrip(p.id, row)));
}

// Location is asked for only when the person taps for it, never on arrival.
function locate() {
  if (!navigator.geolocation || !window.isSecureContext) {
    setupStatus('Location needs a secure connection here. Pick your park below.', true);
    return;
  }
  setupStatus('Finding your park…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        await loadParks();
      } catch {
        setupStatus(OFFLINE_SETUP, true);
        return;
      }
      const park = nearestPark({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      if (park) {
        // A hotel next door or the walkway between two parks can land on
        // the wrong one, so it is a suggestion to confirm.
        setupStatus(`Looks like you're at ${parkLabel(park.name)}.`);
        const found = $('#setup-found');
        found.innerHTML = `<button class="btn-primary pressable" type="button">Start at ${esc(parkLabel(park.name))}</button>`;
        found.classList.remove('hidden');
        found.querySelector('button').onclick = () => startTrip(park.id);
        found.querySelector('button').focus();
      } else {
        setupStatus("You don't seem to be in a park yet. Pick one below.", true);
      }
    },
    (err) => setupStatus(
      err.code === err.PERMISSION_DENIED
        ? 'Location is off for this site. Pick your park below.'
        : "Couldn't get your location. Pick your park below.",
      true
    ),
    { timeout: 10_000, maximumAge: 60_000 }
  );
}

// One trip per tap: a second tap (or a double tap on a slow connection)
// while the first is on its way does nothing, and the tapped row shows a
// spinner where its chevron was so it's clear something is happening.
let starting = null;
async function startTrip(parkId, row = null) {
  if (starting) return starting;
  const list = $('#setup-parks');
  list.setAttribute('aria-busy', 'true');
  list.classList.add('busy');
  const chevron = row?.querySelector('.chevron');
  const spinner = el('<span class="spinner" role="status" aria-label="Creating your trip"></span>');
  chevron?.replaceWith(spinner);
  starting = (async () => {
    try {
      const { trip } = await api('/trips', { method: 'POST', body: { parkId } });
      setTrip(trip.code, { firstRun: true });
    } catch {
      setupStatus("Can't reach ParkAlert right now. Check your connection.", true);
    } finally {
      list.removeAttribute('aria-busy');
      list.classList.remove('busy');
      if (chevron) spinner.replaceWith(chevron);
      starting = null;
    }
  })();
  return starting;
}

// The page's manifest names the trip, so installing from here opens on it.
function syncManifest() {
  $('link[rel=manifest]').href = tripCode ? `/manifest.webmanifest?trip=${tripCode}` : '/manifest.webmanifest';
}

function setTrip(code, { firstRun = false } = {}) {
  pages.clear();
  if (tripCode && code.toUpperCase() !== tripCode) forgetPhone(tripCode);
  if (code.toUpperCase() !== tripCode) {
    // Never show one trip's rides under another trip's code.
    dash = null;
    offline = false;
  }
  tripCode = code.toUpperCase();
  localStorage.setItem('parkalert.trip', tripCode);
  showApp({ firstRun });
}

// Leaving takes the trip's cached rides and its "alerts work here" flag off
// the phone too, so a shared phone keeps no trace of the topic, and
// rejoining starts clean. A toast offers the way back.
function leaveTrip({ undoable = false } = {}) {
  pages.clear();
  const code = tripCode;
  if (code) forgetPhone(code);
  try {
    localStorage.removeItem('parkalert.trip');
    localStorage.removeItem(dashKey(code));
    if (!undoable) localStorage.removeItem(`parkalert.alertsReady.${code}`);
  } catch {}
  tripCode = null;
  dash = null;
  clearTimeout(refreshTimer);
  showSetup();
  if (undoable && code) {
    const ready = localStorage.getItem(`parkalert.alertsReady.${code}`);
    try { localStorage.removeItem(`parkalert.alertsReady.${code}`); } catch {}
    toast(`Left trip ${code}`, {
      label: 'Undo',
      run: () => {
        if (ready) try { localStorage.setItem(`parkalert.alertsReady.${code}`, ready); } catch {}
        setTrip(code);
      },
    });
  }
}

/* ---------- This phone's notifications ---------- */
// ParkAlert's own notifications, no second app: Android and desktop
// browsers anywhere, iPhone once ParkAlert is on the Home Screen (iOS 16.4+).
// Each phone registers itself on the trip, so it can also be paused alone.
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const needsInstallForPush = () => platform === 'ios' && !installed();
const deviceKey = (code = tripCode) => `parkalert.device.${code}`;
const phone = {
  get id() { try { return localStorage.getItem(deviceKey()); } catch { return null; } },
  mute: null, // this phone's own pause, as the server last confirmed it
};
const phoneMuted = () => !!phone.mute && (phone.mute.until === null || phone.mute.until > Date.now());

const bytesOf = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (buf, b64u) => {
  if (!buf) return false;
  const a = new Uint8Array(buf), b = bytesOf(b64u);
  return a.length === b.length && a.every((x, i) => x === b[i]);
};

// Asks for permission (only ever from a tap), subscribes and registers this
// phone on the trip. Resolves 'on', 'denied', 'dismissed' or 'failed'.
async function subscribePhone({ ask = true } = {}) {
  if (!pushSupported()) return 'failed';
  const permission = ask ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'dismissed';
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/push-key');
    let sub = await reg.pushManager.getSubscription();
    // A subscription made for another server key can't carry this one's pushes.
    if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(publicKey) });
    const code = tripCode;
    const { device } = await api(`/trips/${code}/devices`, { method: 'POST', body: { subscription: sub.toJSON() } });
    if (code !== tripCode) return 'failed';
    localStorage.setItem(deviceKey(code), device.id);
    tellWorkerPhone({ trip: code, id: device.id });
    phone.mute = device.mute;
    return 'on';
  } catch {
    return 'failed';
  }
}

// On each open: re-register quietly (the browser may have renewed the
// subscription) and learn this phone's own pause. A phone that already allows
// notifications joins a new trip's alerts without being asked again.
async function syncPhone() {
  if (!tripCode || !pushSupported() || Notification.permission !== 'granted') {
    phone.mute = null;
    return;
  }
  if (phone.id || !localStorage.getItem(`parkalert.phoneOff.${tripCode}`)) await subscribePhone({ ask: false });
  if (dash) renderAll();
}

// The service worker re-registers this phone if the push service replaces
// its subscription while the app is closed; it can't read localStorage, so
// the trip and phone are left for it in its own storage.
function tellWorkerPhone(phoneOnTrip) {
  caches.open('parkalert-phone')
    .then((c) => (phoneOnTrip ? c.put('/phone', new Response(JSON.stringify(phoneOnTrip))) : c.delete('/phone')))
    .catch(() => {});
}

// Leaving a trip takes this phone off its alerts.
async function forgetPhone(code) {
  tellWorkerPhone(null);
  let id = null;
  try { id = localStorage.getItem(deviceKey(code)); localStorage.removeItem(deviceKey(code)); } catch {}
  phone.mute = null;
  if (id) await api(`/trips/${code}/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
}

async function setPhoneMute(mute, { undo = true } = {}) {
  const before = phone.mute;
  phone.mute = mute;
  renderAll();
  try {
    const { device } = await api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}`, { method: 'PATCH', body: { mute } });
    phone.mute = device.mute;
    tellOtherTabs('phone');
    renderAll();
    if (undo) {
      toast(mute ? (mute.until === null ? 'This phone is paused until you turn it back on' : `This phone is paused until ${fmtUntil(mute.until)}`) : 'This phone gets alerts again', {
        label: 'Undo',
        run: () => setPhoneMute(before, { undo: false }),
      });
    }
  } catch {
    phone.mute = before;
    renderAll();
    toast("Couldn't save that. Check your connection and try again.");
  }
}

// Word from the service worker. A push arriving while the app is open:
// what it shows should match what just arrived, so the ride the push is
// about changes at once and everything else follows with a refresh. A tapped
// notification with the app already open (which on iPhone changes no
// visibility, so nothing else would refresh): go where it points.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'refresh') {
    patchRide(e.data.ride);
    if (tripCode && dash) refresh();
    return;
  }
  if (e.data?.type !== 'open') return;
  const url = new URL(e.data.url, location.origin);
  const code = url.searchParams.get('trip')?.toUpperCase();
  pendingOpen = { ride: url.searchParams.get('ride'), view: url.searchParams.get('view') };
  if (code && code !== tripCode) {
    setTrip(code);
    return;
  }
  patchRide(e.data.ride);
  refresh();
  openPending();
});

// A push's own word on its ride ({ id, status, downSince }), applied to the
// last dashboard until the next one lands.
function patchRide(p) {
  const r = p?.id && dash?.rides.find((x) => x.id === p.id);
  if (!r || !p.status || r.status === p.status) return;
  r.status = p.status;
  if (p.status === 'DOWN') {
    r.downSince = p.downSince ?? Date.now();
    r.waitTime = null;
    delete r.outlook;
  } else if (p.status === 'OPERATING') r.downSince = null;
  renderAll();
}

/* ---------- Header ---------- */
function alertState() {
  const m = dash.trip.mute;
  if (m && (m.until === null || m.until > Date.now())) return { kind: 'paused', until: m.until, scope: 'trip' };
  if (phoneMuted()) return { kind: 'paused', until: phone.mute.until, scope: 'phone' };
  // The same rule the server mutes by: its hours and its rides together
  // (server/parkstatus.js). Older servers only sent the hours.
  if (parkClosed()) return { kind: 'closed' };
  if (!alertsReady()) return { kind: 'setup' };
  // Alerts on, about nothing: say so instead of a reassuring bell.
  if (!dash.rides.some((r) => isFollowing(r.id))) return { kind: 'none' };
  return { kind: 'on' };
}

// Closed for alerts: past its hours with the rides agreeing, or closed early.
function parkClosed() {
  const st = dash.park.status;
  if (st) return st === 'closed' || st === 'closedEarly';
  const close = dash.park.lastCloseTime || dash.park.lateEvent?.closingTime || dash.park.closingTime;
  return !!close && Date.now() > Date.parse(close);
}

function hoursText() {
  const { openingTime: open, closingTime: close, lateEvent, lastCloseTime, status } = dash.park;
  const now = Date.now();
  const lastClose = lastCloseTime || lateEvent?.closingTime || close;
  if (status === 'closedEarly') return 'Most rides have closed';
  if (status === 'openLate') return 'Open past its posted hours';
  if (open && now < Date.parse(open)) return `Opens ${fmtTime(Date.parse(open))}`;
  if (parkClosed() || (!status && lastClose && now > Date.parse(lastClose))) return 'Closed for the day';
  if (close && now < Date.parse(close)) {
    return `Open until ${fmtTime(Date.parse(close))}${lateEvent ? `, event until ${fmtTime(Date.parse(lateEvent.closingTime))}` : ''}`;
  }
  if (lateEvent) return `Event until ${fmtTime(Date.parse(lateEvent.closingTime))}`;
  return 'Hours unavailable';
}

// At accessibility text sizes (150% and up) iOS stops squeezing things side
// by side: titles take the full width and trailing controls move below.
// The layout switches on a class, set from the root size, which follows
// the reader's setting.
// iOS hands the reader's Text Size setting (Dynamic Type) to web content
// only through the -apple-system-body font. The layout is in rem on a 16px
// root, so the root is set to the same share of 16px that the reader's body
// size is of the default 17px. Elsewhere the font name is ignored and the
// browser's own text size applies as before. Checked again on return,
// since the setting can change while the app is in the background.
function syncDynamicType() {
  // Mac Safari knows the font too, but its body size (13px) isn't a
  // reader's setting and would shrink the whole app.
  if (platform !== 'ios' || navigator.maxTouchPoints === 0) return;
  const probe = document.createElement('span');
  probe.style.font = '-apple-system-body';
  if (!probe.style.font) return; // not an Apple browser
  probe.style.cssText += ';position:absolute;visibility:hidden;pointer-events:none';
  probe.textContent = 'x';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  // Up to twice the default: past that the rows still read, but only one
  // or two fit a screen, and iPhone Zoom serves better. Headlines stop
  // growing sooner (in style.css), so the answer stays on screen.
  if (px > 0) document.documentElement.style.fontSize = `${((Math.min(px, 34) / 17) * 100).toFixed(2)}%`;
}
syncDynamicType();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  syncDynamicType();
  // Everything, not just the header: an empty state saying "Everything's
  // running" under "5 min old" is wrong until the refresh lands.
  if (dash) renderAll();
});

function syncTypeSize() {
  const big = parseFloat(getComputedStyle(document.documentElement).fontSize) >= 24;
  document.documentElement.classList.toggle('ax-type', big);
  return big;
}
syncTypeSize();
addEventListener('resize', syncTypeSize);


let lastBadge = null;
let lastMetaGist = null;
const announce = (text) => { $('#announce').textContent = text; };

// The compact bar's title: the park on Down now, else the tab's name.
function syncNavBar() {
  $('#nav-bar-title').textContent = view === 'down' ? (dash ? parkLabel(dash.park.name) : 'ParkAlert') : ({ rides: 'Rides', trip: 'Trip' })[view] || '';
}

// The screen's headline: how many of your rides are down, or how the park
// stands when none are.
function statusTitle() {
  if (!dash.lastPoll) return 'Waiting for ride times';
  const down = dash.rides.filter((r) => r.status === 'DOWN' && r.downSince && !r.other);
  const mine = down.filter((r) => isFollowing(r.id)).length;
  if (mine) return `${mine} of your rides ${mine === 1 ? 'is' : 'are'} down`;
  const open = Date.parse(dash.park.openingTime || '');
  if (dash.park.status === 'closedEarly') return 'Most rides are closed';
  if (open && Date.now() < open) return `Opens at ${fmtTime(open)}`;
  if (alertState().kind === 'closed') return 'Closed for the day';
  if (offline || Date.now() - dash.lastPoll > STALE_MS) return `Nothing was down at ${fmtTime(dash.lastPoll)}`;
  return down.length ? 'Your rides are running' : "Everything's running";
}

// The sky over the board: the park's own coaster, lit for the hour on the
// park's clock, and stormy while the weather has rides closed.
const skyMood = () => sceneMood(dash ? parkHour() : new Date().getHours(), !!dash?.rides.some((r) => r.status === 'DOWN' && stormGoingOn(r.outlook)));
function syncSky() {
  const mood = skyMood();
  const art = $('#sky-art');
  const key = `${mood}|${dash?.park.name || ''}`;
  if (art.dataset.key !== key) {
    art.dataset.key = key;
    art.innerHTML = sceneSvg(mood, dash?.park.name || '');
  }
}

function renderHeader() {
  const name = parkLabel(dash.park.name);
  $('#park-name').textContent = name;
  $('#btn-park').setAttribute('aria-label', `${name}. Park hours, crowds and other parks`);
  syncNavBar();
  document.title = `${name} · ParkAlert`;
  morph($('#status-title'), esc(statusTitle()));
  syncSky();

  const meta = $('#park-meta');
  // Old by the data's age alone: one failed poll is not an outage (the
  // server polls every minute, and says nothing is wrong for 3).
  const stale = !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS;
  const flash = metaFlash && Date.now() < metaFlash.until ? metaFlash : null;
  const crowd = dash.crowd && !dash.crowd.paused && alertState().kind !== 'closed' ? dash.crowd.label : null;
  meta.textContent = flash ? flash.text : offline
    ? `${FAILURE_META[failure]} · updated ${fmtUntil(dash.lastPoll)}`
    : stale
      ? !dash.lastPoll ? 'Waiting for the ride feed'
        : dash.lastError ? `Ride feed not answering · updated ${fmtUntil(dash.lastPoll)}`
          : `Ride times may be out of date · ${fmtDuration(Date.now() - dash.lastPoll)} old`
      : [hoursText().replace(/^Open until/, 'Until'), crowd].filter(Boolean).join(' · ');
  meta.classList.toggle('warn', flash ? flash.warn : offline || stale);
  // Screen readers hear it when it says something new, not each minute
  // that "2 min old" becomes "3 min old".
  const gist = meta.textContent.replace(/\d+/g, '#');
  if (lastMetaGist !== null && gist !== lastMetaGist) announce(meta.textContent);
  lastMetaGist = gist;

  const st = alertState();
  const [glyph, label] = {
    on: ['bell', 'Alerts on'],
    paused: ['pause', 'Paused'],
    closed: ['moon', 'Park closed'],
    setup: ['bell-off', 'Set up alerts'],
    none: ['bell-off', 'No ride alerts'],
  }[st.kind];
  const pill = $('#btn-alerts');
  pill.className = `pill glass pressable ${st.kind}`;
  morph(pill, `${icon(glyph)}<span>${label}</span>`);
  pill.setAttribute('aria-label', st.kind === 'paused' && st.until ? `Alerts paused until ${fmtUntil(st.until)}` : label);

  const down = dash.rides.filter((r) => r.status === 'DOWN' && isFollowing(r.id)).length;
  const badge = $('#down-badge');
  badge.textContent = down;
  badge.classList.toggle('hidden', !down);
  $('#tab-down').setAttribute('aria-label', down ? `Down now, ${down} of your rides down` : 'Down now');
  // The same count on the Home Screen icon, where the platform allows it.
  if (down !== lastBadge) {
    lastBadge = down;
    (down ? navigator.setAppBadge?.(down) : navigator.clearAppBadge?.())?.catch?.(() => {});
  }
}

/* ---------- Down now ---------- */
// Attractions that never post a wait (a castle, a gallery, a play area) are
// listed apart and never alert, so they never count as followed or down.
const otherSets = new WeakMap();
function isOther(rideId) {
  let set = otherSets.get(dash.rides);
  if (!set) otherSets.set(dash.rides, (set = new Set(dash.rides.filter((r) => r.other).map((r) => r.id))));
  return set.has(rideId);
}

function isFollowing(rideId) {
  const t = dash.trip;
  return !isOther(rideId) && (t.watched === null || t.watched.includes(rideId)) && !t.rideMutes?.[rideId];
}

// "8:05 to 8:27 AM", "11:50 AM to 12:10 PM", or "around 8:05 AM".
function fmtSpan(a, b) {
  const A = fmtTime(a), B = b == null ? A : fmtTime(b);
  if (A === B) return `around ${A}`;
  const [ta, pa] = A.split(/\s(?=[AP]M$)/);
  const [, pb] = B.split(/\s(?=[AP]M$)/);
  return `${pa && pa === pb ? ta : A} to ${B}`;
}

// The hour on the park's clock now.
const parkHour = (t = Date.now()) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: dash?.park.timezone || undefined }).format(new Date(t)));

// The hour with the shortest usual wait from now until today's close, or
// null once the park is closed or none is left.
function bestLeftToday(typical) {
  if (parkClosed()) return null;
  const from = parkHour();
  const close = dash.park.closingTime ? Date.parse(dash.park.closingTime) : null;
  const to = close && close > Date.now() ? parkHour(close - 1) : 23;
  let best = null;
  for (let h = from; h <= to && h < 24; h++) {
    if (typical[h] != null && (!best || typical[h] < best.wait)) best = { hour: h, wait: typical[h] };
  }
  return best;
}

// "7 PM": an hour on the park's clock.
function fmtHour(h) {
  return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2000, 0, 1, h)).replace(/\s(?=[AP]M\b)/, '\u00a0');
}

/* ---------- What the app says about a down ride ---------- */
// One way to say everything, on the list, the ride page and the lock screen.
// The ride data only says a ride is down, never why, so nothing here says it
// broke; weather is the app's inference from public weather reports, so it
// is always "likely".
const listName = (r) => r.short || r.name;
const stormGoingOn = (o) => !!o?.cause && o.weather !== 'passed';
const causeWord = (o) => (o?.cause === 'rain' ? 'rain' : 'lightning');
// A duration that never breaks across lines: "1 hr 40 min".
const keepTogether = (s) => esc(s).replace(/ /g, '\u00a0');

// "11:10", or "11:10 PM" when that is the other half of the day from now;
// a phone on a 24-hour clock gets "23:10" either way.
function pillTime(ts) {
  const full = fmtTime(ts);
  const m = full.match(/^(.*)\u00a0([AP]M)$/);
  if (!m) return full;
  return m[2] === fmtTime(Date.now()).match(/([AP]M)$/)?.[1] ? m[1] : full;
}

// When a down ride is likely back:
//   time   back at about `at` (the middle of the usual range), range [lo, hi]
//   later  weather cleared: likely back `at` or later (the rule's floor)
//   storm  still storming: no time until it clears, since any would be a guess
//   hour   more than an hour away, or longer than nearly every outage like it
//   closed often closed for the rest of the day
//   none   too little history to say
// A time never moves earlier than one already shown for the same outage:
// "11:08" after "11:10" reads as a mistake.
const shownBack = new Map(); // "rideId|downSince" -> ms last shown
function backAt(r, o = r.outlook) {
  if (!o) return { kind: 'none' };
  if (stormGoingOn(o)) return { kind: 'storm' };
  const a = o.advice?.key;
  if (a === 'closed') return { kind: 'closed' };
  if (a === 'closing') return { kind: 'closing' };
  const w = o.window;
  if (a === 'long' || a === 'go' || (w?.lo != null && w.lo >= 60)) return { kind: 'hour' };
  if (w?.lo == null) return { kind: 'none' };
  const now = Date.now();
  const mid = o.cause || w.hi == null ? w.lo : (w.lo + w.hi) / 2;
  const key = `${r.id}|${r.downSince}`;
  const at = Math.max(now + mid * 60_000, shownBack.get(key) ?? 0);
  shownBack.set(key, at);
  if (shownBack.size > 200) shownBack.delete(shownBack.keys().next().value);
  return { kind: o.cause ? 'later' : 'time', at, range: !o.cause && w.hi != null ? [now + w.lo * 60_000, now + w.hi * 60_000] : null };
}

// The right-hand end of a row: "Likely back" (said once, above the list, and
// again on each row at large text sizes, where the time sits under the name)
// and one time, or a few plain words.
const backEnd = (b) => `<span class="back-end"><span class="back-label">Likely back</span>${backCell(b)}</span>`;
function backCell(b) {
  if (b.kind === 'time') return `<span class="tile">${esc(pillTime(b.at))}</span>`;
  if (b.kind === 'later') return `<span class="when2"><span class="tile">${esc(pillTime(b.at))}</span><small>or later</small></span>`;
  const words = { storm: 'After storm', hour: 'Over an hour', closed: 'Maybe not today', closing: 'Maybe not before close', none: 'No estimate yet' }[b.kind];
  return `<span class="notsoon">${words}</span>`;
}
// The same, as a screen reader hears it.
const backWords = (b) => ({
  time: () => `back at about ${fmtTime(b.at)}`,
  later: () => `likely back ${fmtTime(b.at)} or later`,
  storm: () => 'back after the storm passes',
  hour: () => 'back in over an hour',
  closed: () => 'often closed for the rest of the day',
  closing: () => 'may not reopen before the park closes',
  none: () => 'no estimate yet',
}[b.kind])();

// How long a ride has been down, as far as anyone knows: exact, or at
// least this long when it went down unseen (in a gap in the feed, or before
// ParkAlert first looked), or nothing claimed under a minute of that.
function downFor(r) {
  const ms = Date.now() - r.downSince;
  if (r.downExact !== false) return fmtDuration(ms);
  return ms >= 60_000 ? `${fmtDuration(ms)}+` : '';
}

// The rides in a hold: this trip's first, then A to Z.
const holdOrder = (a, b) => (isFollowing(b.id) - isFollowing(a.id)) || sortKey(a.name).localeCompare(sortKey(b.name));

// A red dot for a ride that is down, an orange bolt for one closed by the
// weather, gray for rides you don't follow: shape as well as colour.
const statusMark = (r, theirs) => (r.outlook?.cause
  ? `<svg class="bolt-mark${theirs ? ' theirs' : ''}"><use href="#i-bolt"/></svg>`
  : `<span class="status-dot${theirs ? ' theirs' : ''}"></span>`);

// One down ride, one line: its name, where and how long, and when it's back.
function boardRow(r, { theirs = false } = {}) {
  const o = r.outlook;
  const b = backAt(r);
  const since = downFor(r);
  const what = o?.cause ? `Stopped, likely ${causeWord(o)}`
    : o?.kind === 'opening' ? 'Late to open'
      : since ? `down ${since}` : 'down';
  const said = [r.name, o?.cause ? `stopped, likely for ${causeWord(o)}` : o?.kind === 'opening' ? 'late to open' : since ? `down ${since}` : 'down', backWords(b)].join(', ');
  return `<button class="slim pressable${theirs ? ' theirs' : ''}" type="button" data-ride="${esc(r.id)}" data-key="r-${esc(r.id)}" aria-label="${esc(said)}">
    <span class="mk">${statusMark(r, theirs)}</span>
    <span class="rl"><span class="nm">${esc(listName(r))}</span><small>${r.land ? `${esc(r.land)} · ` : ''}${keepTogether(what)}</small></span>
    ${backEnd(b)}${theirs ? '' : icon('chevron', 'chevron')}
  </button>`;
}

// Your rides caught in a hold: one line that opens the hold. With one of
// yours in it, that ride leads ("Big Thunder Mountain, closed, likely
// lightning"); with several, the count does, so it matches the headline
// ("16 rides closed, likely lightning, includes Big Thunder Mountain and 15
// more of yours").
function holdRow(held, mine) {
  // The ride most people would name first: the one with the longest usual wait.
  const first = [...mine].sort((a, b) => (b.usual ?? 0) - (a.usual ?? 0))[0];
  const o = first.outlook;
  const b = backAt(first);
  const what = o?.cause ? `stopped, likely ${causeWord(o)}` : 'down together';
  const others = held.length - 1;
  const name = mine.length > 1 ? `${held.length} rides ${what}` : listName(first);
  const sub = mine.length > 1
    ? `Includes ${listName(first)} and ${mine.length - 1} more of yours`
    : `${o?.cause ? `Stopped, likely ${causeWord(o)}` : 'Down'}${others ? `, with ${others} other ride${others === 1 ? '' : 's'}` : ''}`;
  const said = `${name}, ${sub}, ${backWords(b)}. Show all ${held.length}`;
  return `<button class="slim pressable" type="button" data-act="open-hold" data-key="hold" aria-label="${esc(said)}">
    <span class="mk">${statusMark(first, false)}</span>
    <span class="rl"><span class="nm">${esc(name)}</span><small>${esc(sub)}</small></span>
    ${backEnd(b)}${icon('chevron', 'chevron')}
  </button>`;
}

let othersOpen = false; // "14 other rides are down", opened in place
let mineOpen = false; // more than four of yours, opened in place

const setupRowHtml = () => `
  <div class="group" style="margin-top:1.2rem" data-key="setup-row"><button class="row pressable" type="button" data-act="setup-alerts">
    ${icon('bell', 'row-icon tint-accent')}
    <span class="row-label">Set up alerts on this phone</span>
    ${icon('chevron', 'chevron')}
  </button></div>`;

// Down now changes under a reader: a ride breaks, a hold forms. Someone who
// has scrolled keeps their place (what they were reading stays put, and the
// new card arrives above, out of the way); at the top of the list a new card
// grows in, instead of shoving everything below it down at once.
function renderDown() {
  const list = $('#down-list');
  const anchor = view === 'down' && scrollY > 8 && !pages.top ? readingAnchor() : null;
  const loading = !!list.querySelector('[data-key=skeleton]');
  const before = new Set(list.querySelectorAll('.slim[data-key]'));
  morph(list, downHtml());
  renderRecent(new Set(dash.rides.filter((r) => r.status === 'DOWN' && r.downSince).map((r) => r.id)));
  if (anchor) {
    const shift = anchor.el.isConnected ? anchor.el.getBoundingClientRect().top - anchor.top : 0;
    if (Math.abs(shift) > 1) scrollBy(0, shift);
  } else if (!loading && before.size && !reducedMotion()) {
    // A ride newly down grows into the board rather than shoving it.
    for (const el of list.querySelectorAll('.slim[data-key]')) if (!before.has(el)) grow(el);
  }
}

// What the reader is looking at: the first card or row whose bottom is below
// the header, and where it sits now.
function readingAnchor() {
  const top = document.body.classList.contains('compact') ? $('#nav-bar').getBoundingClientRect().bottom : 0;
  for (const el of document.querySelectorAll('#view-down .slim, #view-down .barrow, #view-down .section-label, #view-down .group')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top && r.height) return { el, top: r.top };
  }
  return null;
}

function grow(el) {
  const h = el.offsetHeight;
  el.animate([{ height: '0px', opacity: 0, overflow: 'hidden' }, { height: `${h}px`, opacity: 1, overflow: 'hidden' }], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
}

function downHtml() {
  const down = dash.rides.filter((r) => r.status === 'DOWN' && r.downSince && !r.other);
  if (!dash.lastPoll) {
    // No ride data yet is not the same as nothing being down.
    return stateCard("The park's ride feed isn't answering right now. This updates on its own.");
  }
  const held = down.filter((r) => r.outlook?.kind === 'hold').sort(holdOrder);
  const heldMine = held.filter((r) => isFollowing(r.id));
  const solo = down.filter((r) => r.outlook?.kind !== 'hold' && isFollowing(r.id)).sort((a, b) => b.downSince - a.downSince);
  const rows = solo.map((r) => boardRow(r));
  if (heldMine.length) rows.splice(0, 0, holdRow(held, heldMine));
  // The board never grows past four rows of yours: the rest open in place,
  // so the shortest lines below stay in reach on a storm day.
  let mine = rows;
  if (rows.length > 4 && !mineOpen) {
    mine = [...rows.slice(0, 3), `<button class="slim quiet pressable" type="button" data-act="more-mine" data-key="more-mine" aria-expanded="false">
      <span class="rl">${rows.length - 3} more of yours are down</span>${icon('chevron', 'chevron')}</button>`];
  }
  const others = down.filter((r) => !isFollowing(r.id));
  const parts = [];
  if (mine.length) parts.push(`<div class="boardhead" aria-hidden="true" data-key="head"><span>Your rides</span><span>Likely back</span></div>`, ...mine);
  if (others.length) {
    parts.push(`<button class="slim quiet pressable" type="button" data-act="toggle-others" data-key="others" aria-expanded="${othersOpen}">
      <span class="rl">${others.length} ${mine.length ? 'other ' : ''}ride${others.length === 1 ? ' is' : 's are'} down</span>${icon('chevron', `chevron turn${othersOpen ? ' open' : ''}`)}</button>`);
    if (othersOpen) {
      // The rides you don't follow in a hold are one line that opens the
      // hold; the rest are rows of their own, smaller and gray.
      const heldTheirs = held.filter((r) => !isFollowing(r.id));
      if (heldTheirs.length) {
        const o = heldTheirs[0].outlook;
        const names = heldTheirs.slice(0, 3).map(listName).join(', ');
        parts.push(`<button class="slim theirs pressable" type="button" data-act="open-hold" data-key="held-theirs">
          <span class="mk">${statusMark(heldTheirs[0], true)}</span>
          <span class="rl"><span class="nm">${heldTheirs.length} ${heldMine.length ? 'more ' : ''}${o?.cause ? `stopped, likely ${causeWord(o)}` : 'down together'}</span><small>${esc(names)}${heldTheirs.length > 3 ? ` and ${heldTheirs.length - 3} more` : ''}</small></span>
          ${backCell(backAt(heldTheirs[0]))}</button>`);
      }
      for (const r of others.filter((x) => x.outlook?.kind !== 'hold').sort((a, b) => b.downSince - a.downSince)) parts.push(boardRow(r, { theirs: true }));
    }
  }
  const out = [];
  if (parts.length) {
    out.push(`<div class="group lift board" data-key="board">${parts.join('')}</div>`);
    out.push(`<button class="more-below" type="button" data-act="more-below" data-key="more-below" aria-hidden="true" tabindex="-1">More below ${icon('chevron')}</button>`);
  } else {
    // Nothing down. Only a live, open park gets the shortest lines as its
    // card; closed, not open yet, and old data each say what they are.
    const open = Date.parse(dash.park.openingTime || '');
    const stale = offline || Date.now() - dash.lastPoll > STALE_MS;
    const c = dash.park.counts || rideCountsOf(dash.rides);
    const text = dash.park.status === 'closedEarly' ? `Only ${c.operating} of ${c.total} rides are running, so the park seems to have closed early. Alerts are off until rides reopen.`
      : alertState().kind === 'closed' ? 'Closed for the day. Alerts start again when it opens.'
        : open && Date.now() < open ? `Opens at ${fmtTime(open)}. If a ride you follow is late to open, you'll hear about it.`
          : stale ? staleText()
            : null;
    const short = text ? '' : shortestHtml({ lifted: true });
    out.push(text ? stateCard(text) : short || stateCard(`You'll hear the moment one of your ${dash.rides.filter((r) => isFollowing(r.id)).length} rides goes down.`));
  }
  if (!alertsReady()) out.push(setupRowHtml());
  return out.join('');
}

// Something to say instead of a list, in the card that sits on the sky.
const stateCard = (text) => `<div class="group lift padded" data-key="state"><p class="state-text">${esc(text)}</p></div>`;

// Rides now, leaving out any missing from the feed (as server/parkstatus.js counts).
function rideCountsOf(rides) {
  const c = { operating: 0, down: 0, closed: 0, total: 0 };
  for (const r of rides) {
    if (r.missed) continue;
    c.total++;
    if (r.status === 'OPERATING') c.operating++;
    else if (r.status === 'DOWN') c.down++;
    else c.closed++;
  }
  return c;
}

// Why the data is old, when it is: our connection, or the park's ride feed.
function staleText() {
  if (offline && failure === 'offline') return 'This catches up as soon as your phone is back online.';
  if (offline) return 'This catches up as soon as ParkAlert can be reached again.';
  return "The park's ride feed isn't answering, so alerts are paused until it's back.";
}

// Under the board: lines getting longer, the shortest lines right now, and
// rides that came back or closed recently (so an alert opened late still
// makes sense). Each ride's latest word only.
const RECENT_SINGLE_MS = 30 * 60_000;
const openReturns = new Set(); // incidents whose returns are shown ride by ride

function renderRecent(downIds) {
  const status = new Map(dash.rides.map((r) => [r.id, r.status]));
  const seen = new Set();
  const latest = (dash.recent || []).filter((e) => {
    if ((e.type !== 'UP' && e.type !== 'CLOSED') || downIds.has(e.id) || seen.has(e.id) || isOther(e.id)) return false;
    seen.add(e.id);
    return e.type === 'UP' || status.get(e.id) === 'CLOSED';
  });
  const ups = latest.filter((e) => e.type === 'UP');
  const closed = latest.filter((e) => e.type === 'CLOSED');
  // A hold's returns are one row that opens with a tap: after a storm that
  // was twenty rows for two hours. A single return stays half an hour.
  const byIncident = new Map();
  for (const e of ups) if (e.incident) byIncident.set(e.incident, [...(byIncident.get(e.incident) || []), e]);
  const groups = [...byIncident].filter(([, es]) => es.length >= 3);
  const grouped = new Set(groups.flatMap(([, es]) => es));
  const entries = [
    ...groups.map(([id, es]) => ({ at: Math.max(...es.map((e) => e.at)), id, es })),
    ...ups.filter((e) => !grouped.has(e) && Date.now() - e.at < RECENT_SINGLE_MS).map((e) => ({ at: e.at, e })),
  ].sort((a, b) => b.at - a.at);
  const nameOf = (id, fallback) => { const r = liveRide(id); return r ? listName(r) : fallback; };
  const upRow = (e, cls = '') => `
      <button class="slim pressable ${cls}" type="button" data-ride="${esc(e.id)}" data-key="up-${esc(e.id)}">
        <span class="mk">${icon('arrow-up', 'up-mark')}</span>
        <span class="rl"><span class="nm">${esc(nameOf(e.id, e.name))}</span><small>${e.late
          ? `Opened at ${fmtTime(e.at)}`
          : `Open again at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${keepTogether(fmtDuration(e.downtimeMs))}` : ''}`}</small></span>
        ${icon('chevron', 'chevron')}
      </button>`;
  const groupRows = ({ id, es }) => {
    const open = openReturns.has(id);
    const times = es.map((e) => e.at);
    return `
      <button class="slim pressable" type="button" data-act="toggle-returns" data-inc="${esc(id)}" data-key="inc-${esc(id)}" aria-expanded="${open}">
        <span class="mk">${icon('arrow-up', 'up-mark')}</span>
        <span class="rl"><span class="nm">${es.length} rides open again</span><small>${fmtSpan(Math.min(...times), Math.max(...times))}</small></span>
        ${icon('chevron', `chevron turn${open ? ' open' : ''}`)}
      </button>${open ? es.map((e) => upRow(e, 'theirs')).join('') : ''}`;
  };
  const parts = [];
  const building = dash.crowd?.building;
  if (building && alertState().kind !== 'closed') {
    parts.push(`<div class="group spaced-sm" data-key="building"><button class="slim pressable" type="button" data-act="open-park">
      <span class="mk">${icon('trend-up', 'trend-mark')}</span>
      <span class="rl"><span class="nm">Lines are getting longer</span><small>Big rides average ${building.to}\u00a0min, up from ${building.from} half an hour ago</small></span>
      ${icon('chevron', 'chevron')}</button></div>`);
  }
  // The shortest lines sit here unless the board had nothing to show and
  // they are its card already.
  const downCount = dash.rides.filter((r) => r.status === 'DOWN' && r.downSince && !r.other).length;
  if (downCount) parts.push(shortestHtml());
  if (entries.length) {
    parts.push(`<h2 class="section-label" data-key="up-label">Open again</h2>
      <div class="group" data-key="up">${entries.map((x) => (x.es ? groupRows(x) : upRow(x.e))).join('')}</div>`);
  }
  if (closed.length) {
    parts.push(`<h2 class="section-label" data-key="closed-label">Closed after being down</h2>
      <div class="group" data-key="closed">${closed.map((e) => `
      <button class="slim pressable" type="button" data-ride="${esc(e.id)}" data-key="cl-${esc(e.id)}">
        <span class="mk">${icon('moon', 'moon-mark')}</span>
        <span class="rl"><span class="nm">${esc(nameOf(e.id, e.name))}</span><small>Closed at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${keepTogether(fmtDuration(e.downtimeMs))} down` : ''}</small></span>
        ${icon('chevron', 'chevron')}
      </button>`).join('')}</div>`);
  }
  morph($('#recent-block'), parts.join(''));
}

// A running ride's posted wait against its usual for this hour, as a bar on
// one scale for every ride, with the usual as a tick. Green only when it is
// at least five minutes shorter than usual. A wait past the scale fills it.
const WAIT_SCALE = 90;
const isGood = (r) => r.waitTime != null && r.usual != null && r.waitTime <= r.usual - 5;
function waitBar(r) {
  if (r.status !== 'OPERATING' || r.waitTime == null) return '';
  const pct = (m) => Math.min(100, (m / WAIT_SCALE) * 100).toFixed(1);
  return `<div class="wbar${isGood(r) ? ' good' : ''}" aria-hidden="true"><i style="width:${pct(r.waitTime)}%"></i>${r.usual != null ? `<b style="left:${pct(r.usual)}%"></b>` : ''}</div>`;
}
function waitRow(r, { sub = null, following = false } = {}) {
  const usual = r.usual != null ? `usually ${r.usual}\u00a0min` : null;
  const small = sub ?? [r.land, usual].filter(Boolean).join(' · ');
  const said = [`${r.name}, ${r.waitTime} minute wait`, small.replace(/\u00a0/g, ' ').replace(/ · /g, ', '), following ? 'alerts on' : ''].filter(Boolean).join(', ');
  return `<button class="barrow pressable" type="button" data-ride="${esc(r.id)}" data-key="w-${esc(r.id)}" aria-label="${esc(said)}">
    <span class="top2"><span class="rl">${esc(listName(r))}${following ? icon('bell', 'bell-mark') : ''}${small ? `<small>${esc(small)}</small>` : ''}</span>
    <span class="wait-num${isGood(r) ? ' good' : ''}">${r.waitTime}<small>min</small></span></span>
    ${waitBar(r)}</button>`;
}

// The shortest lines right now: running rides whose wait is well under their
// usual for this hour, best deal first (as the lines alert picks them). A
// carousel's 5 minutes isn't news; a headliner at half its usual is. Only
// while the park is open and the data is fresh.
function shortestHtml({ lifted = false } = {}) {
  const st = alertState();
  const stale = offline || !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS;
  if (st.kind === 'closed' || stale) return '';
  const quick = dash.rides
    .filter((r) => !r.other && r.status === 'OPERATING' && r.waitTime != null && r.usual >= 15 && r.waitTime <= r.usual * 0.8)
    .sort((a, b) => a.waitTime / a.usual - b.waitTime / b.usual || b.usual - a.usual)
    .slice(0, 3);
  if (!quick.length) return '';
  const rows = quick.map((r) => waitRow(r)).join('');
  return lifted
    ? `<div class="group lift" data-key="short"><h2 class="section-label in-card" data-key="short-label">Shortest lines right now</h2>${rows}</div>`
    : `<h2 class="section-label" data-key="short-label">Shortest lines right now</h2><div class="group" data-key="short">${rows}</div>`;
}

/* ---------- Rides ---------- */
// The other lines a guest weighs: single rider, and Lightning Lane with its
// next return time. Words, not symbols, and only where the data has them.
function queueTags(r) {
  if (r.status !== 'OPERATING') return [];
  const tags = [];
  if (r.singleRider) tags.push('Single rider');
  const ll = r.lightningLane;
  if (ll) {
    const name = ll.paid ? 'Single Pass' : 'Lightning Lane';
    if (ll.state === 'AVAILABLE' && ll.returnStart) tags.push(`${name} ${fmtTime(Date.parse(ll.returnStart))}`);
    else if (ll.state === 'TEMP_FULL' || ll.state === 'FINISHED') tags.push(`${name} full`);
  }
  return tags;
}

// How the Rides list is shown: by land, A to Z, shortest wait first, coasters
// only, or the rides you get alerts about. Remembered per phone.
const RIDE_VIEWS = ['land', 'name', 'wait', 'coasters', 'following'];
let rideView = (() => { try { const v = localStorage.getItem('parkalert.rideView'); return RIDE_VIEWS.includes(v) ? v : 'land'; } catch { return 'land'; } })();
// A ride switched off under "My alerts" stays listed until the view, the
// search or the tab changes, so a mis-tap can be undone where it happened.
const keepListed = new Set();
const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name));
// Shortest first: rides posting a wait by their wait, then ones that post
// none (shows, a train), then rides that are down, then closed ones.
function byWait(a, b) {
  const rank = (r) => (r.status === 'OPERATING' ? (r.waitTime != null ? 0 : 1) : r.status === 'DOWN' ? 2 : 3);
  return rank(a) - rank(b) || (a.waitTime ?? 0) - (b.waitTime ?? 0) || byName(a, b);
}
const VIEW_EMPTY = {
  coasters: 'No coasters listed at this park.',
  following: "You aren't getting alerts about any ride. Tap Choose to pick some.",
};
function setRideView(v) {
  rideView = RIDE_VIEWS.includes(v) ? v : 'land';
  keepListed.clear();
  try { localStorage.setItem('parkalert.rideView', rideView); } catch {}
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === rideView)));
  if (dash) renderRides();
}
document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => { haptic(); setRideView(b.dataset.filter); }; });
setRideView(rideView);

// A ride that isn't running says what it is instead of drawing a bar.
function statusRow(r, following) {
  const [word, cls] = r.status === 'DOWN'
    ? (r.outlook?.cause ? ['Stopped', 'weather'] : ['Down', 'down'])
    : r.status === 'OPERATING' ? ['No posted wait', '']
      : r.status === 'REFURBISHMENT' ? ['Refurbishing', ''] : ['Closed', ''];
  const sub = [rideView === 'land' ? null : r.land, r.status === 'DOWN' && r.outlook?.cause ? `likely ${causeWord(r.outlook)}` : null].filter(Boolean).join(' · ');
  return `<button class="barrow pressable" type="button" data-ride="${esc(r.id)}" data-key="w-${esc(r.id)}" aria-label="${esc(`${r.name}, ${word.toLowerCase()}${sub ? `, ${sub}` : ''}${following ? ', alerts on' : ''}`)}">
    <span class="top2"><span class="rl">${esc(listName(r))}${following ? icon('bell', 'bell-mark') : ''}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
    <span class="wait-word ${cls}">${word}</span></span></button>`;
}

// A bell beside a followed ride, only when some rides aren't followed:
// with every ride on, a bell on every row says nothing.
const bellFor = (r) => isFollowing(r.id) && dash.rides.some((x) => !x.other && !isFollowing(x.id));
function rideRow(r) {
  const following = bellFor(r);
  if (r.status !== 'OPERATING' || r.waitTime == null) return statusRow(r, following);
  const alert = dash.trip.waitAlerts?.[r.id];
  const extras = [
    rideView === 'land' ? null : r.land,
    r.usual != null ? `usually ${r.usual}\u00a0min` : null,
    ...queueTags(r),
    alert && !alert.sentAt ? `wait alert at ${alert.max}\u00a0min` : null,
  ].filter(Boolean).join(' · ');
  return waitRow(r, { sub: extras, following });
}

function renderRides() {
  const q = $('#ride-search').value.trim();
  const all = dash.rides.filter((r) => !r.other);
  const following = all.filter((r) => isFollowing(r.id)).length;
  $('#follow-summary').textContent = following === all.length ? `Alerts on for all ${all.length} rides` : `Alerts on for ${following} of ${all.length} rides`;
  $('#btn-choose').classList.remove('hidden');

  const keep = {
    coasters: (r) => r.coaster,
    following: (r) => isFollowing(r.id) || keepListed.has(r.id),
  }[rideView] || (() => true);
  const shown = all.filter((r) => keep(r) && (!q || matchesSearch(r.name, q) || (r.short && matchesSearch(r.short, q))));
  shown.sort(rideView === 'wait' ? byWait : byName);

  const list = $('#rides-list');
  if (!shown.length) {
    morph(list, `<p class="no-results" data-key="none">${q ? `No rides match “${esc(q)}”.` : esc(VIEW_EMPTY[rideView] || 'No rides.')}</p>`);
  } else if (rideView === 'land') {
    // Grouped by land, in the order a park map reads, rides with no known
    // land last.
    const lands = new Map();
    for (const r of shown) {
      const land = r.land || 'Other rides';
      if (!lands.has(land)) lands.set(land, []);
      lands.get(land).push(r);
    }
    const order = [...lands.keys()].sort((a, b) => (a === 'Other rides') - (b === 'Other rides') || sortKey(a).localeCompare(sortKey(b)));
    morph(list, order.map((land) => `<h2 class="section-label" data-key="l-${esc(land)}">${esc(land)}</h2>
      <div class="group" data-key="g-${esc(land)}">${lands.get(land).map(rideRow).join('')}</div>`).join(''));
  } else {
    morph(list, `<div class="group spaced-sm" data-key="all">${shown.map(rideRow).join('')}</div>`);
  }

  // Shows, exhibits and play areas never post a wait and never alert: listed
  // apart, under the full list only.
  const others = rideView === 'land' || rideView === 'name'
    ? dash.rides.filter((r) => r.other && (!q || matchesSearch(r.name, q))).sort(byName)
    : [];
  morph($('#other-block'), others.length ? `<h2 class="section-label" data-key="other-label">Shows and other attractions</h2>
    <div class="group" data-key="other">${others.map((r) => statusRow(r, false)).join('')}</div>
    <p class="footnote" data-key="other-foot">They never post a wait, so they don't send alerts.</p>` : '');
}

// Choose rides: every ride with a check, as picking photos. Faster than a
// switch per ride for a dozen at once, and it keeps the list itself calm.
function openChoose() {
  const draw = () => {
    const all = dash.rides.filter((r) => !r.other).sort(byName);
    const on = all.filter((r) => isFollowing(r.id)).length;
    return `<div data-sheet="choose">
      ${sheetHead('Choose rides', "You'll get an alert when these go down, and when they're open again.")}
      <div class="btn-row choose-all" style="display:flex;gap:0.5rem;padding:0 var(--gutter) 0.8rem">
        <button class="btn-secondary pressable" type="button" data-act="all"${on === all.length ? ' disabled' : ''}>Select all</button>
        <button class="btn-secondary pressable" type="button" data-act="none"${on === 0 ? ' disabled' : ''}>Clear all</button>
      </div>
      <div class="group">${all.map((r) => `
        <button class="pick" type="button" role="checkbox" aria-checked="${isFollowing(r.id)}" data-id="${esc(r.id)}">
          <span class="ring">${icon('check')}</span>
          <span class="row-label">${esc(r.name)}${r.land ? `<small>${esc(r.land)}</small>` : ''}</span>
        </button>`).join('')}</div>
      <div class="btn-stack"><button class="btn-primary pressable" type="button" data-act="done">Done</button></div>
    </div>`;
  };
  const content = el(draw());
  content.addEventListener('click', (e) => {
    const pick = e.target.closest('.pick');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (pick) {
      toggleFollow(pick.dataset.id);
      pick.setAttribute('aria-checked', String(isFollowing(pick.dataset.id)));
    } else if (act === 'all') followAll();
    else if (act === 'none') unfollowAll();
    else if (act === 'done') return sheet.close();
    else return;
    // The counts on the buttons follow each change.
    const all = dash.rides.filter((r) => !r.other);
    const on = all.filter((r) => isFollowing(r.id)).length;
    content.querySelector('[data-act=all]').disabled = on === all.length;
    content.querySelector('[data-act=none]').disabled = on === 0;
    for (const p of content.querySelectorAll('.pick')) p.setAttribute('aria-checked', String(isFollowing(p.dataset.id)));
  });
  sheet.open(content);
}
$('#btn-choose').onclick = () => { if (dash) openChoose(); };

// One control per ride. The old star (watch) and bell (mute) did the same job
// two different ways; following now clears any leftover per-ride mute too.
function toggleFollow(rideId) {
  haptic();
  if (rideView === 'following') keepListed.add(rideId);
  const all = dash.rides.map((r) => r.id);
  const on = isFollowing(rideId);
  let watched = dash.trip.watched === null ? all : [...dash.trip.watched];
  watched = on ? watched.filter((id) => id !== rideId) : [...new Set([...watched, rideId])];
  if (watched.length === all.length) watched = null;
  const rideMutes = { ...dash.trip.rideMutes };
  delete rideMutes[rideId];
  save((t) => { t.watched = watched; t.rideMutes = rideMutes; }, { watched, rideMutes });
}

function followAll() {
  save((t) => { t.watched = null; t.rideMutes = {}; }, { watched: null, rideMutes: {} }, (before) => {
    toast(`Alerts on for all ${dash.rides.filter((r) => !r.other).length} rides`, {
      label: 'Undo',
      run: () => save((t) => { t.watched = before.watched; t.rideMutes = before.rideMutes; }, { watched: before.watched, rideMutes: before.rideMutes || {} }),
    });
  });
}

function unfollowAll() {
  save((t) => { t.watched = []; }, { watched: [] }, (before) => {
    toast('Alerts off for every ride', {
      label: 'Undo',
      run: () => save((t) => { t.watched = before.watched; }, { watched: before.watched }),
    });
  });
}

/* ---------- Trip ---------- */
function renderTrip() {
  $('#trip-code').textContent = tripCode;
  const ready = alertsReady();
  const d = $('#setup-detail');
  d.textContent = phone.id ? (phoneMuted() ? 'Paused' : 'On') : ready ? 'On' : 'Not set up';
  d.className = `row-detail ${ready ? 'ok' : 'warn'}`;
  const st = alertState();
  // Nothing when not paused, as Settings shows no value for an unset row;
  // "Off" read as "alerts are off".
  const until = st.until ? `until ${fmtUntil(st.until)}` : 'until you resume';
  $('#pause-detail').textContent = st.kind !== 'paused' ? ''
    : st.scope === 'phone' ? `This phone, ${until}` : `Everyone, ${until}`;
  $('#park-detail').textContent = parkLabel(dash.park.name);
  $('#switch-crowd').setAttribute('aria-checked', String(!!dash.trip.crowdAlerts));
  // The ntfy switch matters only once some phone uses the app's own
  // notifications; before that, ntfy is how the trip gets alerts at all.
  $('#row-ntfy').classList.toggle('hidden', !dash.trip.phones);
  $('#switch-ntfy').setAttribute('aria-checked', String(dash.trip.ntfy !== false));
}

// Before the first dashboard arrives there is nothing to show but where that
// stands: loading, or unreachable with a way to try again.
function renderNoData() {
  $('#park-name').textContent = 'ParkAlert';
  $('#status-title').textContent = offline ? "Can't load ride times" : 'Loading…';
  syncSky();
  const meta = $('#park-meta');
  meta.textContent = offline ? (failure === 'offline' ? 'Offline. Waiting for a connection…' : `${FAILURE_META[failure]}…`) : 'Loading…';
  meta.classList.toggle('warn', offline);
  $('#btn-alerts').classList.add('hidden');
  $('#down-badge').classList.add('hidden');
  $('#trip-code').textContent = tripCode;
  for (const id of ['#setup-detail', '#pause-detail', '#park-detail', '#follow-summary']) $(id).textContent = '';
  $('#btn-choose').classList.add('hidden');
  morph($('#recent-block'), '');

  morph($('#down-list'), offline
    ? `<div class="group lift padded" data-key="state">
        <p class="state-text">${failure === 'offline' ? 'Rides show up here as soon as your phone reconnects.' : "Your connection is fine; ParkAlert isn't answering. This tries again on its own."}</p>
        <button class="btn-secondary pressable" type="button" data-act="retry-dash" style="margin-top:0.8rem">Try again</button>
      </div>`
    : skeleton('cards'));
  morph($('#rides-list'), offline
    ? `<p class="no-results" data-key="none">${failure === 'offline' ? 'Rides show up once your phone reconnects.' : 'Rides show up once ParkAlert answers.'}</p>`
    : skeleton('rows'));
}

// Actions inside the main views, delegated so patched content keeps working.
$('#app').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'setup-alerts') openAlertSetup();
  else if (act === 'open-hold') openHold();
  else if (act === 'open-park') openParkInfo();
  else if (act === 'retry-dash') { offline = false; renderAll(); refresh(); }
  else if (act === 'toggle-others') { othersOpen = !othersOpen; haptic(); renderDown(); }
  else if (act === 'more-mine') { mineOpen = true; renderDown(); }
  else if (act === 'more-below') scrollBy({ top: innerHeight * 0.6, behavior: reducedMotion() ? 'auto' : 'smooth' });
  else if (act === 'toggle-returns') {
    const id = e.target.closest('[data-inc]').dataset.inc;
    if (!openReturns.delete(id)) openReturns.add(id);
    renderDown();
  }
});

let myTagFor = null;
function renderAll() {
  if (!dash) return renderNoData();
  // Which wait alerts are this phone's own, worked out once per trip and phone.
  if (myTagFor !== `${tripCode}:${phone.id}`) {
    myTagFor = `${tripCode}:${phone.id}`;
    syncMyTag().then(() => pages.refresh(), () => {});
  }
  renderHeader();
  renderDown();
  renderRides();
  renderTrip();
  // Open pages follow too, so a ride's switch moves back with the list if a
  // save fails, and elapsed times stay current.
  pages.refresh();
}

/* ---------- Sheets ---------- */
// The sheet opens at once, then redraws from a fresh dashboard, so a pause
// or resume made on another phone meanwhile shows in its choices.
function openPause({ fresh = false } = {}) {
  if (!fresh) {
    refresh().then(() => {
      if (sheet.isOpen && $('#sheet-body').firstElementChild?.dataset.sheet === 'pause') openPause({ fresh: true });
    });
  }
  const st = alertState();
  // 7am on the park's clock: this morning if it's not 7 yet, else tomorrow.
  // The phone's own midnight would make a 12:30am pause last 30 hours.
  const tz = dash.park.timezone || undefined;
  const morning = nextLocalHour(Date.now(), tz, 7);
  const thisMorning = localDay(morning, tz) === localDay(Date.now(), tz);
  // Each option says when it ends, the same way, as Focus does.
  const close = dash.park.closingTime ? Date.parse(dash.park.closingTime) : null;
  const options = [
    ['For 1 hour', Date.now() + 3600_000],
    ['For 3 hours', Date.now() + 3 * 3600_000],
    ...(close && close > Date.now() + 15 * 60_000 && st.kind !== 'closed' ? [['Until the park closes', close]] : []),
    [thisMorning ? 'Until this morning' : 'Until tomorrow morning', morning, true],
    ['Until I turn them back on', null],
  ];
  const tripPaused = st.kind === 'paused' && st.scope === 'trip';
  // With the app's own notifications, this phone can be paused alone; a
  // shared ntfy topic can only be paused for everyone.
  const perPhone = !!phone.id;
  const note = st.kind === 'closed'
    ? 'The park is closed, so alerts are already off until it opens.'
    : 'The Down now list keeps updating while alerts are paused.';
  const content = el(`<div data-sheet="pause">${sheetHead('Pause alerts', note)}</div>`);
  const resumeRow = (label, run) => {
    const g = el(`<div class="group plain"><button class="row pressable" type="button">${icon('bell', 'row-icon tint-accent')}<span class="row-label">${label}</span></button></div>`);
    g.querySelector('button').onclick = () => { sheet.close(); run(); };
    return g;
  };
  if (tripPaused) {
    content.appendChild(resumeRow('Resume for everyone', () => setMute(null)));
    content.appendChild(el('<div style="height:1rem"></div>'));
  }
  if (perPhone && phoneMuted()) {
    content.appendChild(resumeRow('Resume on this phone', () => setPhoneMute(null)));
    content.appendChild(el('<div style="height:1rem"></div>'));
  }
  // Who, then one list of how long: a choice of scope over the list rather
  // than the same list twice.
  // "This phone" only pauses ParkAlert's own notifications. While the trip
  // still sends to ntfy, a phone subscribed there would keep getting alerts,
  // so the safe choice is the default and the catch is said out loud.
  const ntfyLive = dash.trip.ntfy !== false;
  let scope = perPhone && !ntfyLive ? 'phone' : 'trip';
  // Who goes quiet, said in full, since that is the choice that matters.
  const whoNote = el('<p class="note strong" style="padding-top:0"></p>');
  const sayWho = () => {
    whoNote.textContent = scope === 'phone'
      ? 'Only this phone goes quiet. The rest of the trip still gets alerts.'
      : ntfyLive && perPhone
        ? 'Nobody on the trip gets alerts, including the ntfy app. Pausing just this phone can\'t silence ntfy.'
        : 'Nobody on the trip gets alerts while paused.';
  };
  if (perPhone) {
    const who = el(`<div class="segmented pause-scope scope" role="radiogroup" aria-label="Who to pause">
      <button type="button" role="radio" data-scope="phone" aria-checked="${scope === 'phone'}">Just this phone</button>
      <button type="button" role="radio" data-scope="trip" aria-checked="${scope === 'trip'}">Everyone</button>
    </div>`);
    who.addEventListener('click', (e) => {
      const b = e.target.closest('[data-scope]');
      if (!b) return;
      scope = b.dataset.scope;
      for (const x of who.querySelectorAll('[data-scope]')) x.setAttribute('aria-checked', String(x === b));
      sayWho();
      haptic();
    });
    content.appendChild(who);
  }
  sayWho();
  content.appendChild(whoNote);
  const list = el('<div class="group plain spaced-sm"></div>');
  // The morning row already names the day; its detail is just the time.
  for (const [label, until, timeOnly] of options) {
    const detail = until && (timeOnly ? fmtTime(until) : `Until ${fmtUntil(until)}`);
    const row = el(`<button class="row pressable" type="button"><span class="row-label">${label}</span>${detail ? `<span class="row-detail">${esc(detail)}</span>` : ''}</button>`);
    row.onclick = () => {
      if (scope === 'phone') { sheet.close(); setPhoneMute({ until }); return; }
      // Everyone, from a phone that could have paused just itself: ask first,
      // naming how many phones, since the whole family goes quiet.
      if (perPhone && dash.trip.phones <= 1 && !ntfyLive) { sheet.close(); setMute({ until }); }
      else confirmPauseAll(until, label);
    };
    list.appendChild(row);
  }
  content.appendChild(list);
  const cancel = el('<div class="btn-stack"><button class="btn-secondary pressable" type="button">Cancel</button></div>');
  cancel.querySelector('button').onclick = () => sheet.close();
  content.appendChild(cancel);
  sheet.open(content);
}

// Pausing every phone on the trip: Cancel is the big, easy button.
function confirmPauseAll(until, label) {
  const n = dash.trip.phones;
  // Phones on the ntfy app aren't counted by the server, so a count is
  // only given when it is the whole story.
  const who = n > 1 && dash.trip.ntfy === false ? `all ${n} phones on this trip` : 'everyone on this trip';
  const how = until == null ? 'until someone turns them back on' : label.startsWith('For') ? `${label.toLowerCase()}, until ${fmtUntil(until)}` : `until ${fmtUntil(until)}`;
  const content = el(`<div data-sheet="pause-all" class="center-head" style="padding:0.4rem var(--gutter) 0">
    <h2>Pause alerts for ${esc(who)}?</h2>
    <p>Nobody on the trip will get alerts ${esc(how)}.</p>
    <div class="btn-stack" style="padding-left:0;padding-right:0">
      <button class="btn-primary pressable" type="button" data-act="cancel">Cancel</button>
      <button class="btn-ghost pressable" type="button" data-act="all">Pause for everyone</button>
    </div></div>`);
  content.querySelector('[data-act=cancel]').onclick = () => sheet.close();
  content.querySelector('[data-act=all]').onclick = () => { sheet.close(); setMute({ until }); };
  sheet.open(content);
}

function setMute(mute) {
  save((t) => { t.mute = mute; }, { mute }, (before) => {
    const text = !mute ? 'Alerts are back on'
      : mute.until === null ? 'Alerts paused until you turn them back on'
        : `Alerts paused until ${fmtUntil(mute.until)}`;
    toast(text, { label: 'Undo', run: () => save((t) => { t.mute = before.mute; }, { mute: before.mute }) });
  });
}

async function openPark() {
  try {
    await loadParks();
  } catch {
    toast("Can't load the park list. Check your connection.");
    return;
  }
  const content = el(`<div>${sheetHead('Park', 'Changes the park for everyone on this trip. Each park remembers which rides have alerts on.')}</div>`);
  content.appendChild(parkGroups(dash.park.id, (p) => {
    sheet.close();
    if (p.id !== dash.park.id) switchPark(p, dash.park);
  }));
  content.appendChild(el('<div style="height:0.5rem"></div>'));
  sheet.open(content);
}

// The new park shows at once, loading, instead of the old park's rides
// sitting there until the server answers. A failure (of the switch or its
// Undo) goes back to what the server has and says so.
async function switchPark(to, from, { undo = true } = {}) {
  const before = dash;
  dash = null;
  renderNoData();
  $('#park-name').textContent = parkLabel(to.name);
  $('#park-meta').textContent = 'Loading rides…';
  try {
    await patchTrip({ parkId: to.id });
    await refresh();
    if (undo) {
      toast(`Switched to ${parkLabel(to.name)}`, {
        label: 'Undo',
        run: () => switchPark(from, to, { undo: false }),
      });
    }
  } catch {
    dash = before;
    renderAll();
    refresh();
    toast(`Couldn't switch to ${parkLabel(to.name)}. Check your connection.`);
  }
}

function openLeave() {
  // An ntfy subscription lives in the ntfy app, out of ParkAlert's reach.
  const topic = !phone.id && localStorage.getItem(alertsReadyKey()) === '1' ? dash?.trip.topic : null;
  const ntfyNote = topic ? `<p>This phone gets alerts through ntfy: also unsubscribe from <strong>${esc(topic)}</strong> in the ntfy app, or its alerts keep coming.</p>` : '';
  const content = el(`<div>
    ${sheetHead('Leave this trip?', `This phone stops showing it. The trip keeps running for anyone else on it, and you can rejoin with code <strong>${esc(tripCode)}</strong>.`)}
    ${ntfyNote ? `<div class="sheet-note">${ntfyNote}</div>` : ''}
    <div class="btn-stack">
      <button class="btn-secondary danger pressable" type="button" data-act="leave">Leave trip</button>
      <button class="btn-secondary pressable" type="button" data-act="cancel">Cancel</button>
    </div>
  </div>`);
  content.querySelector('[data-act=leave]').onclick = () => { sheet.close(); leaveTrip({ undoable: true }); };
  content.querySelector('[data-act=cancel]').onclick = () => sheet.close();
  sheet.open(content);
}

// The whole point of the app lives in this sheet, so it opens on its own the
// first time a trip is created or joined, and stays one tap away after that.
// The app's own notifications come first: one tap and a system prompt, no
// second app. ntfy stays as the way for phones that can't.
function openAlertSetup() {
  sheet.open(alertSetupContent());
}

function alertSetupContent() {
  const denied = pushSupported() && Notification.permission === 'denied';
  const content = el(`<div>${sheetHead('Get alerts on this phone', '')}</div>`);
  const head = content.querySelector('.sheet-head');
  const ntfy = ntfyStepsContent();

  if (phone.id) {
    head.appendChild(el('<p>Notifications are on for this phone. You get an alert when a ride you follow goes down, is open again, or closes.</p>'));
    if (dash.trip.ntfy !== false) {
      // Subscribed in ntfy as well, this phone gets each alert twice, and
      // pausing just this phone can't silence the ntfy copy.
      const tip = el(`<div class="group padded tip-box"><p>Also subscribed in the ntfy app? Then this phone gets every alert twice, and pausing it won't stop the ntfy ones. If nobody on this trip uses ntfy, turn it off.</p>
        <button class="btn-secondary pressable" type="button" data-act="ntfy-off">Turn off ntfy for this trip</button></div>`);
      tip.querySelector('[data-act=ntfy-off]').onclick = () => { setNtfy(false); sheet.open(alertSetupContent()); };
      content.appendChild(tip);
    }
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="phone-test">${icon('send')}<span>Send this phone a test</span></button>
      <button class="btn-secondary pressable" type="button" data-act="phone-off">Turn off for this phone</button>
      <button class="btn-secondary pressable" type="button" data-act="done">Done</button>
    </div>`));
  } else if (pushSupported() && !needsInstallForPush()) {
    head.appendChild(el(`<p>${denied
      ? 'Notifications are blocked for ParkAlert on this phone. Turn them on in your phone\'s Settings (on iPhone: Settings, Notifications, ParkAlert), then come back here.'
      : 'ParkAlert can notify this phone itself. One tap, nothing else to install.'}</p>`));
    if (!denied) content.appendChild(el(`<p class="say">Your ${platform === 'ios' ? 'iPhone' : 'phone'} will ask once. Tap Allow.</p>`));
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="push-on" ${denied ? 'disabled' : ''}>${icon('bell')}<span>Allow notifications</span></button>
      <p class="footnote center hidden" data-note></p>
    </div>`));
    const more = el('<details class="more"><summary>Alerts not arriving? Try another way (the free ntfy app)</summary></details>');
    more.appendChild(ntfy);
    content.appendChild(more);
    content.appendChild(el(`<div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">${alertsReady() ? 'Done' : 'Set up later'}</button></div>`));
  } else if (needsInstallForPush()) {
    head.appendChild(el('<p>On iPhone, ParkAlert can notify you itself once it is on your Home Screen. Add it there, open it from its icon, and turn notifications on from this screen.</p>'));
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="install">${icon('share')}<span>Add to Home Screen</span></button>
    </div>`));
    const more = el('<details class="more"><summary>Or try another way (the free ntfy app)</summary></details>');
    more.appendChild(ntfy);
    content.appendChild(more);
    content.appendChild(el(`<div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">${alertsReady() ? 'Done' : 'Set up later'}</button></div>`));
  } else {
    head.appendChild(el('<p>Alerts arrive through ntfy, a free notification app. No account needed, and it takes about a minute.</p>'));
    content.appendChild(ntfy);
    content.appendChild(el(`<div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">${alertsReady() ? 'Done' : 'Set up later'}</button></div>`));
  }
  content.appendChild(el('<div class="btn-stack"><button class="btn-inline pressable" type="button" data-act="test-all">Test every phone on this trip</button></div>'));

  const q = (a) => content.querySelector(`[data-act=${a}]`);
  q('done')?.addEventListener('click', () => sheet.close());
  q('test-all').addEventListener('click', openTestEveryone);
  q('install')?.addEventListener('click', () => $('#row-install').click());
  q('push-on')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const note = content.querySelector('[data-note]');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Asking your phone…';
    const result = await subscribePhone();
    if (result === 'on') {
      try { localStorage.removeItem(`parkalert.phoneOff.${tripCode}`); } catch {}
      api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' }).catch(() => {});
      haptic();
      renderAll();
      sheet.open(allSetContent());
      return;
    }
    btn.disabled = result === 'denied';
    btn.querySelector('span').textContent = 'Allow notifications';
    note.classList.remove('hidden');
    note.textContent = result === 'denied'
      ? "Notifications are blocked. Turn them on for ParkAlert in your phone's Settings, then try again."
      : result === 'dismissed'
        ? 'Tap Allow when your phone asks, so alerts can reach you.'
        : "Couldn't turn notifications on. Check your connection and try again, or use ntfy below.";
  });
  q('phone-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' });
      toast('Test sent to this phone');
    } catch (err) {
      toast(testError(err));
    }
    btn.disabled = false;
  });
  q('phone-off')?.addEventListener('click', async () => {
    const code = tripCode;
    try { localStorage.setItem(`parkalert.phoneOff.${code}`, '1'); } catch {}
    await forgetPhone(code);
    renderAll();
    sheet.open(alertSetupContent());
    toast('This phone no longer gets alerts');
  });
  return content;
}

// The end of setting up: a clear yes, and a check that the test arrived.
// "No" leads to the three things that usually explain it.
function allSetContent() {
  const content = el(`<div data-sheet="all-set" class="center-head" style="padding:0.4rem var(--gutter) 0">
    <span class="bigcheck">${icon('check')}</span>
    <h2>This phone will now get alerts</h2>
    <p>We just sent a test alert. Did it arrive?</p>
    <div class="btn-stack" style="padding-left:0;padding-right:0">
      <button class="btn-primary pressable" type="button" data-act="yes">Yes, it arrived</button>
      <button class="btn-ghost pressable" type="button" data-act="no">No, it didn't</button>
    </div>
    <div class="help hidden" style="text-align:left;margin-top:0.6rem">
      <p class="note strong" style="padding:0">Give it a few seconds, then check:</p>
      <ul style="margin:0.4rem 0 0 1.2rem;color:var(--label-2);font-size:0.9375rem;line-height:1.5">
        <li>Focus or Do Not Disturb is off, or lets ParkAlert through.</li>
        <li>Notifications are on for ParkAlert in Settings, Notifications.</li>
        <li>Still nothing? The free ntfy app works on any phone. It's under Alerts on this phone on the Trip tab.</li>
      </ul>
      <div class="btn-stack" style="padding-left:0;padding-right:0">
        <button class="btn-secondary pressable" type="button" data-act="again">Send another test</button>
        <button class="btn-ghost pressable" type="button" data-act="done">Done</button>
      </div>
    </div></div>`);
  const q = (a) => content.querySelector(`[data-act=${a}]`);
  q('yes').onclick = () => { sheet.close(); toast('Alerts are working on this phone'); };
  q('no').onclick = () => { content.querySelector('.help').classList.remove('hidden'); q('no').classList.add('hidden'); };
  q('done').onclick = () => sheet.close();
  q('again').onclick = async () => {
    try {
      await api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' });
      toast('Test sent to this phone');
    } catch (err) {
      toast(testError(err));
    }
  };
  return content;
}

// Subscribing to the trip's ntfy topic: install, subscribe, test.
function ntfyStepsContent() {
  const topic = dash.trip.topic;
  const base = dash.ntfyBase || 'https://ntfy.sh';
  const host = base.replace(/^https?:\/\//, '');
  const deepLink = `ntfy://${host}/${topic}?display=${encodeURIComponent(`ParkAlert ${tripCode}`)}${base.startsWith('https') ? '' : '&secure=false'}`;
  const ready = localStorage.getItem(alertsReadyKey()) === '1';
  const install = platform === 'ios'
    ? `<a class="btn-secondary pressable" href="${APP_STORE}" target="_blank" rel="noopener">Get ntfy on the App Store</a>`
    : platform === 'android'
      ? `<a class="btn-secondary pressable" href="${PLAY_STORE}" target="_blank" rel="noopener">Get ntfy on Google Play</a>`
      : `<div class="btn-row"><a class="btn-secondary pressable" href="${APP_STORE}" target="_blank" rel="noopener">App Store</a>
         <a class="btn-secondary pressable" href="${PLAY_STORE}" target="_blank" rel="noopener">Google Play</a></div>`;
  const topicChip = `<div class="topic"><code>${esc(topic)}</code><button type="button" data-act="copy">Copy</button></div>`;
  const subscribe = platform === 'android'
    ? `<p>One tap subscribes this phone to your trip.</p>
       <a class="btn-secondary pressable" href="${esc(deepLink)}">Subscribe in ntfy</a>`
    : platform === 'ios'
      ? `<p>Copy this, then in ntfy tap <strong>+</strong>, paste it and tap Subscribe.</p>${topicChip}`
      : `<p>In the ntfy app on your phone, tap <strong>+</strong> and subscribe to this topic. Or get alerts in this browser with <a href="${esc(base)}/${esc(topic)}" target="_blank" rel="noopener">ntfy web</a>.</p>${topicChip}`;
  const content = el(`<div>
    <ol class="steps">
      <li class="step"><h3>Install ntfy</h3><p>Already have it? Skip ahead.</p>${install}</li>
      <li class="step"><h3>Subscribe to this trip</h3>${subscribe}</li>
      <li class="step ${ready ? 'done' : ''}"><h3>Send a test</h3>
        <p>${ready ? 'Alerts are working on this phone.' : 'Make sure it shows up as a notification.'}</p>
        <button class="btn-secondary pressable" type="button" data-act="test">${icon('send')}<span>Send test alert</span></button>
        <div class="confirm hidden" style="margin-top:0.9rem">
          <p>Did it arrive?</p>
          <div class="btn-row">
            <button class="btn-secondary pressable" type="button" data-act="yes">It arrived</button>
            <button class="btn-secondary pressable" type="button" data-act="no">Not yet</button>
          </div>
          <p class="tip hidden" style="margin-top:0.7rem">Give it a few seconds. Then check that notifications are allowed for ntfy in your phone's Settings, and that the topic you subscribed to matches exactly.</p>
        </div>
      </li>
    </ol>
  </div>`);
  const q = (a) => content.querySelector(`[data-act=${a}]`);
  q('copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(topic);
      q('copy').textContent = 'Copied';
      haptic();
      setTimeout(() => { if (q('copy')) q('copy').textContent = 'Copy'; }, 2000);
    } catch {
      // Select it for them, so the system's Copy is one tap away.
      const range = document.createRange();
      range.selectNodeContents(content.querySelector('.topic code'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Tap Copy on the selected topic');
    }
  });
  q('test').addEventListener('click', async () => {
    const btn = q('test');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Sending…';
    try {
      await api(`/trips/${tripCode}/test`, { method: 'POST', body: { to: 'ntfy' } });
      btn.querySelector('span').textContent = 'Send again';
      content.querySelector('.confirm').classList.remove('hidden');
    } catch {
      btn.querySelector('span').textContent = "Couldn't send. Try again";
    }
    btn.disabled = false;
  });
  q('yes').addEventListener('click', () => {
    localStorage.setItem(alertsReadyKey(), '1');
    // The server counts the ntfy topic as reaching someone once a phone says so.
    patchTrip({ ntfyWorking: true }).catch(() => {});
    sheet.close();
    renderAll();
    toast('Alerts are working on this phone');
  });
  q('no').addEventListener('click', () => content.querySelector('.tip').classList.remove('hidden'));
  return content;
}

/* ---------- Detail pages ---------- */
const TAB_TITLE = { down: 'Down now', rides: 'Rides', trip: 'Trip' };
// Where Back goes, in words: the page underneath, or the tab it came from.
const backLabel = () => pages.top?.title() || TAB_TITLE[view] || 'Back';

const KIND_NOTE = {
  hold: 'Several rides went down within a few minutes of each other. That usually means a park-wide hold, for fireworks or a power or safety check, and the rides tend to reopen together.',
  storm: 'Lightning nearby closed the outdoor rides together. Storm holds run longer than a breakdown, and the rides tend to reopen together.',
  opening: 'This ride did not open on time. Delayed openings are estimated from past delayed openings, not breakdowns.',
};

const WEATHER_NOTE = {
  lightning: "Outdoor rides close while there's lightning nearby and reopen about 30 minutes after the last of it, once they've been checked. The storm's end comes from the automated weather stations nearest the park.",
  rain: 'This ride closes in rain as well as lightning and reopens once the rain has stopped and the track has dried. The rain comes from the automated weather stations nearest the park.',
};

function estimateExplainer(o) {
  if (o?.cause) {
    if (!o.basis) return 'ParkAlert has not seen enough weather closures here to put a range on this one yet.';
    if (o.basis.from === 'rule') return 'Until ParkAlert has seen enough storms here to learn how this ride really goes, this uses the 30-minute rule: most reopen 30 to 45 minutes after the storm passes.';
    const what = o.cause === 'rain' ? 'rain closures' : 'storms';
    // Still going on: the range is how long it lasts plus the reopening
    // after. Saying "timed from when it passed" here contradicted the
    // "still nearby" right above it.
    if (o.weather !== 'passed') {
      return `The ${o.cause === 'rain' ? 'rain' : 'storm'} is still going on, so this is how long ${what} here usually last plus the time rides take to reopen afterwards, from ${o.basis.outages} past ${what} ${o.basis.from === 'ride' ? 'for this ride' : 'at this park'}. It tightens once the ${o.cause === 'rain' ? 'rain stops' : 'storm passes'}.`;
    }
    return `Timed from when the ${o.cause === 'rain' ? 'rain stopped' : 'storm passed'}, not from when the ride went down: based on ${o.basis.outages} past ${what} ${o.basis.from === 'ride' ? 'for this ride' : 'at this park'}. The middle half of them reopened within the range above.`;
  }
  if (!o?.basis) return o?.text ? 'This outage is already longer than nearly every past outage like it, so there is no honest range to give.' : '';
  const unseen = o.startUnknown ? " It was already down when ParkAlert first saw it, so it may have been down longer, and take longer, than this assumes." : '';
  if (o.basis.from === 'prior') {
    return "ParkAlert hasn't seen enough outages here yet, so this range comes from typical theme park outages: breakdowns often take about 15 minutes, holds closer to an hour. It switches to this park's own record once there is one.";
  }
  const kind = { hold: 'park-wide holds', opening: 'delayed openings' }[o.kind] || 'breakdowns';
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  return `Based on ${o.basis.outages} past ${kind} ${where} that lasted at least as long as this one has so far. The middle half of them reopened within the range above.${unseen}`;
}

const liveRide = (id) => dash?.rides.find((r) => r.id === id) || null;

// Opens at once with what is already known; the history fills in after.
//   fresh: opened from an alert, so nothing is shown from the last dashboard
//   (which may predate the alert) until this ride's own detail is in.
function openRide(rideId, { fresh = false } = {}) {
  const known = liveRide(rideId);
  if (!known) return;
  const page = {
    key: `ride:${rideId}`,
    url: `/ride/${encodeURIComponent(rideId)}`,
    back: backLabel(),
    rideId,
    detail: null,
    failed: false,
    title: () => liveRide(rideId)?.name || known.name,
    render() {
      if (fresh && !this.detail && !this.failed) return skeleton('ride');
      return rideHtml(freshestRide(liveRide(rideId) || known, this.detail), this.detail, this.failed);
    },
    scene() {
      const r = liveRide(rideId) || known;
      const on = isFollowing(rideId);
      return {
        train: r.status === 'DOWN' ? 'stopped' : r.status === 'OPERATING' ? 'running' : null,
        action: r.other ? '' : `<button class="pill glass pressable strip-action" type="button" data-act="follow" data-key="follow" aria-pressed="${on}">${icon(on ? 'bell' : 'bell-off')}<span>${on ? 'Alerts on' : 'Alerts off'}</span></button>`,
      };
    },
    charts() { return this.detail ? rideCharts(this.detail) : null; },
    async load() {
      try {
        this.detail = await api(`/trips/${tripCode}/rides/${encodeURIComponent(rideId)}`);
        this.failed = false;
      } catch {
        this.failed = true;
      }
      pages.draw(this);
    },
  };
  pages.push(page);
}

// The ride as of whichever is newer: the dashboard, or the page's own
// detail (fetched as the page opened, so usually newer). The dashboard's
// extras (its usual wait, the outlook) stay where the detail has none.
function freshestRide(live, detail) {
  if (!detail?.ride || !(detail.now > (dash?.now ?? 0))) return live;
  const r = { ...live, ...detail.ride };
  if (r.status !== 'DOWN') delete r.outlook;
  else if (detail.outlook) r.outlook = detail.outlook;
  return r;
}

// Wait alert: "alert me when the wait is at or under N". The limits offered
// step down from the current posted wait (at 120: 45, 60, 75, 90, 100), since
// one at or over it would go off at once; a ride that isn't posting a wait
// steps down from its usual wait at this hour.
const WAIT_LADDER = [10, 15, 20, 30, 45, 60, 75, 90, 100, 120, 150, 180];
function waitChoices(r, posted) {
  const below = posted != null
    ? WAIT_LADDER.filter((m) => m < posted)
    : WAIT_LADDER.filter((m) => m <= Math.max(r.usual ?? 60, 30));
  return below.slice(-5);
}

async function setWaitAlert(rideId, max, device = null) {
  try {
    const path = `/trips/${tripCode}/wait-alerts/${encodeURIComponent(rideId)}`;
    const { trip } = await api(path, max == null ? { method: 'DELETE' } : { method: 'PUT', body: device ? { max, device } : { max } });
    dash.trip = trip;
    confirmTrip(trip);
    tellOtherTabs();
    renderAll();
    toast(max == null ? 'Wait alert off' : `Wait alert set for ${max} min or less${device ? ', on this phone' : ', for everyone'}`);
  } catch {
    toast("Couldn't save that. Check your connection and try again.");
  }
}

// A signature of a chart's data: the chart is redrawn only when it changes.
const sigOf = (data) => {
  const s = JSON.stringify(data);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${s.length}-${h}`;
};

function rideCharts(detail) {
  return {
    wait: { waits: detail.waits, now: detail.now },
    days: detail.history?.archivedDays ? { days: detail.history.days } : null,
    hours: detail.bestTimes ? { typical: detail.bestTimes.typical, unit: 'wait' } : null,
  };
}

// The return time on flip tiles, as a posted-wait sign shows it: "11:10",
// with AM or PM (or "or later") beside it, never inside a tile.
function flipTiles(ts, suffix = '', weather = false) {
  const full = fmtTime(ts);
  const m = full.match(/^(.*)\u00a0([AP]M)$/);
  const digits = m ? m[1] : full;
  const side = [m ? m[2] : '', suffix].filter(Boolean).join(' ');
  const tiles = [...digits].map((ch) => (ch === ':' || ch === '.' ? `<em>${ch}</em>` : `<span>${esc(ch)}</span>`)).join('');
  return `<div class="flip" role="img" aria-label="${esc(`${full}${suffix ? ` ${suffix}` : ''}`)}">${tiles}${side ? `<b class="suffix${weather ? ' weather' : ''}">${esc(side)}</b>` : ''}</div>`;
}

// "About 6 in 10 are over within 30 min": the chance, in words people use.
function chanceWords(o) {
  const c = o?.chance;
  if (!c) return '';
  for (const m of [15, 30, 60]) {
    const n = Math.round(c[m] * 10);
    if (n >= 3 && n <= 9) return `About ${n} in 10 are over within ${m === 60 ? 'the hour' : `${m}\u00a0min`}.`;
  }
  return '';
}

// Where an estimate comes from, in a line under "How we estimate this".
function basisLine(o) {
  if (o?.cause) return "From public weather reports near the park, not Disney's own sensors.";
  if (!o?.basis) return '';
  if (o.basis.from === 'prior') return 'From typical theme park outages, until ParkAlert knows this park.';
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  const what = { hold: 'group closures', opening: 'late openings' }[o.kind] || 'closures';
  return `From ${o.basis.outages} past ${what} ${where}.`;
}

// The answer for a closed ride, shared by the ride page and the hold page.
function downAnswer(r, o) {
  const b = backAt(r, o);
  const parts = [];
  if (b.kind === 'time') {
    parts.push('<p class="flabel">Back at about</p>', flipTiles(b.at));
    if (b.range) parts.push(`<p class="range">Usually ${esc(fmtSpan(b.range[0], b.range[1]))}. ${esc(chanceWords(o))}</p>`);
  } else if (b.kind === 'later') {
    parts.push('<p class="flabel">Likely back</p>', flipTiles(b.at, 'or later', true));
    parts.push(`<p class="range">${o.cause === 'rain'
      ? 'Rides like this reopen once the rain stops and the track dries.'
      : 'Outdoor rides usually stay closed about 30\u00a0min after lightning clears, then need testing, often another 15 to 45\u00a0min.'}</p>`);
  } else {
    const [big, text] = {
      storm: [o?.cause === 'rain' ? 'Waiting for the rain to stop' : 'Waiting for the storm to pass', "Once the weather clears, outdoor rides usually reopen 30\u00a0min or more later. You'll get an alert when there's a time."],
      hour: ['Back in over an hour', o?.advice?.detail || 'Closures this long rarely end soon.'],
      closed: ['May not reopen today', o?.advice?.detail || ''],
      closing: ['May not reopen before close', o?.advice?.detail || ''],
      none: ['No estimate yet', "ParkAlert hasn't seen enough closures like this one to say."],
    }[b.kind];
    parts.push(`<p class="big-wait" style="font-size:min(1.5rem,34px)">${esc(big)}</p>`, text ? `<p class="range">${esc(text)}</p>` : '');
  }
  const how = [estimateExplainer(o), o?.cause ? WEATHER_NOTE[o.cause] : KIND_NOTE[o?.kind] || ''].filter(Boolean);
  if (how.length) {
    parts.push(`<details class="how-wrap" data-key="how"><summary class="how-row"><span class="row-label">How we estimate this<small>${esc(basisLine(o))}</small></span>${icon('chevron', 'chevron')}</summary>
      <div class="how-body">${how.map((t) => `<p>${esc(t)}</p>`).join('')}</div></details>`);
  }
  return parts.join('');
}

// What kind of closure, in the kicker above the answer.
function downKicker(r, o) {
  if (o?.cause) {
    const cleared = o.weather === 'passed' && o.clearedAt ? `weather cleared ${fmtTime(o.clearedAt)}` : 'still storming nearby';
    return `<p class="kicker weather">${icon('bolt')}Stopped, likely ${causeWord(o)} · ${esc(cleared)}</p>`;
  }
  const what = o?.kind === 'opening' ? 'Late to open' : `Down ${downFor(r)}`;
  const extra = o?.kind === 'hold' && o.rides > 1 ? ` · with ${o.rides - 1} other ride${o.rides === 2 ? '' : 's'}` : '';
  return `<p class="kicker down">${icon('down')}${keepTogether(what)}${esc(extra)}</p>`;
}

// The top card: what a guest wants first. Down: when it is likely back.
// Open: the wait, against the usual for this hour. Closed: when it opens.
function heroHtml(r, o, detail) {
  if (r.status === 'DOWN' && r.downSince) {
    return `<div class="group padded hero" data-key="hero">${downKicker(r, o)}${downAnswer(r, o)}</div>`;
  }
  if (r.status === 'OPERATING') {
    const usual = detail?.bestTimes?.typical?.[parkHour()] ?? r.usual ?? null;
    const ride = { ...r, usual };
    const diff = r.waitTime != null && usual != null ? r.waitTime - usual : null;
    const kick = diff != null && diff <= -5 ? `Open · ${-diff}\u00a0min shorter than usual`
      : diff != null && diff >= 10 ? `Open · ${diff}\u00a0min longer than usual` : 'Open';
    const t = r.trend;
    const lines = [
      usual != null ? `Usually ${usual}\u00a0min at ${fmtHour(parkHour())}.` : '',
      t ? `${Math.abs(t.change)}\u00a0min ${t.direction === 'up' ? 'longer' : 'shorter'} than half an hour ago.` : '',
    ].filter(Boolean).join(' ');
    const tags = queueTags(r);
    return `<div class="group padded hero" data-key="hero">
      <p class="kicker ${diff != null && diff <= -5 ? 'open' : 'closed'}">${icon('check-circle')}${esc(kick)}</p>
      <p class="big-wait">${r.waitTime != null ? `${r.waitTime}<small> min wait</small>` : 'No posted wait'}</p>
      ${lines ? `<p class="range">${esc(lines)}</p>` : ''}
      ${waitBar(ride)}
      ${tags.length ? `<p class="range" style="margin-top:0.6rem">${esc(tags.join(' · '))}</p>` : ''}
    </div>`;
  }
  const opens = dash.park.openingTime && Date.now() < Date.parse(dash.park.openingTime);
  return `<div class="group padded hero" data-key="hero">
    <p class="kicker closed">${icon('moon')}${r.status === 'REFURBISHMENT' ? 'Closed for refurbishment' : 'Closed'}</p>
    <p class="big-wait" style="font-size:min(1.5rem,34px)">${r.status === 'REFURBISHMENT' ? 'Not running for now' : opens ? `Opens at ${fmtTime(Date.parse(dash.park.openingTime))}` : 'Not running right now'}</p>
  </div>`;
}

// Today's closures as marks on one line from opening to now.
function dayLineHtml(r, detail, o) {
  const events = [...detail.today];
  const down = r.status === 'DOWN' && r.downSince;
  if (down && !events.some((e) => e.type === 'DOWN' && e.at >= r.downSince - 120_000)) events.push({ type: 'DOWN', at: r.downSince, opening: o?.kind === 'opening' });
  events.sort((a, b) => a.at - b.at);
  const spells = [];
  for (const e of events) {
    if (e.type === 'DOWN') spells.push({ from: e.at, to: null });
    else if (spells.length && spells[spells.length - 1].to == null) spells[spells.length - 1].to = e.at;
  }
  if (!spells.length) {
    return `<div class="group padded" data-key="today"><div class="day-head"><b>Today</b><span>No closures so far</span></div></div>`;
  }
  const open = Date.parse(dash.park.openingTime || '') || spells[0].from - 3600_000;
  const now = Date.now();
  const span = Math.max(now - open, 1);
  const pct = (t) => Math.min(100, Math.max(0, ((t - open) / span) * 100)).toFixed(1);
  const marks = spells.map((s) => `<i class="${s.to ? 'past' : ''}" style="left:${pct(s.from)}%;width:${Math.max(1.5, pct(s.to ?? now) - pct(s.from)).toFixed(1)}%"></i>`).join('');
  const first = spells[0], last = spells[spells.length - 1];
  const keyFor = (s) => `${fmtTime(s.from)}<br>${s.to ? keepTogether(fmtDuration(s.to - s.from)) : 'still down'}`;
  return `<div class="group padded" data-key="today" role="img" aria-label="${esc(`${spells.length} closure${spells.length === 1 ? '' : 's'} today: ${spells.map((s) => `${fmtTime(s.from)}${s.to ? `, ${fmtDuration(s.to - s.from)}` : ', still down'}`).join('; ')}`)}">
    <div class="day-head" aria-hidden="true"><b>Today</b><span>${spells.length} closure${spells.length === 1 ? '' : 's'}</span></div>
    <div class="day-line" aria-hidden="true">${marks}</div>
    <div class="day-keys" aria-hidden="true"><span>${keyFor(first)}</span>${spells.length > 1 ? `<span style="text-align:right">${keyFor(last)}</span>` : ''}</div>
  </div>`;
}

// A ride's page: the answer first, then today, then a few rows that open
// the rest (best times, past closures, a wait alert).
function rideHtml(r, detail, failed) {
  const o = (r.status === 'DOWN' ? r.outlook : null) || (detail?.ride?.status === 'DOWN' ? detail.outlook : null);
  const parts = [heroHtml(r, o, detail)];
  if (r.status === 'DOWN' && !r.other && r.lightningLane) parts.push('<p class="note" data-key="ll">Had a Lightning Lane for this ride? Check the Disney app for your options.</p>');
  if (!detail) {
    parts.push(failed
      ? `<div class="retry" data-key="retry"><p class="footnote">Couldn't load this ride's wait times and history.</p>
          <button class="btn-secondary pressable" type="button" data-act="retry">Try again</button></div>`
      : skeleton('ride'));
    return parts.join('');
  }
  if (r.status === 'OPERATING' && detail.waits.some(([, v]) => v != null)) {
    parts.push(`<h2 class="section-label" data-key="waits-label">Waits today</h2>
      <div class="group padded" data-chart="wait" data-key="wait-chart" data-sig="${sigOf(detail.waits)}"></div>
      <p class="footnote" data-key="waits-foot">Drag across to see any time.</p>`);
  }
  parts.push(`<div class="spaced-sm" data-key="today-wrap">${dayLineHtml(r, detail, o)}</div>`);
  const rows = [];
  if (!r.other) {
    const alert = dash.trip.waitAlerts?.[r.id];
    const armed = alert && !alert.sentAt;
    const who = { me: 'Just me', other: 'Another phone', all: 'Everyone' }[alertOwner(alert)];
    rows.push(`<button class="row pressable" type="button" data-act="wait-sheet" data-key="wait" aria-haspopup="dialog">
      <span class="row-label">Wait alert${armed ? `<small>${esc(who)}, at ${alert.max}\u00a0min or less</small>` : alert?.sentAt ? `<small>Sent at ${fmtTime(alert.sentAt)}</small>` : ''}</span>
      <span class="row-detail">${armed ? 'On' : 'Off'}</span>${icon('chevron', 'chevron')}</button>`);
  }
  if (detail.bestTimes) {
    const bt = detail.bestTimes;
    const left = bestLeftToday(bt.typical);
    const line = left
      ? left.hour === parkHour() ? `Now is about as short as it gets, usually ${left.wait}\u00a0min` : `Around ${fmtHour(left.hour)}, usually ${left.wait}\u00a0min`
      : `Usually shortest around ${fmtHour(bt.best.hour)}`;
    rows.push(`<button class="row pressable" type="button" data-act="open-best" data-key="best"><span class="row-label">Best time today<small>${esc(line)}</small></span>${icon('chevron', 'chevron')}</button>`);
  }
  if (detail.history?.archivedDays) {
    const h = detail.history;
    const n = h.days.reduce((x, d) => x + d.outages, 0);
    const line = [`${n} in ${h.days.length} days`, h.typicalMinutes != null ? `usually ${fmtDuration(h.typicalMinutes * 60000)}` : null].filter(Boolean).join(', ');
    rows.push(`<button class="row pressable" type="button" data-act="open-history" data-key="hist"><span class="row-label">Past closures<small>${esc(line)}</small></span>${icon('chevron', 'chevron')}</button>`);
  }
  if (r.other) rows.push('<div class="row" data-key="other"><span class="row-label muted">This attraction never posts a wait, so it has no alerts.</span></div>');
  if (rows.length) parts.push(`<div class="group spaced-sm" data-key="rows">${rows.join('')}</div>`);
  return parts.join('');
}

// Best times and past closures, each on a page of its own under the ride.
function rideSectionHtml(detail, section) {
  if (!detail) return skeleton('rows');
  if (section === 'best' && detail.bestTimes) {
    const bt = detail.bestTimes;
    const left = bestLeftToday(bt.typical);
    return `<div class="group padded" data-key="best">
        <p class="best-line">${left
    ? left.hour === parkHour() ? `Now is about as short as it gets today, usually ${left.wait}\u00a0min.`
      : `Shortest for the rest of today around <strong>${fmtHour(left.hour)}</strong>, usually ${left.wait}\u00a0min.`
    : `On a usual day, shortest around <strong>${fmtHour(bt.best.hour)}</strong> (${bt.best.wait}\u00a0min) and longest around ${fmtHour(bt.worst.hour)} (${bt.worst.wait}\u00a0min).`}</p>
        <div data-chart="hours" data-key="hours-chart" data-sig="${sigOf(bt.typical)}"></div>
      </div>
      <p class="footnote" data-key="best-foot">The usual posted wait for each hour, from ${bt.days} day${bt.days === 1 ? '' : 's'} of history. Tap an hour.</p>`;
  }
  if (section === 'history' && detail.history) {
    const h = detail.history;
    const parts = [`<div class="group padded" data-key="hist">
        <div class="stats">
          <div><p class="stat-label">Closures</p><p class="stat-value">${h.days.reduce((n, d) => n + d.outages, 0)}</p></div>
          <div><p class="stat-label">Typical</p><p class="stat-value">${h.typicalMinutes != null ? fmtDuration(h.typicalMinutes * 60000) : 'None'}</p></div>
          <div><p class="stat-label">Longest</p><p class="stat-value">${h.longestMinutes != null ? fmtDuration(h.longestMinutes * 60000) : 'None'}</p></div>
        </div>
        <div data-chart="days" data-key="days-chart" data-sig="${sigOf(h.days)}"></div>
      </div>`];
    if (h.last.length) {
      parts.push(`<h2 class="section-label" data-key="last-label">Recent closures</h2>
        <div class="group plain" data-key="last">${h.last.slice(0, 5).map((ep) => `
        <div class="row" data-key="${ep.start}">
          <span class="row-label">${esc(fmtDay(ep.start))}<small>${esc([
            fmtTime(ep.start),
            { hold: 'with other rides', opening: 'late opening' }[ep.kind],
            ep.reopened ? '' : "didn't reopen that day",
          ].filter(Boolean).join(' · '))}</small></span>
          <span class="row-detail">${ep.reopened ? fmtDuration(ep.minutes * 60000) : ''}</span>
        </div>`).join('')}</div>`);
    }
    parts.push(`<p class="footnote" data-key="hist-foot">Closures over the last ${h.days.length} days, from the ThemeParks.wiki archive.</p>`);
    return parts.join('');
  }
  return '';
}

function openRideSection(rideId, section) {
  const ride = pages.top;
  if (!ride?.detail) return;
  pages.push({
    key: `ride:${rideId}:${section}`,
    url: `/ride/${encodeURIComponent(rideId)}/${section}`,
    back: listName(liveRide(rideId) || { name: 'Back' }),
    title: () => (section === 'best' ? 'Best time to ride' : 'Past closures'),
    render: () => rideSectionHtml(ride.detail, section),
    charts: () => {
      const c = rideCharts(ride.detail);
      return section === 'best' ? { hours: c.hours } : { days: c.days };
    },
  });
}

// This phone's fingerprint, as the server tags its own wait alerts with.
// Needs a secure page (as the app always is); elsewhere nothing is "mine".
let myTag = null;
async function syncMyTag() {
  myTag = null;
  if (!phone.id || !crypto.subtle) return;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${tripCode}:${phone.id}`));
  myTag = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 16);
}
const alertOwner = (a) => (!a?.owner ? 'all' : a.owner === myTag ? 'me' : 'other');

// A wait alert: a few limits under the posted wait, for this phone only or
// for everyone on the trip. It starts on "Just me", as pausing does, so one
// person's alert never buzzes the whole family by surprise.
function openWaitAlert(rideId) {
  const r = liveRide(rideId);
  if (!r) return;
  const alert = dash.trip.waitAlerts?.[r.id];
  const armed = alert && !alert.sentAt;
  const posted = r.status === 'OPERATING' && r.waitTime != null ? r.waitTime : null;
  let choices = waitChoices(r, posted);
  if (armed && !choices.includes(alert.max)) choices = [...choices, alert.max].sort((a, b) => a - b);
  let pick = armed ? alert.max : choices[choices.length - 1] ?? null;
  const perPhone = !!phone.id;
  const owner = armed ? alertOwner(alert) : null;
  let scope = perPhone && owner !== 'all' ? 'me' : 'all';
  const state = armed
    ? owner === 'other' ? `Another phone on the trip has an alert here at ${alert.max}\u00a0min. Setting one replaces it.`
      : `On: ${owner === 'me' ? 'just this phone' : 'everyone on the trip'}, at ${alert.max}\u00a0min or less.`
    : alert?.sentAt ? `Sent at ${fmtTime(alert.sentAt)}, when the wait was ${alert.sentWait}\u00a0min.`
      : posted != null ? `The wait is ${posted}\u00a0min now.` : 'It is not posting a wait right now.';
  const content = el(`<div data-sheet="wait">
    ${sheetHead('Wait alert', `One alert, once, when the posted wait for ${esc(listName(r))} drops to your number. Today only.`)}
    ${perPhone ? `<div class="segmented scope" role="radiogroup" aria-label="Who gets it">
      <button type="button" role="radio" data-scope="me" aria-checked="${scope === 'me'}">Just me</button>
      <button type="button" role="radio" data-scope="all" aria-checked="${scope === 'all'}">Everyone</button></div>` : ''}
    <p class="note" style="padding-top:0">${esc(state)}</p>
    ${choices.length ? `<div class="wait-nums" role="radiogroup" aria-label="Minutes or less" style="margin-top:0.8rem">${choices.map((m) => `<button type="button" role="radio" data-m="${m}" aria-checked="${m === pick}" aria-label="${m} minutes or less">${m}</button>`).join('')}</div>
      <p class="note">minutes or less</p>` : `<p class="note">The wait is already short. Nothing to set.</p>`}
    <div class="btn-stack">
      ${choices.length ? `<button class="btn-primary pressable" type="button" data-act="set">Set alert at ${pick}\u00a0min</button>` : ''}
      ${armed && owner !== 'other' ? '<button class="btn-ghost pressable" type="button" data-act="off">Turn off this alert</button>' : '<button class="btn-ghost pressable" type="button" data-act="done">Cancel</button>'}
    </div></div>`);
  const sync = () => {
    content.querySelectorAll('[data-m]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.m) === pick)));
    content.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scope === scope)));
    const set = content.querySelector('[data-act=set]');
    if (set) set.textContent = `Set alert at ${pick}\u00a0min${scope === 'all' ? ' for everyone' : ''}`;
  };
  content.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    const sc = e.target.closest('[data-scope]');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (m) { pick = Number(m.dataset.m); haptic(); sync(); }
    else if (sc) { scope = sc.dataset.scope; haptic(); sync(); }
    else if (act === 'done') sheet.close();
    else if (act === 'off') { sheet.close(); setWaitAlert(rideId, null); }
    else if (act === 'set') { sheet.close(); setWaitAlert(rideId, pick, scope === 'me' ? phone.id : null); }
  });
  sync();
  sheet.open(content);
}

function fmtDay(ts) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: dash?.park.timezone }).format(new Date(ts));
}

function openParkInfo() {
  if (!dash) return;
  pages.push({
    key: 'park',
    url: '/park',
    back: backLabel(),
    info: null,
    failed: false,
    title: () => parkLabel(dash.park.name),
    scene: () => ({}),
    render() { return parkHtml(this.info, this.failed); },
    charts() { return this.info?.crowd ? { crowd: this.info.crowd } : null; },
    async load() {
      try {
        this.info = await api(`/trips/${tripCode}/park`);
        this.failed = false;
      } catch {
        this.failed = true;
      }
      pages.draw(this);
    },
  });
}

function parkHtml(info, failed) {
  const downNow = dash.rides.filter((r) => r.status === 'DOWN' && !r.other).length;
  const parts = [];
  const { openingTime: open, closingTime: close, lateEvent } = dash.park;
  if (open || close) {
    parts.push(`<div class="group plain" data-key="hours-list">
      ${open ? `<div class="row" data-key="opens"><span class="row-label">Opens</span><span class="row-detail">${fmtTime(Date.parse(open))}</span></div>` : ''}
      ${close ? `<div class="row" data-key="closes"><span class="row-label">Closes</span><span class="row-detail">${fmtTime(Date.parse(close))}</span></div>` : ''}
      ${lateEvent ? `<div class="row" data-key="event"><span class="row-label">${esc(lateEvent.name)}<small>Alerts keep going until it ends</small></span><span class="row-detail">until ${fmtTime(Date.parse(lateEvent.closingTime))}</span></div>` : ''}
    </div>`);
  }
  parts.push(`<div class="group spaced-sm" data-key="change"><button class="row pressable" type="button" data-act="change-park">
    <span class="row-label">Change park<small>For everyone on this trip</small></span>${icon('chevron', 'chevron')}</button></div>`);
  const cr = info?.crowd;
  if (cr?.now || cr?.today.some((v) => v != null)) {
    parts.push(`<h2 class="section-label" data-key="crowd-label">Crowds</h2>
      <div class="group padded" data-key="crowd">
        ${cr.now?.paused ? `<p class="best-line"><strong>Crowd level paused</strong> · ${cr.now.paused === 'hold' ? "waits during a hold and just after it don't show how busy the park is." : 'too few of the big rides are posting waits right now.'}</p>`
          : cr.now ? `<p class="best-line"><strong>${esc(cr.now.label)}</strong> · the big rides average about ${cr.now.index} min; usually ${cr.now.typical} at ${fmtHour(cr.now.hour)}.</p>` : ''}
        <div data-chart="crowd" data-key="crowd-chart" data-sig="${sigOf([cr.today, cr.typical])}"></div>
      </div>
      <p class="footnote" data-key="crowd-foot">Average posted wait on this park's ten busiest rides, today against a usual day (from ${cr.days} day${cr.days === 1 ? '' : 's'}). Each ride is compared with its own usual wait and closed rides are left out, so a storm never reads as a quiet park. Drag across the chart.</p>`);
  }
  parts.push(`<div class="group padded spaced-sm" data-key="stats"><div class="stats">
    <div><p class="stat-label">Down now</p><p class="stat-value">${downNow}</p></div>
    <div><p class="stat-label">Outages today</p><p class="stat-value">${info ? info.today.downs : '<span class="sk sk-num"></span>'}</p></div>
    <div><p class="stat-label">Typical outage</p><p class="stat-value">${info?.week.typicalBreakdownMinutes != null ? fmtDuration(info.week.typicalBreakdownMinutes * 60000) : info ? 'n/a' : '<span class="sk sk-num"></span>'}</p></div>
  </div></div>`);
  if (info?.week.leastReliable.length) {
    parts.push(`<h2 class="section-label" data-key="least-label">Most outages, last ${info.week.days} days</h2>`);
    // Only rides in today's live data have a page to open; one that has been
    // renamed or closed for the season is listed, not offered as a button.
    const live = new Set(dash.rides.map((r) => r.id));
    parts.push(`<div class="group plain" data-key="least">${info.week.leastReliable.map((r) => {
      const label = `<span class="row-label">${esc(r.name)}<small>${r.outages} outage${r.outages === 1 ? '' : 's'}, ${fmtDuration(r.minutes * 60000)} down in total</small></span>`;
      return live.has(r.id)
        ? `<button class="row pressable" type="button" data-ride="${esc(r.id)}">${label}${icon('chevron', 'chevron')}</button>`
        : `<div class="row" data-key="gone-${esc(r.id)}">${label}</div>`;
    }).join('')}</div>`);
    if (info.week.holdDays) {
      parts.push(`<p class="footnote" data-key="holds-foot">Park-wide holds happened on ${info.week.holdDays} of those ${info.week.days} days.</p>`);
    }
  }
  if (info?.estimates?.groups.length) {
    parts.push(`<h2 class="section-label" data-key="est-label">How the estimates did, last ${info.estimates.days} days</h2>
      <div class="group plain" data-key="est">${info.estimates.groups.map((g) => `
      <div class="row" data-key="${esc(g.label)}"><span class="row-label">${esc(g.label)}<small>${g.n} outage${g.n === 1 ? '' : 's'}${g.closed ? `, ${g.closed} closed for the day` : ''} · ranges about ${g.width} min wide</small></span>
      <span class="row-detail">${g.inRange == null ? 'Not enough reopenings yet' : `${g.inRange}% in range`}</span></div>`).join('')}</div>
      <p class="footnote" data-key="est-foot">A range is the middle half of past outages like it, so about half should land inside. Ranges after the weather clears are the tight ones; breakdowns are hard to call closely.</p>`);
  }
  if (!info) {
    parts.push(failed
      ? `<div class="retry" data-key="retry"><p class="footnote">Couldn't load this park's week and scorecard.</p>
          <button class="btn-secondary pressable" type="button" data-act="retry">Try again</button></div>`
      : skeleton('rows'));
  }
  parts.push(`<p class="footnote" data-key="updated">${dash.lastPoll ? `Ride status updated at ${fmtTime(dash.lastPoll)}.` : ''}</p>`);
  parts.push('<p class="unofficial" data-key="unofficial">ParkAlert is an unofficial fan app, not affiliated with Disney.</p>');
  return parts.join('');
}

function openHold() {
  if (!dash) return;
  pages.push({
    key: 'hold',
    url: '/hold',
    back: backLabel(),
    title: () => {
      const held = heldRides();
      const o = held[0]?.outlook;
      return o?.cause ? `${held.length} rides stopped, likely ${causeWord(o)}` : `${held.length} rides down together`;
    },
    scene: () => ({}),
    render: holdHtml,
  });
}

const heldRides = () => dash.rides.filter((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold' && !r.other).sort(holdOrder);

// Rides closed together: one answer for all of them, then the rides, yours
// first.
function holdHtml() {
  const held = heldRides();
  if (!held.length) {
    // Left open while the rides came back: say so rather than go blank.
    return `<div class="group padded" data-key="over"><p class="big-wait" style="font-size:min(1.5rem,34px)">They're all open again</p><p class="range">Every ride here is running again or has closed. They're under Open again on Down now.</p></div>`;
  }
  const first = held[0];
  const o = first.outlook;
  const note = o?.cause ? '' : `<p class="note" data-key="why">Several rides closing together without bad weather is usually a park-wide pause, such as for fireworks or a safety check, and they tend to reopen together.</p>`;
  const since = Math.min(...held.map((r) => r.downSince));
  const kicker = o?.cause
    ? `<p class="kicker weather">${icon('bolt')}Since ${fmtTime(since)} · ${esc(o.weather === 'passed' && o.clearedAt ? `weather cleared ${fmtTime(o.clearedAt)}` : 'still storming nearby')}</p>`
    : `<p class="kicker down">${icon('down')}Since ${fmtTime(since)}</p>`;
  return `<div class="group padded hero" data-key="hero">${kicker}${downAnswer(first, o)}</div>${note}
    <h2 class="section-label" data-key="count">${held.length} ride${held.length === 1 ? '' : 's'}</h2>
    <div class="group" data-key="rides">${held.map((r) => {
      const yours = isFollowing(r.id);
      return `<button class="slim pressable" type="button" data-ride="${esc(r.id)}" data-key="h-${esc(r.id)}" aria-label="${esc([r.name, r.land, yours ? 'yours' : null].filter(Boolean).join(', '))}">
        <span class="mk">${statusMark(r, !yours)}</span>
        <span class="rl"><span class="nm">${esc(listName(r))}</span><small>${esc([r.land, yours ? 'yours' : null].filter(Boolean).join(' · '))}</small></span>
        ${icon('chevron', 'chevron')}</button>`;
    }).join('')}</div>`;
}

// Placeholder shapes while something loads, so content settles into place
// instead of popping in under the reader.
function skeleton(kind) {
  const rows = kind === 'ride' ? 3 : kind === 'cards' ? 3 : 5;
  return `<div class="group${kind === 'cards' ? ' lift' : ''} sk-group" data-key="skeleton" aria-hidden="true">${Array.from({ length: rows }, () => `
    <div class="slim"><span class="rl"><span class="sk sk-line w60"></span><span class="sk sk-line w35"></span></span></div>`).join('')}</div>`;
}

// Taps on pages: one delegated listener, so patched content never loses a
// handler.
$('#pages').addEventListener('click', (e) => {
  const page = pages.top;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!page || !act) return;
  if (act === 'follow' && page.rideId) toggleFollow(page.rideId);
  else if (act === 'wait-sheet' && page.rideId) openWaitAlert(page.rideId);
  else if (act === 'open-best' && page.rideId) openRideSection(page.rideId, 'best');
  else if (act === 'open-history' && page.rideId) openRideSection(page.rideId, 'history');
  else if (act === 'open-park') openParkInfo();
  else if (act === 'change-park') openPark();
  else if (act === 'retry') { page.failed = false; pages.draw(page); page.load?.(); }
});

// Any element carrying a ride id opens that ride, wherever it sits.
document.addEventListener('click', (e) => {
  if (e.target.closest('.switch')) return;
  const t = e.target.closest('[data-ride]');
  if (t) openRide(t.dataset.ride);
});
// A card is a link: Enter opens it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.card[data-ride]')) {
    e.preventDefault();
    openRide(e.target.dataset.ride);
  }
});

/* ---------- Charts ---------- */
// Round an axis top up to a number a person would say.
function niceMax(v) {
  for (const s of [10, 15, 20, 30, 45, 60, 90, 120, 180, 240]) if (v <= s) return s;
  return Math.ceil(v / 60) * 60;
}

const SVG = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Chart boxes are placeholders in the page's HTML; the data comes from the
// page. A box is drawn once per data signature (see patchNode).
function mountCharts(root, data) {
  if (!data) return;
  for (const box of root.querySelectorAll('[data-chart]')) {
    const d = data[box.dataset.chart];
    if (!d || box._drawn === box.dataset.sig || box._busy) continue;
    box.replaceChildren();
    box._drawn = box.dataset.sig;
    if (box.dataset.chart === 'wait') waitChart(box, d);
    if (box.dataset.chart === 'days') dayBars(box, d);
    if (box.dataset.chart === 'hours') hourBars(box, d);
    if (box.dataset.chart === 'crowd') crowdChart(box, d);
  }
}

// Posted waits hold until they change, so the line steps rather than slopes.
// The box's own padding, which is in rem and grows with the text size.
const contentWidth = (box) => {
  const cs = getComputedStyle(box);
  return box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
};

// The last six hours, scaled to them, so the morning's peak doesn't flatten
// the afternoon; the whole day's pattern is under Best time.
const WAIT_CHART_MS = 6 * 3600_000;
function waitChart(box, { waits, now }) {
  const W = Math.max(160, contentWidth(box)), H = 116, top = 6, bottom = 2;
  let pts = waits.map(([t, w]) => ({ t, w }));
  const start = Math.max(pts[0].t, now - WAIT_CHART_MS);
  const inEffect = pts.filter((p) => p.t <= start).pop();
  pts = [...(inEffect ? [{ t: start, w: inEffect.w }] : []), ...pts.filter((p) => p.t > start)];
  const t0 = pts[0].t, t1 = Math.max(now, t0 + 60_000);
  const max = niceMax(Math.max(10, ...pts.map((p) => p.w ?? 0)));
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (w) => top + (1 - w / max) * (H - top - bottom);
  const base = H - bottom;

  const readout = el('<p class="chart-readout" aria-live="polite"></p>');
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', tabindex: '0', role: 'img', 'data-act': 'wait-chart' });
  svg.append(
    svgEl('line', { x1: 0, x2: W, y1: y(max), y2: y(max), class: 'grid' }),
    svgEl('line', { x1: 0, x2: W, y1: y(max / 2), y2: y(max / 2), class: 'grid faint' }),
    svgEl('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis' })
  );
  // Hour marks every two hours on the park's clock, as Weather's hourly
  // chart has; the labels are HTML below, so they grow with the text size.
  const hours = [];
  const tz = dash?.park.timezone;
  for (let t = nextLocalHour(t0, tz, 0) - 24 * 3600_000; t <= t1; t += 3600_000) {
    // Clear of the start time and "Now" at the ends, which are wider.
    if (x(t) < 70 || x(t) > W - 50) continue;
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(t)));
    if (hour % 2 === 0) hours.push(t);
  }
  for (const t of hours) svg.append(svgEl('line', { x1: x(t), x2: x(t), y1: base - 4, y2: base, class: 'axis' }));

  let line = '', area = '';
  pts.forEach((p, i) => {
    if (p.w == null) return;
    const x0 = x(p.t), x1 = x(i + 1 < pts.length ? pts[i + 1].t : t1), yy = y(p.w);
    const joined = i > 0 && pts[i - 1].w != null;
    line += `${joined ? 'L' : 'M'}${x0.toFixed(1)},${yy.toFixed(1)} H${x1.toFixed(1)} `;
    area += `M${x0.toFixed(1)},${base} V${yy.toFixed(1)} H${x1.toFixed(1)} V${base} Z `;
  });
  svg.append(svgEl('path', { d: area, class: 'area' }), svgEl('path', { d: line, class: 'line' }));

  const cross = svgEl('line', { y1: top, y2: base, class: 'crosshair', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, class: 'dot-mark', visibility: 'hidden' });
  svg.append(cross, dot);

  const at = (t) => {
    let i = 0;
    while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
    return pts[i];
  };
  const show = (t, fromUser) => {
    const p = at(t);
    // A tick each time the finger crosses onto a different reading.
    readout.textContent = `${fromUser ? fmtTime(t) : 'Now'} · ${p.w == null ? 'not running' : `${p.w} min wait`}`;
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t));
    cross.setAttribute('visibility', fromUser ? 'visible' : 'hidden');
    if (p.w != null) {
      dot.setAttribute('cx', x(t)); dot.setAttribute('cy', y(p.w));
      dot.setAttribute('visibility', 'visible');
    } else dot.setAttribute('visibility', 'hidden');
  };
  const latest = pts[pts.length - 1];
  svg.setAttribute('aria-label', `Wait times from ${fmtTime(t0)} to now. Now ${latest.w == null ? 'not running' : `${latest.w} minutes`}.`);
  show(t1, false);

  // Scrub: the crosshair follows the finger along X; vertical drags still scroll.
  let cursor = t1;
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    return t0 + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (t1 - t0);
  };
  svg.addEventListener('pointerdown', (e) => { box._busy = true; try { svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } cursor = fromEvent(e); show(cursor, true); });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || svg.hasPointerCapture(e.pointerId)) { cursor = fromEvent(e); show(cursor, true); }
  });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(t1, false); });
  // Lifting the finger goes back to "Now", as Stocks and Weather do.
  for (const type of ['pointerup', 'pointercancel']) {
    svg.addEventListener(type, (e) => { box._busy = false; if (e.pointerType !== 'mouse') { cursor = t1; show(t1, false); } });
  }
  svg.addEventListener('keydown', (e) => {
    const step = (t1 - t0) / 40;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      cursor = Math.min(t1, Math.max(t0, cursor + (e.key === 'ArrowRight' ? step : -step)));
      show(cursor, true);
    }
  });

  const yLabels = el(`<div class="chart-y"><span>${max} min</span><span>0</span></div>`);
  const hourLabel = (t) => new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', timeZone: tz }).format(new Date(t)).replace(':00', '');
  const axis = el(`<div class="chart-x"><span>${fmtTime(t0)}</span>${hours.map((t) =>
    `<span class="mid" style="left:${((x(t) / W) * 100).toFixed(1)}%">${esc(hourLabel(t))}</span>`).join('')}<span>Now</span></div>`);
  const plot = el('<div class="chart-plot"></div>');
  plot.append(svg, yLabels);
  box.append(readout, plot, axis);
}

// One column per archived day: minutes down. Tap a column for that day.
function dayBars(box, { days }) {
  const W = Math.max(160, contentWidth(box)), H = 96, base = H - 2;
  const max = niceMax(Math.max(10, ...days.map((d) => d.minutes)));
  const slot = W / days.length, bw = Math.min(24, slot * 0.55);
  const total = days.reduce((n, d) => n + d.outages, 0);
  const summary = `${total} outage${total === 1 ? '' : 's'} over ${days.length} days · tap a day`;

  const readout = el(`<p class="chart-readout" aria-live="polite">${esc(summary)}</p>`);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'group', 'aria-label': 'Minutes down per day' });
  svg.append(svgEl('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: 'axis' }));
  const bars = [];
  let selected = -1;
  const select = (i) => {
    selected = selected === i ? -1 : i;
    bars.forEach((b, j) => b.classList.toggle('dim', selected !== -1 && j !== selected));
    if (selected === -1) { readout.textContent = summary; return; }
    const d = days[i];
    readout.textContent = `${fmtDate(d.date)} · ${d.outages ? `${d.outages} outage${d.outages === 1 ? '' : 's'}, ${fmtDuration(d.minutes * 60000)} down` : 'no outages'}`;
  };
  days.forEach((d, i) => {
    const cx = slot * i + slot / 2, x0 = cx - bw / 2;
    const h = d.minutes ? Math.max(4, (d.minutes / max) * (H - 12)) : 0;
    const r = Math.min(4, h / 2, bw / 2);
    const mark = h
      ? svgEl('path', { class: 'bar', d: `M${x0},${base} V${base - h + r} Q${x0},${base - h} ${x0 + r},${base - h} H${x0 + bw - r} Q${x0 + bw},${base - h} ${x0 + bw},${base - h + r} V${base} Z` })
      : svgEl('rect', { class: 'bar empty', x: x0, y: base - 2, width: bw, height: 2, rx: 1 });
    bars.push(mark);
    // The whole slot is the hit target, far bigger than a thin column.
    const hit = svgEl('rect', { x: slot * i, y: 0, width: slot, height: H, class: 'hit', tabindex: '0', role: 'button', 'data-act': `day-${d.date}`,
      'aria-label': `${fmtDate(d.date)}: ${d.outages} outages, ${d.minutes} minutes down` });
    hit.addEventListener('click', () => select(i));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); } });
    svg.append(mark, hit);
  });
  // Past ten days a weekday per column collides ("MonTueWed..."), so only
  // Mondays are labelled, with the date.
  const many = days.length > 10;
  const labels = el(`<div class="chart-days" style="grid-template-columns:repeat(${days.length},1fr)">${days.map((d) =>
    `<span>${esc(!many ? fmtWeekday(d.date) : fmtWeekday(d.date) === 'Mon' ? fmtShort(d.date) : '')}</span>`).join('')}</div>`);
  box.append(readout, svg, labels);
}

// Typical wait by hour of the day: one column per hour the ride usually
// runs, the current hour in full color. Tap a column for its number.
function hourBars(box, { typical }) {
  const hours = typical.map((w, h) => [h, w]).filter(([, w]) => w != null);
  const W = Math.max(160, contentWidth(box)), H = 90, base = H - 2;
  const max = niceMax(Math.max(10, ...hours.map(([, w]) => w)));
  const slot = W / hours.length, bw = Math.min(24, slot * 0.62);
  const nowHour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: dash?.park.timezone }).format(new Date()));
  const readout = el('<p class="chart-readout" aria-live="polite"></p>');
  const summary = () => {
    const cur = hours.find(([h]) => h === nowHour);
    return cur ? `Now (${fmtHour(nowHour)}) · usually ${cur[1]} min` : `Up to ${max} min · tap an hour`;
  };
  readout.textContent = summary();
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', role: 'group', 'aria-label': 'Typical wait by hour' });
  svg.append(svgEl('line', { x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5, class: 'axis' }));
  const bars = [];
  let selected = -1;
  const select = (i) => {
    selected = selected === i ? -1 : i;
    bars.forEach((b, j) => b.classList.toggle('dim', selected !== -1 && j !== selected));
    readout.textContent = selected === -1 ? summary() : `${fmtHour(hours[i][0])} · usually ${hours[i][1]} min`;
  };
  hours.forEach(([h, w], i) => {
    const x0 = slot * i + (slot - bw) / 2;
    const hgt = Math.max(3, (w / max) * (H - 10));
    const r = Math.min(4, hgt / 2, bw / 2);
    const bar = svgEl('path', { class: `bar ${h === nowHour ? '' : 'soft'}`, d: `M${x0},${base} V${base - hgt + r} Q${x0},${base - hgt} ${x0 + r},${base - hgt} H${x0 + bw - r} Q${x0 + bw},${base - hgt} ${x0 + bw},${base - hgt + r} V${base} Z` });
    bars.push(bar);
    const hit = svgEl('rect', { x: slot * i, y: 0, width: slot, height: H, class: 'hit', tabindex: '0', role: 'button', 'aria-label': `${fmtHour(h)}: usually ${w} minutes` });
    hit.addEventListener('click', () => select(i));
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); } });
    svg.append(bar, hit);
  });
  const every = hours.length > 12 ? 3 : 2;
  const labels = el(`<div class="chart-days" style="grid-template-columns:repeat(${hours.length},1fr)">${hours.map(([h], i) =>
    `<span>${i % every === 0 ? esc(fmtHour(h).replace(/\s/g, '')) : ''}</span>`).join('')}</div>`);
  box.append(readout, svg, labels);
}

// Today's crowd against a usual day, hour by hour: today in the accent, the
// usual day in gray, a legend naming both. Drag to read any hour.
function crowdChart(box, { today, typical, hour }) {
  const hrs = [];
  for (let h = 0; h < 24; h++) if (today[h] != null || typical[h] != null) hrs.push(h);
  if (hrs.length < 2) return;
  const h0 = hrs[0], h1 = hrs[hrs.length - 1];
  const W = Math.max(160, contentWidth(box)), H = 120, top = 6, bottom = 2, base = H - bottom;
  const max = niceMax(Math.max(10, ...hrs.map((h) => Math.max(today[h] ?? 0, typical[h] ?? 0))));
  const x = (h) => ((h - h0) / Math.max(1, h1 - h0)) * W;
  const y = (v) => top + (1 - v / max) * (H - top - bottom);
  const path = (vals) => {
    let d = '', pen = false;
    for (const h of hrs) {
      const v = vals[h];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(h).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  const readout = el('<p class="chart-readout" aria-live="polite"></p>');
  const say = (h, user) => {
    const t = today[h], u = typical[h];
    const value = t != null ? `${t} min${u != null ? `, usually ${u}` : ''}` : u != null ? `usually ${u} min` : 'no reading';
    readout.textContent = `${user ? fmtHour(h) : 'Now'} · ${value}`;
  };
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart', tabindex: '0', role: 'img',
    'aria-label': `Average big-ride wait by hour, today against a usual day` });
  svg.append(
    svgEl('line', { x1: 0, x2: W, y1: y(max), y2: y(max), class: 'grid' }),
    svgEl('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis' }),
    svgEl('path', { d: path(typical), class: 'line usual' }),
    svgEl('path', { d: path(today), class: 'line' }),
  );
  const cross = svgEl('line', { y1: top, y2: base, class: 'crosshair', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, class: 'dot-mark', visibility: 'hidden' });
  svg.append(cross, dot);
  const show = (h, user) => {
    say(h, user);
    cross.setAttribute('x1', x(h)); cross.setAttribute('x2', x(h));
    cross.setAttribute('visibility', user ? 'visible' : 'hidden');
    if (today[h] != null) { dot.setAttribute('cx', x(h)); dot.setAttribute('cy', y(today[h])); dot.setAttribute('visibility', 'visible'); }
    else dot.setAttribute('visibility', 'hidden');
  };
  const nowH = Math.min(h1, Math.max(h0, hour));
  show(nowH, false);
  const hourAt = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.round(h0 + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (h1 - h0));
  };
  let last = null;
  const scrub = (e) => { const h = hourAt(e); if (h !== last) { last = h; show(h, true); } };
  svg.addEventListener('pointerdown', (e) => { box._busy = true; try { svg.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } scrub(e); });
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || svg.hasPointerCapture(e.pointerId)) scrub(e); });
  for (const t of ['pointerup', 'pointercancel']) svg.addEventListener(t, (e) => { box._busy = false; if (e.pointerType !== 'mouse') { last = null; show(nowH, false); } });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { last = null; show(nowH, false); } });
  const legend = el(`<p class="chart-legend"><span><i class="lg-today"></i>Today</span><span><i class="lg-usual"></i>Usual day</span><span class="lg-max">up to ${max} min</span></p>`);
  const axis = el(`<div class="chart-x"><span>${fmtHour(h0)}</span><span>${fmtHour(h1)}</span></div>`);
  box.append(readout, svg, axis, legend);
}

const dateOnly = (d) => new Date(`${d}T12:00:00Z`);
const fmtDate = (d) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateOnly(d));
const fmtWeekday = (d) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short', timeZone: 'UTC' }).format(dateOnly(d));
const fmtShort = (d) => new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateOnly(d));

/* ---------- Pull to refresh ---------- */
// Only on touch, only from the very top, rubber-banded, and it springs home.
// Afterwards it says how it went, as Mail does under its title: "Updated
// just now", or that it couldn't. Works on the setup screen too, where it
// retries the park list.
// scrollTop: how far the area is scrolled (the window, or a page's body).
// blocked: when not to start (a sheet or a page is over it).
function pullToRefresh(area, ptr, onRefresh, { scrollTop = () => scrollY, blocked = () => sheet.isOpen || pages.depth } = {}) {
  const THRESHOLD = 64, HOLD = 52;
  let start = null, pull = 0, busy = false, anim = null, armed = false;
  const paint = (v) => {
    pull = v;
    area.style.transform = v ? `translateY(${v}px)` : '';
    ptr.style.opacity = String(Math.min(1, v / THRESHOLD));
    ptr.style.transform = `translateY(${v / 2 - 30}px) rotate(${v * 4}deg)`;
    ptr.classList.toggle('armed', v >= THRESHOLD);
    if (v >= THRESHOLD && !armed) haptic();
    armed = v >= THRESHOLD;
  };
  const settle = (to, done) => {
    anim?.stop();
    if (reducedMotion()) { paint(to); done?.(); return; }
    anim = spring({ from: pull, to, damping: 1, response: 0.3, onUpdate: paint, onDone: done });
  };
  area.addEventListener('touchstart', (e) => {
    if (busy || blocked() || scrollTop() > 0 || e.touches.length > 1) return;
    anim?.stop();
    start = e.touches[0].clientY;
  }, { passive: true });
  area.addEventListener('touchmove', (e) => {
    if (start == null) return;
    const dy = e.touches[0].clientY - start;
    if (dy <= 0) { if (pull) paint(0); return; }
    if (e.target.closest('.chart, input')) { start = null; return; }
    if (e.cancelable) e.preventDefault();
    paint(rubberband(dy, 480, 0.55));
  }, { passive: false });
  area.addEventListener('touchend', async () => {
    if (start == null) return;
    start = null;
    if (pull < THRESHOLD) { settle(0); return; }
    busy = true;
    ptr.classList.add('spinning');
    settle(HOLD);
    await onRefresh();
    ptr.classList.remove('spinning');
    settle(0, () => { busy = false; });
  });
}

// A few seconds of "Updated just now" (or why not) in the header's meta line.
let metaFlash = null; // { text, warn, until }
function flashMeta(text, warn = false) {
  metaFlash = { text, warn, until: Date.now() + 3000 };
  if (dash) renderHeader();
  setTimeout(() => { if (dash) renderHeader(); }, 3100);
}

// "Updated" is about the ride data, not the request: a slow park feed can
// answer a refresh with times from minutes ago.
pullToRefresh($('main'), $('#ptr'), async () => {
  await refresh();
  const age = dash?.lastPoll ? Date.now() - dash.lastPoll : null;
  if (offline) flashMeta(failure === 'offline' ? "Couldn't refresh: you're offline" : "Couldn't refresh: ParkAlert isn't responding", true);
  else if (age != null && age > 90_000) flashMeta(`Ride times ${fmtDuration(age)} old · the park's feed is slow`, true);
  else flashMeta('Updated just now');
});
pullToRefresh($('#setup .setup'), $('#setup-ptr'), async () => {
  parks = [];
  await renderSetupParks();
});

// The next background refresh: every 30 seconds while the park is open,
// every 5 minutes once it has closed for the day, and none while the app is
// out of sight (coming back refreshes at once).
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!tripCode) return;
  const closed = dash && alertState().kind === 'closed';
  refreshTimer = setTimeout(async () => {
    if (!document.hidden) await refresh();
    scheduleRefresh();
  }, closed ? 5 * 60_000 : REFRESH_MS);
}

/* ---------- Updates ---------- */
// A home-screen app can stay open for days. A new version downloads in the
// background (the service worker installs it whole), then waits: it takes
// over the moment the guest taps Reload, or when the app is next put away,
// so nothing changes under a finger mid-use.
let waitingWorker = null;
let reloading = false;
function offerUpdate(worker) {
  if (!worker || waitingWorker === worker) return;
  waitingWorker = worker;
  toast('A new version of ParkAlert is ready', { label: 'Reload', run: () => worker.postMessage('activate'), sticky: true, defer: true });
}
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install taking control isn't an update; a replacement is.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    if (reg.waiting && hadController) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      incoming?.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(incoming);
      });
    });
    // Look for a new version whenever the app comes back.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && waitingWorker) waitingWorker.postMessage('activate');
});
// The server names its version on every dashboard; a newer one means the
// worker should go and look now rather than at the next launch.
const PAGE_VERSION = document.querySelector('meta[name=parkalert-version]')?.content;
function noticeVersion(version) {
  if (!version || !PAGE_VERSION || PAGE_VERSION.startsWith('__') || version === PAGE_VERSION) return;
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
}

/* ---------- Data ---------- */
// The last dashboard is kept on the phone, so opening the app with no signal
// shows the last known rides, marked as such, instead of nothing.
const dashKey = (code) => `parkalert.dash.${code}`;
function rememberDash(code, d) {
  try { localStorage.setItem(dashKey(code), JSON.stringify(d)); } catch {}
}
function recallDash(code) {
  try { return JSON.parse(localStorage.getItem(dashKey(code))); } catch { return null; }
}

// Refreshes come from the timer, the tab coming back, going online, pull to
// refresh and saves. Only one runs at a time, so answers can't land out of
// order; asking during one queues a single follow-up that sees the latest
// state, and everyone waiting gets that.
let refreshing = null;
let refreshAgain = false;
function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await fetchDashboard();
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function fetchDashboard() {
  const code = tripCode;
  if (!code) return;
  try {
    const next = await api(`/trips/${code}/dashboard`);
    if (code !== tripCode) return; // switched trips while this was on its way
    confirmTrip(next.trip);
    noticeVersion(next.version);
    // A save still on its way wins over this snapshot's trip, which may
    // predate it; the save's own answer brings the trip up to date.
    if (savesPending && dash) next.trip = dash.trip;
    dash = next;
    offline = false;
    rememberDash(code, next);
  } catch (err) {
    if (code !== tripCode) return;
    if (err.status === 404) {
      try { localStorage.removeItem(dashKey(code)); } catch {}
      toast(`Trip ${code} no longer exists`);
      leaveTrip();
      return;
    }
    offline = true;
    failure = failureOf(err);
  }
  renderAll();
  // The page on top reloads its own detail (a ride's history, the park's week).
  if (!offline) pages.top?.load?.();
  if (dash && queuedTap) {
    const tap = queuedTap;
    queuedTap = null;
    tap();
  }
}

/* ---------- Screens & navigation ---------- */
function showSetup() {
  syncManifest();
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  document.body.classList.add('no-tabbar');
  document.title = 'ParkAlert';
  // The first screen is the app icon's own dusk.
  if (!$('#setup-art').firstChild) $('#setup-art').innerHTML = sceneSvg('dusk', 'Magic Kingdom', { align: 'xMidYMax' });
  renderSetupParks();
}

const onSetup = () => !$('#setup').classList.contains('hidden');

async function showApp({ firstRun = false } = {}) {
  syncManifest();
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  document.body.classList.remove('no-tabbar');
  for (const k of Object.keys(scrollByView)) delete scrollByView[k];
  switchView('down', { top: true });
  dash ??= recallDash(tripCode);
  renderAll();
  await refresh();
  scheduleRefresh();
  // A phone that already allows notifications joins the trip's alerts on
  // its own; that has to finish before deciding whether to ask.
  const joining = syncPhone();
  if (pendingOpen) openPending();
  else if (firstRun && dash) {
    await joining;
    if (!alertsReady()) openAlertSetup();
    else if (phone.id) {
      api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' }).catch(() => {});
      toast('Alerts are on for this phone. A test is on its way.');
    }
  }
}

// What a tapped push asked for: its ride's sheet, the hold, or the Down
// list. Opened once the dashboard is in, so the sheet has real data.
let pendingOpen = null;
function openPending() {
  if (!pendingOpen || !dash) return;
  const { ride, view } = pendingOpen;
  pendingOpen = null;
  switchView('down');
  if (ride) {
    // What the alert said beats a dashboard that may be half a minute old:
    // the page shows its skeleton until its own fresh detail arrives.
    if (dash.rides.some((r) => r.id === ride)) openRide(ride, { fresh: true });
    else toast("That ride isn't in today's ride list any more");
  } else if (view === 'hold' && dash.rides.some((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold')) {
    openHold();
  } else if (view === 'park') {
    openParkInfo();
  }
}

// Each tab keeps its own scroll position, as in any tab bar app; only
// tapping the tab you're already on goes back to the top.
const scrollByView = {};
function switchView(name, { top = false } = {}) {
  if (name !== view) scrollByView[view] = scrollY;
  if (name !== view && keepListed.size) { keepListed.clear(); if (dash) renderRides(); }
  view = name;
  document.body.classList.remove('view-down', 'view-rides', 'view-trip');
  document.body.classList.add(`view-${name}`);
  syncNavBar();
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  window.scrollTo({ top: top ? 0 : scrollByView[name] || 0 });
}

/* ---------- Wire up ---------- */
document.querySelectorAll('.tab').forEach((t) => {
  // Tapping the tab you're already on goes back to its top, as on iOS: out of
  // any page first, then up the list. Another tab closes pages and switches.
  t.onclick = () => {
    if (pages.depth) {
      pages.clear();
      if (view === t.dataset.view) return;
    }
    if (view === t.dataset.view) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    else switchView(t.dataset.view);
  };
});
$('#btn-locate').onclick = locate;
// Most family members arrive with a code: the button takes them to the field.
$('#btn-join-jump').onclick = () => {
  $('#join-form').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  $('#join-code').focus({ preventScroll: true });
};

const joinInput = $('#join-code');
const joinBtn = $('#join-form button');
const syncJoin = () => { joinBtn.disabled = joinInput.value.trim().length !== 6; };
// A pasted code with a space, an invite link or the whole invite message:
// keep just the code.
joinInput.addEventListener('input', () => {
  const code = extractTripCode(joinInput.value);
  if (code && joinInput.value !== code) joinInput.value = code;
  syncJoin();
});
syncJoin();
// Join feedback sits under the field being typed in, not up at the top of the page.
const JOIN_HINT = $('#join-note').textContent;
function joinNote(text, warn = false) {
  const n = $('#join-note');
  n.textContent = text;
  n.classList.toggle('warn', warn);
}
joinInput.addEventListener('input', () => joinNote(JOIN_HINT));
$('#join-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = joinInput.value.trim().toUpperCase();
  if (code.length !== 6) return;
  joinNote('Joining…');
  try {
    await api(`/trips/${code}`);
    setPendingInvite(null);
    joinNote(JOIN_HINT);
    joinInput.value = '';
    syncJoin();
    setTrip(code, { firstRun: true });
  } catch (err) {
    joinNote(err.status === 404
      ? `No trip with code ${code}. Check the letters and try again.`
      : err.status === 429
        ? 'Too many tries. Wait a minute, then try again.'
        : "Can't reach ParkAlert right now. Check your connection.", true);
  }
};

$('#btn-park').onclick = openParkInfo;
// Controls that act on the trip's data wait for it rather than failing.
// A tap on something that needs the trip's data before it has arrived (just
// opened, or a park switch loading) waits for it rather than being refused.
let queuedTap = null;
const withDash = (fn) => () => {
  if (dash) return fn();
  queuedTap = fn;
  toast(offline ? "Can't reach ParkAlert right now. This opens once it answers." : 'One moment…');
};
$('#btn-alerts').onclick = withDash(() => {
  const kind = alertState().kind;
  if (kind === 'setup') openAlertSetup();
  else if (kind === 'none') switchView('rides');
  else openPause();
});
$('#row-setup').onclick = withDash(openAlertSetup);
$('#row-pause').onclick = withDash(openPause);
$('#row-park').onclick = withDash(openPark);
$('#row-leave').onclick = openLeave;
function setNtfy(on) {
  haptic();
  save((t) => { t.ntfy = on; }, { ntfy: on }, () => toast(on ? 'Alerts go to the ntfy app too' : 'ntfy is off for this trip. Each alert comes once, from ParkAlert'));
}
$('#switch-ntfy').onclick = withDash(() => setNtfy(dash.trip.ntfy === false));
$('#switch-crowd').onclick = withDash(() => {
  haptic();
  const on = !dash.trip.crowdAlerts;
  save((t) => { t.crowdAlerts = on; }, { crowdAlerts: on }, () => toast(on ? "You'll get an alert when lines are building" : 'Lines-building alerts off'));
});
// Tests this phone: its own notifications, or the trip's ntfy topic. Testing
// every phone on the trip is in the setup sheet, behind a confirm.
$('#row-test').onclick = async () => {
  if (!alertsReady()) {
    toast("Alerts aren't set up on this phone yet", { label: 'Set up', run: withDash(openAlertSetup) });
    return;
  }
  const d = $('#test-detail');
  d.textContent = 'Sending…';
  try {
    if (phone.id) await api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' });
    else await api(`/trips/${tripCode}/test`, { method: 'POST', body: { to: 'ntfy' } });
    toast(phone.id ? 'Test sent to this phone' : 'Test sent through ntfy');
  } catch (err) {
    toast(testError(err));
  }
  d.textContent = '';
};
function testError(err) {
  return err.status === 429 ? 'That was a lot of tests. Try again in a few minutes.' : "Couldn't send the test. Try again in a moment.";
}

function openTestEveryone() {
  const content = el(`<div>
    ${sheetHead('Test every phone?', `Every phone that gets alerts for trip <strong>${esc(tripCode)}</strong> gets a test notification now.`)}
    <div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="send">${icon('send')}<span>Send to every phone</span></button>
      <button class="btn-secondary pressable" type="button" data-act="cancel">Cancel</button>
    </div>
  </div>`);
  content.querySelector('[data-act=send]').onclick = async () => {
    sheet.close();
    try {
      await api(`/trips/${tripCode}/test`, { method: 'POST' });
      toast('Test sent to every phone on this trip');
    } catch (err) {
      toast(testError(err));
    }
  };
  content.querySelector('[data-act=cancel]').onclick = () => sheet.close();
  sheet.open(content);
}

$('#btn-share').onclick = async () => {
  const url = `${location.origin}/?join=${tripCode}`;
  const text = `Join my ParkAlert trip${dash ? ` at ${parkLabel(dash.park.name)}` : ''}. Code ${tripCode}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'ParkAlert', text, url });
      return;
    } catch (err) {
      // Cancelled: nothing to do. Anything else (not allowed here, a
      // broken share target) falls back to copying the link.
      if (err?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Invite link copied');
  } catch {
    toast(`Share this code: ${tripCode}`);
  }
};

$('#ride-search').addEventListener('input', () => { keepListed.clear(); if (dash) renderRides(); });
// Return, or starting to scroll the results, puts the keyboard away, as in
// the Settings and Mail search fields. The search itself stays.
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#ride-search').blur();
});
addEventListener('touchmove', () => {
  if (document.activeElement === $('#ride-search')) $('#ride-search').blur();
}, { passive: true });

/* ---------- Install ---------- */
// Chrome (Android, desktop) offers its own install prompt, which it hands us
// to show when asked; iPhone Safari has none, so the sheet says where the
// menu item is. Nothing shows once the app runs from the home screen.
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;
function syncInstall() {
  $('#install-group').classList.toggle('hidden', installed() || !(installPrompt || platform === 'ios'));
}
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  syncInstall();
});
addEventListener('appinstalled', () => {
  installPrompt = null;
  syncInstall();
});
$('#row-install').onclick = async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    syncInstall();
    return;
  }
  // The Home Screen app keeps its own storage, apart from Safari's, so it
  // starts from this address: the trip rides along in it while this is open.
  const code = tripCode;
  if (code) history.replaceState(history.state, '', `/?trip=${code}`);
  sheet.open(el(`<div>
    ${sheetHead('Add to Home Screen', `Needed for alerts on iPhone: ParkAlert can only notify you from its own Home Screen icon.${code ? ` It opens on trip <strong>${esc(code)}</strong>.` : ''}`)}
    <ol class="steps">
      <li class="step"><h3>Tap Share</h3><p>The ${icon('share', 'inline-icon')} button in Safari's toolbar. With Safari's compact tab bar, tap the ··· button first, then Share.</p></li>
      <li class="step"><h3>Tap Add to Home Screen</h3><p>Scroll down the list if you don't see it, then tap Add.</p></li>
      <li class="step"><h3>Open ParkAlert from its icon</h3><p>Then turn on notifications there.</p></li>
    </ol>
    <div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">Done</button></div>
  </div>`), { onClose: () => { if (location.search) history.replaceState(history.state, '', '/'); } });
  $('#sheet-body [data-act=done]').onclick = () => sheet.close();
};
syncInstall();

// Past the large title, the compact bar shows the screen's name.
const titleEl = () => (view === 'down' ? $('#status-title') : $(`#view-${view} .view-title`));
const syncCompact = () => document.body.classList.toggle('compact', !onSetup() && (titleEl()?.getBoundingClientRect().bottom ?? 1) < $('#nav-bar').offsetHeight);
addEventListener('scroll', syncCompact, { passive: true });
$('#nav-bar').onclick = () => window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });

// Coming back (to the tab, or online) catches up whichever screen is showing.
const resume = () => {
  if (pendingInvite()) tryInvite();
  return onSetup() ? (!parks.length && renderSetupParks()) : refresh();
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
addEventListener('online', resume);
addEventListener('offline', () => { offline = true; failure = 'offline'; if (dash) renderHeader(); });

// Keep elapsed times honest between refreshes.
setInterval(() => {
  if (!dash || document.hidden) return;
  renderHeader();
  renderDown();
  pages.refresh();
}, TICK_MS);

/* ---------- Invites ---------- */
// An invite is kept until it has been answered, so one opened with no signal
// (at the gate, in the parking lot) is still there once the phone
// reconnects, and its code is waiting in the join field meanwhile.
const INVITE_KEY = 'parkalert.pendingInvite';
const pendingInvite = () => { try { return localStorage.getItem(INVITE_KEY); } catch { return null; } };
function setPendingInvite(code) {
  try { code ? localStorage.setItem(INVITE_KEY, code) : localStorage.removeItem(INVITE_KEY); } catch {}
  if (code) { joinInput.value = code; syncJoin(); }
}

let inviteBusy = false;
async function tryInvite() {
  const code = pendingInvite();
  if (!code || inviteBusy) return false;
  inviteBusy = true;
  try {
    const { trip } = await api(`/trips/${code}`);
    setPendingInvite(null);
    joinInput.value = '';
    syncJoin();
    if (code === tripCode) {
      if (!onSetup()) toast(`You're already on trip ${code}`);
      else showApp();
      return true;
    }
    if (!tripCode) {
      setTrip(code, { firstRun: true });
      return true;
    }
    // On another trip already: ask first. One tap on a link should never
    // quietly swap the trip this phone is on.
    if (onSetup()) showApp();
    await loadParks().catch(() => {});
    confirmInvite(code, trip);
    return true;
  } catch (err) {
    if (err.status === 404) {
      setPendingInvite(null);
      joinInput.value = '';
      syncJoin();
      toast(`Invite code ${code} wasn't found`);
    } else {
      toast(`Couldn't open the invite to trip ${code} yet. It will try again when you're back online.`);
    }
    return false;
  } finally {
    inviteBusy = false;
  }
}

function confirmInvite(code, trip) {
  const park = parks.find((p) => p.id === trip.parkId);
  const content = el(`<div>
    ${sheetHead(`Join trip ${code}?`, `${park ? `It's at ${esc(parkLabel(park.name))}. ` : ''}This phone leaves trip <strong>${esc(tripCode)}</strong>, which keeps going for anyone else on it. You can rejoin it with that code.`)}
    <div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="join">Join trip ${esc(code)}</button>
      <button class="btn-secondary pressable" type="button" data-act="stay">Stay on ${esc(tripCode)}</button>
    </div>
  </div>`);
  content.querySelector('[data-act=join]').onclick = () => {
    sheet.close();
    setTrip(code, { firstRun: true });
  };
  content.querySelector('[data-act=stay]').onclick = () => sheet.close();
  sheet.open(content);
}

/* ---------- Boot ---------- */
(async function boot() {
  let shown = false;
  const params = new URLSearchParams(location.search);
  const joinParam = params.get('join');
  // A tapped push: ?trip=CODE and a ride or view to open. On iPhone the link
  // may open in Safari, which has its own storage and no saved trip, so the
  // code in the link decides which trip to show.
  const tripParam = params.get('trip');
  if (params.get('ride') || params.get('view')) pendingOpen = { ride: params.get('ride'), view: params.get('view') };
  // A page's own address (reloaded, or opened from a bookmark): open it
  // over the app, with the app as the entry Back returns to.
  const route = location.pathname.match(/^\/(ride)\/([^/]+)$|^\/(park|hold)$/);
  if (route) pendingOpen = route[1] ? { ride: decodeURIComponent(route[2]) } : { view: route[3] };
  if (location.pathname !== '/') history.replaceState(null, '', '/' + location.search);
  if (tripParam && !joinParam) {
    history.replaceState(null, '', '/');
    const code = tripParam.toUpperCase();
    if (code !== tripCode) {
      const previous = tripCode;
      // A phone with no trip of its own (Safari's storage, apart from the Home
      // Screen app's) has nothing to lose: open the linked trip at once, and
      // the first refresh finds it if it is gone.
      if (!previous) {
        setTrip(code);
        return;
      }
      // Check the linked trip still exists before leaving this phone's own
      // trip for it; switching first and finding it gone would drop both.
      // Meanwhile this phone's own trip shows from its saved copy. Offline,
      // the check can't run, so trust the link as before.
      const toOpen = pendingOpen;
      pendingOpen = null;
      showApp();
      shown = true;
      let missing = false;
      try { await api(`/trips/${code}`); } catch (err) { missing = err.status === 404; }
      if (!missing) {
        pendingOpen = toOpen;
        setTrip(code);
        toast(`Showing trip ${code}`, { label: 'Undo', run: () => setTrip(previous) });
        return;
      }
      toast(`That alert was for trip ${code}, which no longer exists`);
    }
  }
  if (joinParam) {
    history.replaceState(null, '', '/');
    setPendingInvite(joinParam.toUpperCase());
    if (await tryInvite()) return;
  }

  // A saved trip opens straight away, online or not. A trip that no longer
  // exists is caught by the first refresh, which says so and leaves it.
  if (!shown) {
    if (tripCode) showApp();
    else {
      showSetup();
      // The Home Screen app on iPhone doesn't see a trip started in Safari.
      if (platform === 'ios' && installed() && !joinParam && !pendingInvite()) {
        setupStatus("A trip started in Safari doesn't carry over to the Home Screen app. Enter its code below to open it here.");
        $('#join-code').focus();
      }
    }
  }
  // An invite opened offline earlier, still waiting.
  if (!joinParam && pendingInvite()) {
    setPendingInvite(pendingInvite());
    if (navigator.onLine !== false) tryInvite();
  }
})();

