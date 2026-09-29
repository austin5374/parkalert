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

// Times are shown in the park's own zone: planning from home should still say 3:30 PM for 3:30 PM at the park.
// And in the same format as the pushes (server/poller.js), so an alert and
// the card it opens never read "2:10 PM" and "14:10" for one moment.
const LOCALE = 'en-US';
function fmtTime(ts) {
  if (ts == null) return '';
  return new Intl.DateTimeFormat(LOCALE, {
    hour: 'numeric', minute: '2-digit', timeZone: dash?.park.timezone || undefined,
  }).format(new Date(ts));
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
function save(apply, body, afterSave) {
  const before = structuredClone(dash.trip);
  apply(dash.trip);
  renderAll();
  savesPending++;
  const run = saveChain.then(async () => {
    try {
      const { trip } = await patchTrip(body);
      confirmTrip(trip);
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
  if (toastNow?.action && !action) {
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
  $('#toast').classList.remove('show');
  toastNow = null;
  const next = toastQueue.shift();
  if (next) setTimeout(() => showToast(next), 250);
}

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
const backStack = []; // { onBack, done }
let quietPops = 0;
function addBack(onBack, url) {
  const entry = { onBack, done: false };
  backStack.push(entry);
  history.pushState({ parkalert: backStack.length }, '', url || location.pathname + location.search);
  return entry;
}
function leave(entry, closeNow) {
  if (!entry || entry.done) return;
  entry.done = true;
  const i = backStack.indexOf(entry);
  if (i !== -1) backStack.splice(i, 1);
  closeNow?.();
  quietPops++;
  history.back();
}
addEventListener('popstate', () => {
  // Our own history.back()/go(): the layers are already closed and their
  // entries already off backStack.
  if (quietPops) {
    quietPops--;
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
    panel.focus({ preventScroll: true });
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
  let anim = null;
  function animate(p, to, velocity = 0, done) {
    anim?.stop();
    if (reducedMotion() || document.hidden) { paint(p, to); done?.(); return; }
    anim = spring({ from: p.x, to, velocity, damping: 1, response: 0.38, onUpdate: (x) => paint(p, x), onDone: done });
  }

  function syncInert() {
    $('#app').inert = stack.length > 0;
    stack.forEach((p, i) => { p.el.inert = i < stack.length - 1; });
    host.classList.toggle('hidden', !stack.length);
  }

  function draw(p) {
    if (!p.el.isConnected) return;
    morph(p.body, `<h1 class="page-title large-title" data-key="page-title">${esc(p.title())}</h1>${p.render()}`);
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
    p.el.querySelector('.page-back').focus({ preventScroll: true });
    p.load?.();
    return p;
  }

  function remove(p) {
    p.el.remove();
    stack.splice(stack.indexOf(p), 1);
    const below = stack[stack.length - 1];
    if (below) below.el.style.transform = '';
    else shade.style.opacity = '0';
    syncInert();
    p.returnFocus?.focus?.({ preventScroll: true });
  }
  function slideOut(p, velocity = 0) {
    animate(p, width(), velocity, () => remove(p));
  }
  function back() {
    const p = stack[stack.length - 1];
    if (p) leave(p.entry, () => slideOut(p));
  }

  // Swipe back from the left edge, 1:1 with the finger; release past the
  // middle (or with a flick) completes it, otherwise it springs home.
  let swipe = null;
  host.addEventListener('touchstart', (e) => {
    const p = stack[stack.length - 1];
    const t = e.touches[0];
    swipe = p && e.touches.length === 1 && t.clientX < 28
      ? { p, x0: t.clientX, y0: t.clientY, mode: null, samples: [{ t: e.timeStamp, v: 0 }] }
      : null;
    if (swipe) anim?.stop();
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
      leave(p.entry, () => slideOut(p, v));
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
      const n = stack.length;
      for (const p of [...stack]) { p.entry.done = true; remove(p); }
      backStack.splice(backStack.length - n, n);
      quietPops++;
      history.go(-n);
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
        setupStatus(`You're at ${parkLabel(park.name)}.`);
        startTrip(park.id);
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

// Leaving a trip takes this phone off its alerts.
async function forgetPhone(code) {
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

// The park name is the screen's title and the way into the park sheet, so it
// shrinks to fit beside the alerts pill ("Magic Kin…" told nobody anything),
// down to a floor, and past that takes a second line. Relative to the
// computed size, so the reader's text size setting still counts.
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
  if (px > 0) document.documentElement.style.fontSize = `${((px / 17) * 100).toFixed(2)}%`;
}
syncDynamicType();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  syncDynamicType();
  if (dash) renderHeader();
});

function syncTypeSize() {
  const big = parseFloat(getComputedStyle(document.documentElement).fontSize) >= 24;
  document.documentElement.classList.toggle('ax-type', big);
  return big;
}
syncTypeSize();
addEventListener('resize', syncTypeSize);

function fitTitle() {
  if (syncTypeSize()) {
    // On its own line it wraps at spaces, and shrinks only as far as needed
    // for its longest word to fit, so "Kingdom" never breaks as "Kingdo-m".
    const h = $('#park-name');
    h.style.fontSize = '';
    h.classList.add('wrap', 'ax');
    const max = parseFloat(getComputedStyle(h).fontSize);
    for (let size = max; h.scrollWidth > h.clientWidth && size > max * 0.5; ) {
      size -= 1;
      h.style.fontSize = `${size}px`;
    }
    return;
  }
  $('#park-name').classList.remove('ax');
  const h = $('#park-name');
  h.style.fontSize = '';
  h.classList.remove('wrap');
  const max = parseFloat(getComputedStyle(h).fontSize);
  const floor = max * 0.62;
  for (let size = max; h.scrollWidth > h.clientWidth && size > floor; ) {
    size = Math.max(floor, size - 1);
    h.style.fontSize = `${size}px`;
  }
  if (h.scrollWidth > h.clientWidth) h.classList.add('wrap');
}
addEventListener('resize', () => { lastFit = null; if (dash) renderHeader(); });

let lastFit = null;
let lastBadge = null;
function renderHeader() {
  $('#park-name').textContent = parkLabel(dash.park.name);
  document.title = `${parkLabel(dash.park.name)} · ParkAlert`;

  const meta = $('#park-meta');
  // Old by the data's age alone: one failed poll is not an outage (the
  // server polls every minute, and says nothing is wrong for 3).
  const stale = !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS;
  const flash = metaFlash && Date.now() < metaFlash.until ? metaFlash : null;
  meta.textContent = flash ? flash.text : offline
    ? `${FAILURE_META[failure]} · as of ${fmtUntil(dash.lastPoll)}`
    : stale
      ? !dash.lastPoll ? 'Waiting for the ride feed'
        : dash.lastError ? `Ride feed not answering · as of ${fmtUntil(dash.lastPoll)}`
          : `Ride times may be out of date · ${fmtDuration(Date.now() - dash.lastPoll)} old`
      : hoursText();
  meta.classList.toggle('warn', flash ? flash.warn : offline || stale);

  const st = alertState();
  const [glyph, label] = {
    on: ['bell', 'Alerts on'],
    paused: ['pause', 'Paused'],
    closed: ['moon', 'Park closed'],
    setup: ['bell-off', 'Set up alerts'],
    none: ['bell-off', 'No rides on'],
  }[st.kind];
  const pill = $('#btn-alerts');
  pill.className = `pill pressable ${st.kind}`;
  morph(pill, `${icon(glyph)}<span>${label}</span>`);
  // Re-fit only when the title, the pill (whose label sets the room left)
  // or the width changed: fitting measures the text step by step.
  const fitKey = `${dash.park.name}|${label}|${innerWidth}|${getComputedStyle(document.documentElement).fontSize}`;
  if (fitKey !== lastFit) {
    lastFit = fitKey;
    fitTitle();
  }
  pill.setAttribute('aria-label', st.kind === 'paused' && st.until ? `Alerts paused until ${fmtUntil(st.until)}` : label);

  const down = dash.rides.filter((r) => r.status === 'DOWN' && isFollowing(r.id)).length;
  const badge = $('#down-badge');
  badge.textContent = down;
  badge.classList.toggle('hidden', !down);
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

// Elapsed in red, and the usual reopening window shaded just ahead of it.
// With no upper end to the range, only its start is marked: an invented
// "twice that" would claim more than the estimate does.
function timeline(r) {
  const w = r.outlook?.window;
  if (!w || w.lo == null) return '';
  const spent = (Date.now() - r.downSince) / 60000;
  const hi = w.hi ?? w.lo;
  const end = (spent + hi) * 1.12 || 1;
  const pct = (m) => `${Math.min(100, (m / end) * 100).toFixed(1)}%`;
  return `<div class="timeline" aria-hidden="true">
    <span class="window" style="left:${pct(spent + w.lo)};width:${pct(Math.max(hi - w.lo, end * 0.015))}"></span>
    <span class="spent" style="width:${pct(spent)}"></span>
  </div>`;
}

// The range as clock times, which is what people plan around, said one way
// everywhere: "Often back 8:05 to 8:27 AM", or "around 8:05 AM" with no
// upper end. The start never moves earlier than one already shown for the
// same outage: a range read later can shift back a little as the curve
// updates, and "back by 8:38" after "8:40" reads as a mistake.
const shownFrom = new Map(); // "rideId|downSince" -> epoch ms
function backClock(r, o) {
  const w = o?.window;
  if (!w || w.lo == null) return '';
  const key = `${r.id}|${r.downSince}`;
  const lo = Math.max(Date.now() + w.lo * 60000, shownFrom.get(key) ?? 0);
  shownFrom.set(key, lo);
  if (shownFrom.size > 200) shownFrom.delete(shownFrom.keys().next().value);
  const hi = w.hi == null ? null : Math.max(lo, Date.now() + w.hi * 60000);
  return `Often back ${fmtSpan(lo, hi)}`;
}

// "8:05 to 8:27 AM", "11:50 AM to 12:10 PM", or "around 8:05 AM".
function fmtSpan(a, b) {
  const A = fmtTime(a), B = b == null ? A : fmtTime(b);
  if (A === B) return `around ${A}`;
  const [ta, pa] = A.split(/\s(?=[AP]M$)/);
  const [, pb] = B.split(/\s(?=[AP]M$)/);
  return `${pa && pa === pb ? ta : A} to ${B}`;
}

// "7 PM": an hour on the park's clock.
function fmtHour(h) {
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

// How busy the park is right now: the big rides' waits against their usual
// for this hour, as a sentence and the numbers behind it. Paused during a
// hold and just after, when waits say more about the hold than the crowd.
// Old data is greyed and dated, like the rest of the screen.
function crowdRowHtml() {
  const c = dash.crowd;
  if (!c || alertState().kind === 'closed') return '';
  const stale = offline || !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS;
  const [title, detail] = c.paused === 'hold'
    ? ['Crowd level paused', "Waits during a hold and just after it don't show how busy the park is"]
    : c.paused
      ? ['Crowd level paused', 'Too few of the big rides are posting waits right now']
      : [c.label, `Big rides average about ${c.index} min, usually ${c.typical} at ${fmtHour(c.hour)}`];
  const asOf = stale && dash.lastPoll ? ` · as of ${fmtTime(dash.lastPoll)}` : '';
  return `<div class="group crowd-group" data-key="crowd"><button class="row crowd-row pressable${stale ? ' stale' : ''}" type="button" data-act="open-park"
      aria-label="Crowds: ${esc(title)}. ${esc(detail + asOf)}. Show park">
    <span class="row-label">
      <span class="crowd-word">${esc(title)}</span>
      <small>${esc(detail + asOf)}</small>
    </span>
    ${icon('chevron', 'chevron')}
  </button></div>`;
}

// The chance a ride is back within 15, 30 and 60 minutes, drawn as three
// nested fills on one track, darkest for soonest: a long dark bar means
// likely soon. The numbers sit in a legend beneath, so nothing rests on
// shade alone.
// A few dozen outages can't make anything certain, so the ends read ">95%"
// and "<5%", never 100% or 0%. A key for a share that small is drawn hollow,
// as its fill on the bar is.
function chanceHtml(o) {
  const c = o?.chance;
  if (!c) return '';
  const pct = (p) => Math.round(p * 100);
  const say = (p) => (p >= 0.955 ? '>95%' : p < 0.045 ? '<5%' : `${pct(p)}%`);
  const key = (m, label) => `<span><i class="k${m}${c[m] < 0.045 ? ' none' : ''}"></i>${label} ${say(c[m])}</span>`;
  return `<div class="chance" aria-hidden="true">
      <span class="c60" style="width:${pct(c[60])}%"></span>
      <span class="c30" style="width:${pct(c[30])}%"></span>
      <span class="c15" style="width:${pct(c[15])}%"></span>
    </div>
    <p class="chance-key"><span class="chance-label">Chance it's back within</span>${key(15, '15 min')}${key(30, '30 min')}${key(60, '1 hr')}</p>`;
}

function adviceHtml(o, cls = 'card-advice') {
  const a = o?.advice;
  if (!a) return o?.text ? `<p class="card-outlook">${esc(o.text)}</p>` : '';
  return `<p class="${cls} advice-${a.key}"><strong>${esc(a.verdict)}.</strong> ${esc(a.detail)}</p>`;
}


// How long a ride has been down, as far as anyone knows: exact, or at
// least this long when it went down unseen (in a gap in the feed, or before
// ParkAlert first looked), or nothing claimed under a minute of that.
function downFor(r) {
  const ms = Date.now() - r.downSince;
  if (r.downExact !== false) return fmtDuration(ms);
  return ms >= 60_000 ? `${fmtDuration(ms)}+` : '';
}

// When it went down, as far as anyone knows. A late opening is when it was
// noticed: nobody knows it "went down", it just never opened.
function downWhen(r) {
  if (r.outlook?.kind === 'opening') return `Late to open · noticed ${fmtTime(r.downSince)}`;
  if (r.downExact !== false) return `Down since ${fmtTime(r.downSince)}`;
  if (r.downAfter != null) return `Went down between ${fmtTime(r.downAfter)} and ${fmtTime(r.downSince)}`;
  return `Down since before ${fmtTime(r.downSince)}`;
}

function downCard(r) {
  const o = r.outlook || {};
  const following = isFollowing(r.id);
  const since = downWhen(r);
  const foot = [
    basisLine(o),
    following ? '' : 'Alerts off',
  ].filter(Boolean).join(' · ');
  return `
    <article class="card pressable ${following ? '' : 'unfollowed'}" data-ride="${esc(r.id)}" role="button" tabindex="0"
             aria-label="${esc(r.name)}, ${esc(since)}${downFor(r) ? `, ${esc(downFor(r))}` : ''}. Show details">
      <div class="card-top">
        <h3 class="card-title">${esc(r.name)}</h3>
        <span class="elapsed">${downFor(r)}</span>
        ${icon('chevron', 'chevron')}
      </div>
      <p class="card-sub">${since}</p>
      ${adviceHtml(o)}
      ${o.chance ? chanceHtml(o) : timeline(r)}
      ${backClock(r, o) ? `<p class="card-clock">${esc(backClock(r, o))}</p>` : ''}
      ${foot ? `<p class="card-foot">${esc(foot)}</p>` : ''}
    </article>`;
}

const setupRowHtml = () => `
  <div class="group" style="margin-top:1.2rem" data-key="setup-row"><button class="row pressable" type="button" data-act="setup-alerts">
    ${icon('bell', 'row-icon tint-accent')}
    <span class="row-label">Set up alerts on this phone</span>
    ${icon('chevron', 'chevron')}
  </button></div>`;

function renderDown() {
  morph($('#down-list'), downHtml());
  renderRecent(new Set(dash.rides.filter((r) => r.status === 'DOWN' && r.downSince).map((r) => r.id)));
}

function downHtml() {
  const down = dash.rides
    .filter((r) => r.status === 'DOWN' && r.downSince && !r.other)
    .sort((a, b) => (isFollowing(b.id) - isFollowing(a.id)) || b.downSince - a.downSince);
  const parts = [crowdRowHtml()];
  if (!dash.lastPoll) {
    // No ride data yet is not the same as nothing being down.
    parts.push(`
      <div class="empty offline" data-key="empty">
        ${icon('wifi-off')}
        <h2 class="title-2">No ride data yet</h2>
        <p>The park's ride feed isn't answering right now. This updates on its own.</p>
      </div>`);
  } else if (!down.length) {
    // Only a live, open park gets the green check. Closed, not open yet,
    // and old or offline data each say what they are.
    const open = Date.parse(dash.park.openingTime || '');
    const stale = offline || Date.now() - dash.lastPoll > STALE_MS;
    // What the rides are doing, not just that none is down: every ride
    // closed early must never read as "Everything's running".
    const c = dash.park.counts || rideCountsOf(dash.rides);
    const running = c.total ? c.operating / c.total : 1;
    const [glyph, cls, title, text] =
      dash.park.status === 'closedEarly' ? ['moon', 'closed', 'Most rides are closed', `Only ${c.operating} of ${c.total} are running, so the park seems to have closed early. Alerts are off until rides reopen.`]
        : alertState().kind === 'closed' ? ['moon', 'closed', 'Park closed', 'Closed for the day. Alerts start again when it opens.']
          : open && Date.now() < open ? ['moon', 'closed', 'Not open yet', `Opens at ${fmtTime(open)}. You'll get an alert if a ride with alerts on is late to open.`]
            : stale ? ['check-circle', 'offline', `Nothing was down as of ${fmtTime(dash.lastPoll)}`, staleText()]
              : running >= 0.6 ? ['check-circle', '', "Everything's running", "You'll get an alert when a ride with alerts on goes down."]
                : ['check-circle', '', 'Nothing is down', `${c.operating} of ${c.total} rides are running; the rest are closed. You'll get an alert when a ride with alerts on goes down.`];
    parts.push(`
      <div class="empty ${cls}" data-key="empty">
        ${icon(glyph)}
        <h2 class="title-2">${esc(title)}</h2>
        <p>${esc(text)}</p>
      </div>`);
  } else {
    const holds = down.filter((r) => r.outlook?.kind === 'hold');
    const rest = down.filter((r) => r.outlook?.kind !== 'hold');
    if (holds.length) {
      // One card for the hold, not a card per ride: in a storm that was
      // thirty identical cards before the breakdowns below. The rides are
      // rows inside it, each opening its own page.
      const first = holds.reduce((a, r) => (r.downSince < a.downSince ? r : a));
      const o = first.outlook || {};
      parts.push(`
        <div class="cards" data-key="hold"><div class="card hold-card">
          <button class="hold-header pressable" type="button" data-act="open-hold">${icon('bolt')}<span>Park-wide hold · ${holds.length} ride${holds.length === 1 ? '' : 's'}</span>${icon('chevron', 'chevron')}</button>
          <p class="card-sub">${esc([downWhen(first).replace(/^Down s/, 'S'), downFor(first)].filter(Boolean).join(' · '))}</p>
          ${adviceHtml(o)}
          ${o.chance ? chanceHtml(o) : timeline(first)}
          ${o.text && o.advice ? `<p class="card-clock">${esc(o.text)}</p>` : ''}
          ${basisLine(o) ? `<p class="card-foot">${esc(basisLine(o))}</p>` : ''}
          <div class="hold-rides">${holds.map((r) => `
            <button class="hold-ride pressable ${isFollowing(r.id) ? '' : 'unfollowed'}" type="button" data-ride="${esc(r.id)}">
              <span class="row-label">${esc(r.name)}</span>
              <span class="row-detail">${downFor(r)}</span>
              ${icon('chevron', 'chevron')}
            </button>`).join('')}</div>
        </div></div>`);
    }
    if (rest.length) {
      if (holds.length) parts.push('<h2 class="section-label" data-key="down-label">Down</h2>');
      parts.push(`<div class="cards" data-key="down">${rest.map(downCard).join('')}</div>`);
    }
  }
  if (!alertsReady()) parts.push(setupRowHtml());
  return parts.join('');
}

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

// Rides that came back, or gave up and closed, recently: so an alert opened
// late still makes sense. Each ride's latest word only.
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
  const parts = [];
  if (closed.length) {
    parts.push(`<h2 class="section-label" data-key="closed-label">Closed after an outage</h2>
      <div class="group" data-key="closed">${closed.map((e) => `
      <button class="row recent-row pressable" type="button" data-ride="${esc(e.id)}">
        ${icon('moon', 'row-icon tint-orange')}
        <span class="row-label">${esc(e.name)}<small>Closed at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)} down` : ''}</small></span>
        ${icon('chevron', 'chevron')}
      </button>`).join('')}</div>`);
  }
  if (ups.length) {
    parts.push(`<h2 class="section-label" data-key="up-label">Back up recently</h2>
      <div class="group" data-key="up">${ups.map((e) => `
      <button class="row recent-row pressable" type="button" data-ride="${esc(e.id)}">
        ${icon('arrow-up', 'row-icon tint-green')}
        <span class="row-label">${esc(e.name)}<small>${e.late
          ? `Opened at ${fmtTime(e.at)}`
          : `Back at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}`}</small></span>
        ${icon('chevron', 'chevron')}
      </button>`).join('')}</div>`);
  }
  parts.push(shortWaitsHtml());
  morph($('#recent-block'), parts.join(''));
}

// Rides worth heading for right now: running with a wait well under their
// usual for this hour, best first (as the lines-building alert picks them).
// A carousel's 5 minutes isn't news; a headliner at half its usual is. Only
// while the park is open and the data is fresh.
function shortWaitsHtml() {
  const st = alertState();
  const stale = offline || !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS;
  if (st.kind === 'closed' || stale) return '';
  const quick = dash.rides
    .filter((r) => !r.other && r.status === 'OPERATING' && r.waitTime != null && r.usual >= 15 && r.waitTime <= r.usual * 0.7)
    .sort((a, b) => a.waitTime / a.usual - b.waitTime / b.usual || b.usual - a.usual)
    .slice(0, 4);
  if (!quick.length) return '';
  return `<h2 class="section-label" data-key="short-label">Shorter than usual right now</h2>
    <div class="group" data-key="short">${quick.map((r) => `
    <button class="row recent-row pressable" type="button" data-ride="${esc(r.id)}">
      <span class="row-label">${esc(r.name)}<small>Usually ${r.usual} min at this time${queueTags(r).length ? ` · ${esc(queueTags(r).join(' · '))}` : ''}</small></span>
      <span class="row-detail">${r.waitTime} min${trendHtml(r)}</span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`;
}

/* ---------- Rides ---------- */
// A small marker in the Rides list for a ride with a wait alert still to go off.
function waitBadge(r) {
  const a = dash.trip.waitAlerts?.[r.id];
  return a && !a.sentAt ? `<span class="wait-badge" title="Wait alert">${icon('timer')}≤${a.max}</span>` : '';
}

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

// A growing or shrinking line, in the list: an arrow with words for
// screen readers. Waits that barely moved show nothing.
function trendHtml(r) {
  const t = r.status === 'OPERATING' && r.trend;
  if (!t) return '';
  const words = t.direction === 'up' ? `up ${t.change} min in the last half hour` : `down ${-t.change} min in the last half hour`;
  return `<span class="trend ${t.direction}" title="${words}"><span class="vh">, ${words}</span>${icon(`trend-${t.direction}`)}</span>`;
}

function rideMeta(r) {
  if (r.status === 'OPERATING') return `Open · ${r.waitTime != null ? `${r.waitTime} min wait` : 'no posted wait'}`;
  if (r.status === 'DOWN') return `Down ${r.downSince ? downFor(r) : ''}`.trim();
  if (r.status === 'REFURBISHMENT') return 'Refurbishment';
  return 'Closed';
}

// A–Z, or shortest wait first: what's quickest to ride right now. Running
// rides by posted wait, then down ones, then closed. Remembered per phone.
let rideSort = (() => { try { return localStorage.getItem('parkalert.rideSort') || 'name'; } catch { return 'name'; } })();
const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name));
// Rides posting a wait come first, shortest first: that's what someone
// sorting by wait is after. Attractions that post no wait (shows, walk-
// throughs, a train) follow, then rides that are down, then closed ones.
function rideOrder(a, b) {
  if (rideSort !== 'wait') return byName(a, b);
  const rank = (r) => (r.status === 'OPERATING' ? (r.waitTime != null ? 0 : 1) : r.status === 'DOWN' ? 2 : 3);
  return rank(a) - rank(b) || (a.waitTime ?? 0) - (b.waitTime ?? 0) || byName(a, b);
}

// Which rides to list: all, open ones, down ones, or the ones you get
// alerts about. Remembered per phone, like the sort.
let rideFilter = (() => { try { return localStorage.getItem('parkalert.rideFilter') || 'all'; } catch { return 'all'; } })();
// A ride switched off under "With alerts" stays in the list until the
// filter, the search or the tab changes, as in Settings, so a mis-tap can
// be switched straight back instead of vanishing from under the finger.
const keepListed = new Set();
const FILTERS = {
  all: () => true,
  open: (r) => r.status === 'OPERATING',
  down: (r) => r.status === 'DOWN',
  following: (r) => isFollowing(r.id) || keepListed.has(r.id),
};
const FILTER_EMPTY = {
  open: 'No rides are open right now.',
  down: 'Nothing is down right now.',
  following: "You aren't getting alerts about any ride. Turn some on under All.",
};
function setRideFilter(filter) {
  rideFilter = FILTERS[filter] ? filter : 'all';
  keepListed.clear();
  try { localStorage.setItem('parkalert.rideFilter', rideFilter); } catch {}
  document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === rideFilter)));
  if (dash) renderRides();
}
document.querySelectorAll('[data-filter]').forEach((b) => { b.onclick = () => setRideFilter(b.dataset.filter); });
setRideFilter(rideFilter);

function setRideSort(sort) {
  rideSort = sort;
  try { localStorage.setItem('parkalert.rideSort', sort); } catch {}
  const btn = $('#btn-sort');
  btn.innerHTML = `${icon('sort')}<span>${sort === 'wait' ? 'Wait' : 'A–Z'}</span>`;
  btn.setAttribute('aria-label', sort === 'wait' ? 'Sorted by shortest wait. Sort A to Z instead' : 'Sorted A to Z. Sort by shortest wait instead');
  if (dash) renderRides();
}
$('#btn-sort').onclick = () => { haptic(); setRideSort(rideSort === 'wait' ? 'name' : 'wait'); };
setRideSort(rideSort);

function renderRides() {
  drawRides();
}

function drawRides() {
  const q = $('#ride-search').value.trim();
  const all = dash.rides.filter((r) => !r.other).sort(rideOrder);
  const shown = all.filter((r) => FILTERS[rideFilter](r) && (!q || matchesSearch(r.name, q)));
  const following = all.filter((r) => isFollowing(r.id)).length;

  // Counts on the filter, as Mail shows unread: how many are open or down
  // before you tap.
  for (const b of document.querySelectorAll('[data-filter]')) {
    const f = b.dataset.filter;
    const n = f === 'all' ? null : all.filter(FILTERS[f]).length;
    const label = { all: 'All', open: 'Open', down: 'Down', following: 'With alerts' }[f];
    morph(b, n == null ? label : `${label} <span class="count">${n}</span>`);
  }
  $('#follow-summary').textContent = following === all.length ? `Alerts on for all ${all.length}` : `Alerts on for ${following} of ${all.length}`;
  const btn = $('#btn-follow-all');
  btn.textContent = following === all.length ? 'Turn all off' : 'Turn all on';
  btn.onclick = following === all.length ? unfollowAll : followAll;
  // While searching it would be unclear whether this acts on the matches or on everything.
  btn.classList.toggle('hidden', !!q);

  // Shows, exhibits and play areas: under All only, with their status and
  // no switch, since they never alert.
  const others = rideFilter === 'all'
    ? dash.rides.filter((r) => r.other && (!q || matchesSearch(r.name, q))).sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)))
    : [];
  morph($('#other-block'), others.length ? `<h2 class="section-label" data-key="other-label">Other attractions</h2>
    <div class="group rides" data-key="other">${others.map((r) => `
      <div class="row ride-row" data-key="${esc(r.id)}">
        <button class="row-main pressable" type="button" data-ride="${esc(r.id)}">
          <span class="row-label">${esc(r.name)}
            <span class="meta ${r.status}"><span class="dot ${r.status}"></span>${esc(rideMeta(r))}</span>
          </span>
        </button>
      </div>`).join('')}</div>
    <p class="footnote" data-key="other-foot">Shows, exhibits and play areas that never post a wait. They don't send alerts.</p>` : '');

  const list = $('#rides-list');
  list.className = 'group rides';
  if (!shown.length) {
    morph(list, `<p class="no-results" data-key="none">${q ? `No rides match “${esc(q)}”.` : esc(FILTER_EMPTY[rideFilter] || 'No rides.')}</p>`);
    return;
  }
  morph(list, shown.map((r) => {
    const on = isFollowing(r.id);
    return `
      <div class="row ride-row" data-key="${esc(r.id)}">
        <button class="row-main pressable" type="button" data-ride="${esc(r.id)}">
          <span class="row-label">${esc(r.name)}
            <span class="meta ${r.status}"><span class="dot ${r.status}"></span>${esc(rideMeta(r))}${trendHtml(r)}${waitBadge(r)}</span>
            ${queueTags(r).length ? `<span class="tags">${queueTags(r).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
          </span>
        </button>
        <button class="switch" type="button" role="switch" aria-checked="${on}" data-id="${esc(r.id)}"
                aria-label="Alerts for ${esc(r.name)}"></button>
      </div>`;
  }).join(''));
}

// Switches slide as well as tap, as in Settings: the knob follows a
// sideways drag and the switch ends up whichever way the finger finished.
// The tap that ends a drag is swallowed and the change made once, here.
let slide = null;
let swallowClick = false;
document.addEventListener('pointerdown', (e) => {
  const sw = e.target.closest('.switch');
  if (!sw || e.button > 0) return;
  slide = { sw, x: e.clientX, id: e.pointerId, on: sw.getAttribute('aria-checked') === 'true', want: null };
}, true);
document.addEventListener('pointermove', (e) => {
  if (!slide || e.pointerId !== slide.id) return;
  const dx = e.clientX - slide.x;
  if (Math.abs(dx) < 8 && slide.want === null) return;
  slide.want = dx > 0;
  slide.sw.classList.toggle('slide-on', slide.want);
  slide.sw.classList.toggle('slide-off', !slide.want);
}, true);
const endSlide = (e) => {
  if (!slide || e.pointerId !== slide.id) return;
  const { sw, on, want } = slide;
  slide = null;
  sw.classList.remove('slide-on', 'slide-off');
  if (want === null || e.type === 'pointercancel') return;
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 400);
  if (want !== on) sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
document.addEventListener('pointerup', endSlide, true);
document.addEventListener('pointercancel', endSlide, true);
document.addEventListener('click', (e) => {
  if (swallowClick && e.isTrusted && e.target.closest('.switch')) {
    swallowClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);

$('#rides-list').addEventListener('click', (e) => {
  const sw = e.target.closest('.switch');
  if (sw) toggleFollow(sw.dataset.id);
});

// One control per ride. The old star (watch) and bell (mute) did the same job
// two different ways; following now clears any leftover per-ride mute too.
function toggleFollow(rideId) {
  haptic();
  if (rideFilter === 'following') keepListed.add(rideId);
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
  d.textContent = phone.id ? (phoneMuted() ? 'Paused' : 'On') : ready ? 'Via ntfy' : 'Not set up';
  d.className = `row-detail ${ready ? 'ok' : 'warn'}`;
  const st = alertState();
  // Nothing when not paused, as Settings shows no value for an unset row;
  // "Off" read as "alerts are off".
  const until = st.until ? `until ${fmtUntil(st.until)}` : 'until you resume';
  $('#pause-detail').textContent = st.kind !== 'paused' ? ''
    : st.scope === 'phone' ? `This phone, ${until}` : `Everyone, ${until}`;
  $('#park-detail').textContent = parkLabel(dash.park.name);
  $('#switch-crowd').setAttribute('aria-checked', String(!!dash.trip.crowdAlerts));
}

// Before the first dashboard arrives there is nothing to show but where that
// stands: loading, or unreachable with a way to try again.
function renderNoData() {
  $('#park-name').textContent = 'ParkAlert';
  $('#park-name').style.fontSize = '';
  $('#park-name').classList.remove('wrap');
  lastFit = null;
  const meta = $('#park-meta');
  meta.textContent = offline ? (failure === 'offline' ? 'Offline. Waiting for a connection…' : `${FAILURE_META[failure]}…`) : 'Loading…';
  meta.classList.toggle('warn', offline);
  $('#btn-alerts').classList.add('hidden');
  $('#down-badge').classList.add('hidden');
  $('#trip-code').textContent = tripCode;
  for (const id of ['#setup-detail', '#pause-detail', '#park-detail', '#follow-summary']) $(id).textContent = '';
  $('#btn-follow-all').classList.add('hidden');
  morph($('#recent-block'), '');

  morph($('#down-list'), offline
    ? `<div class="empty offline" data-key="empty">
        ${icon('wifi-off')}
        <h2 class="title-2">${failure === 'offline' ? "You're offline" : "Can't reach ParkAlert"}</h2>
        <p>${failure === 'offline' ? 'Rides show up here as soon as your phone reconnects.' : "Your connection is fine; ParkAlert isn't answering. This tries again on its own."}</p>
        <button class="btn-secondary pressable" type="button" data-act="retry-dash">Try again</button>
      </div>`
    : skeleton('cards'));
  $('#rides-list').className = 'group rides';
  morph($('#rides-list'), offline
    ? `<p class="no-results" data-key="none">${failure === 'offline' ? 'Rides show up once your phone reconnects.' : 'Rides show up once ParkAlert answers.'}</p>`
    : Array.from({ length: 6 }, (_, i) => `<div class="row sk-row" data-key="sk${i}" aria-hidden="true"><span class="row-label"><span class="sk sk-line w60"></span><span class="sk sk-line w35"></span></span></div>`).join(''));
}

// Actions inside the main views, delegated so patched content keeps working.
$('#app').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'setup-alerts') openAlertSetup();
  else if (act === 'open-hold') openHold();
  else if (act === 'open-park') openParkInfo();
  else if (act === 'retry-dash') { offline = false; renderAll(); refresh(); }
});

function renderAll() {
  if (!dash) return renderNoData();
  renderHeader();
  renderDown();
  renderRides();
  renderTrip();
  // Open pages follow too, so a ride's switch moves back with the list if a
  // save fails, and elapsed times stay current.
  pages.refresh();
}

/* ---------- Sheets ---------- */
function openPause() {
  const st = alertState();
  // 7am on the park's clock: this morning if it's not 7 yet, else tomorrow.
  // The phone's own midnight would make a 12:30am pause last 30 hours.
  const tz = dash.park.timezone || undefined;
  const morning = nextLocalHour(Date.now(), tz, 7);
  const thisMorning = localDay(morning, tz) === localDay(Date.now(), tz);
  // Each option says when it ends, as Focus does.
  const options = [
    ['For 1 hour', Date.now() + 3600_000],
    ['For 3 hours', Date.now() + 3 * 3600_000],
    [thisMorning ? 'Until this morning' : 'Until tomorrow morning', morning],
    ['Until I turn them back on', null],
  ];
  const tripPaused = st.kind === 'paused' && st.scope === 'trip';
  // With the app's own notifications, this phone can be paused alone; a
  // shared ntfy topic can only be paused for everyone.
  const perPhone = !!phone.id;
  const note = st.kind === 'closed'
    ? 'The park is closed, so alerts are already off until it opens.'
    : perPhone
      ? 'Pause just this phone, or everyone on the trip. The Down now list keeps updating either way.'
      : 'Nobody on this trip gets alerts while paused. The Down now list keeps updating.';
  const content = el(`<div>${sheetHead('Pause alerts', note)}</div>`);
  const optionRows = (scope) => {
    const g = el('<div class="group plain"></div>');
    for (const [label, until] of options) {
      const row = el(`<button class="row pressable" type="button"><span class="row-label">${label}</span>${until ? `<span class="row-detail">${esc(until === morning ? fmtTime(until) : `Until ${fmtTime(until)}`)}</span>` : ''}</button>`);
      row.onclick = () => { sheet.close(); if (scope === 'phone') setPhoneMute({ until }); else setMute({ until }); };
      g.appendChild(row);
    }
    return g;
  };
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
  if (perPhone) {
    content.appendChild(el('<h2 class="section-label">Just this phone</h2>'));
    content.appendChild(optionRows('phone'));
    content.appendChild(el('<h2 class="section-label">Everyone on this trip</h2>'));
  }
  content.appendChild(optionRows('trip'));
  const cancel = el('<div class="btn-stack"><button class="btn-secondary pressable" type="button">Cancel</button></div>');
  cancel.querySelector('button').onclick = () => sheet.close();
  content.appendChild(cancel);
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
  const content = el(`<div>
    ${sheetHead('Leave this trip?', `This phone stops showing it. The trip keeps running for anyone else on it, and you can rejoin with code <strong>${esc(tripCode)}</strong>.`)}
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
    head.appendChild(el('<p>Notifications are on for this phone. You get an alert when a ride with alerts on goes down, comes back up, or closes.</p>'));
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="phone-test">${icon('send')}<span>Send this phone a test</span></button>
      <button class="btn-secondary pressable" type="button" data-act="phone-off">Turn off for this phone</button>
      <button class="btn-secondary pressable" type="button" data-act="done">Done</button>
    </div>`));
  } else if (pushSupported() && !needsInstallForPush()) {
    head.appendChild(el(`<p>${denied
      ? 'Notifications are blocked for ParkAlert on this phone. Turn them on in your phone\'s Settings (on iPhone: Settings, Notifications, ParkAlert), then come back here.'
      : 'ParkAlert can notify this phone itself. One tap, nothing else to install.'}</p>`));
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="push-on" ${denied ? 'disabled' : ''}>${icon('bell')}<span>Turn on notifications</span></button>
      <p class="footnote center hidden" data-note></p>
    </div>`));
    const more = el('<details class="more"><summary>Or use the ntfy app instead</summary></details>');
    more.appendChild(ntfy);
    content.appendChild(more);
    content.appendChild(el(`<div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">${alertsReady() ? 'Done' : 'Set up later'}</button></div>`));
  } else if (needsInstallForPush()) {
    head.appendChild(el('<p>On iPhone, ParkAlert can notify you itself once it is on your Home Screen. Add it there, open it from its icon, and turn notifications on from this screen.</p>'));
    content.appendChild(el(`<div class="btn-stack">
      <button class="btn-primary pressable" type="button" data-act="install">${icon('share')}<span>Add to Home Screen</span></button>
    </div>`));
    const more = el('<details class="more"><summary>Or use the ntfy app instead</summary></details>');
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
    btn.querySelector('span').textContent = 'Turning on…';
    const result = await subscribePhone();
    if (result === 'on') {
      try { localStorage.removeItem(`parkalert.phoneOff.${tripCode}`); } catch {}
      api(`/trips/${tripCode}/devices/${encodeURIComponent(phone.id)}/test`, { method: 'POST' }).catch(() => {});
      haptic();
      renderAll();
      sheet.open(alertSetupContent());
      toast('Notifications are on. A test is on its way.');
      return;
    }
    btn.disabled = result === 'denied';
    btn.querySelector('span').textContent = 'Turn on notifications';
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
  hold: 'Several rides went down together, which usually means lightning nearby or another park-wide hold. These run longer than a breakdown, and the rides tend to reopen together.',
  opening: 'This ride did not open on time. Delayed openings are estimated from past delayed openings, not breakdowns.',
};

function statusLine(r) {
  if (r.status === 'DOWN' && r.downSince) {
    const when = downWhen(r);
    return r.downExact !== false && r.outlook?.kind !== 'opening' ? `Down ${downFor(r)} · since ${fmtTime(r.downSince)}` : [when, downFor(r)].filter(Boolean).join(' · ');
  }
  const t = r.status === 'OPERATING' && r.trend;
  const trend = t ? `${t.direction === 'up' ? 'up' : 'down'} ${Math.abs(t.change)} min in the last half hour` : '';
  return [rideMeta(r) + (trend ? `, ${trend}` : ''), ...queueTags(r)].join(' · ');
}

// What a range rests on, in a few words for the card.
function basisLine(o) {
  if (!o?.basis) return '';
  if (o.basis.from === 'prior') return 'From typical theme park outages, until ParkAlert knows this park';
  if (o.cause) {
    if (o.basis.from === 'rule') return 'From the 30-minute lightning rule';
    return `From ${o.basis.outages} past ${o.cause === 'rain' ? 'rain closures' : 'storms'} ${o.basis.from === 'ride' ? 'for this ride' : 'at this park'}`;
  }
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  const what = { hold: 'holds', opening: 'delayed openings' }[o.kind] || 'outages';
  return `From ${o.basis.outages} past ${what} ${where}`;
}

const WEATHER_NOTE = {
  lightning: "Outdoor rides close while there's lightning nearby and reopen about 30 minutes after the last of it, once they've been checked. The storm's end comes from the automated weather stations nearest the park.",
  rain: 'This ride closes in rain as well as lightning and reopens once the rain has stopped and the track has dried. The rain comes from the automated weather stations nearest the park.',
};

function estimateExplainer(o) {
  if (o?.cause) {
    if (!o.basis) return 'ParkAlert has not seen enough weather closures here to put a range on this one yet.';
    if (o.basis.from === 'rule') return 'Until ParkAlert has seen enough storms here to learn how this ride really goes, this uses the 30-minute rule: most reopen 30 to 45 minutes after the storm passes.';
    const what = o.cause === 'rain' ? 'rain closures' : 'storms';
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

// Wait alert: "tell me when the wait is at most N". Only limits under the
// current posted wait are offered, since one at or over it would go off at
// once; a ride that isn't posting a wait can take any of them.
const WAIT_CHOICES = [10, 15, 20, 30, 45, 60];

function waitAlertHtml(r) {
  if (r.other) return '';
  const alert = dash.trip.waitAlerts?.[r.id];
  const posted = r.status === 'OPERATING' && r.waitTime != null ? r.waitTime : null;
  const armed = alert && !alert.sentAt;
  let choices = WAIT_CHOICES.filter((m) => posted == null || m < posted);
  if (armed && !choices.includes(alert.max)) choices = [...choices, alert.max].sort((a, b) => a - b);
  const state = armed
    ? `You'll get an alert when the wait is ${alert.max} min or less.`
    : alert?.sentAt
      ? `Sent at ${fmtTime(alert.sentAt)}, when the wait was ${alert.sentWait} min. Pick a limit to be told again.`
      : posted != null && !choices.length
        ? `The wait is only ${posted} min right now.`
        : posted != null
          ? `Now ${posted} min. Tell me when the wait is at most (minutes):`
          : 'When it reopens, tell me if the wait is at most (minutes):';
  return `
    <h2 class="section-label" data-key="wait-label">Wait alert</h2>
    <div class="group padded wait-alert" data-key="wait-alert">
      <p class="wait-state">${icon('timer', 'inline-icon')} ${esc(state)}</p>
      ${choices.length ? `<div class="segmented wait-limits" role="group" aria-label="Wait alert limit">
        ${armed ? '<button class="chip" type="button" data-act="wait-off" data-key="off" aria-pressed="false">Off</button>' : ''}
        ${choices.map((m) => `<button class="chip" type="button" data-act="wait-${m}" data-key="${m}" aria-pressed="${armed && alert.max === m}" aria-label="${m} minutes">${m}</button>`).join('')}
      </div>` : ''}
    </div>
    <p class="footnote" data-key="wait-foot">Goes to everyone on this trip, once, and only today.</p>`;
}

async function setWaitAlert(rideId, max) {
  try {
    const path = `/trips/${tripCode}/wait-alerts/${encodeURIComponent(rideId)}`;
    const { trip } = await api(path, max == null ? { method: 'DELETE' } : { method: 'PUT', body: { max } });
    dash.trip = trip;
    confirmTrip(trip);
    renderAll();
    toast(max == null ? 'Wait alert off' : `Wait alert set for ${max} min or less`);
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

function rideHtml(r, detail, failed) {
  const o = (r.status === 'DOWN' ? r.outlook : null) || (detail?.ride?.status === 'DOWN' ? detail.outlook : null);
  const down = r.status === 'DOWN' && r.downSince;
  const parts = [`<p class="page-sub ${down ? 'tint-red' : ''}" data-key="status">${esc(statusLine(r))}</p>`];

  if (down) {
    const clock = backClock(r, o);
    parts.push(`
      <div class="group padded outlook-block" data-key="outlook">
        ${o?.cause ? `<p class="kind-tag hold">${icon('bolt')}${o.cause === 'rain' ? 'Rain' : 'Lightning'}${o.weather === 'passed' ? ', now passed' : ''}${o.kind === 'hold' ? ' · park-wide hold' : ''}</p>`
          : o?.kind === 'hold' ? `<p class="kind-tag hold">${icon('bolt')}Park-wide hold</p>` : ''}
        ${o?.kind === 'opening' ? '<p class="kind-tag">Delayed opening</p>' : ''}
        <p class="big-outlook">${esc(o?.advice?.verdict || o?.text || 'Not enough history to estimate yet')}</p>
        ${o?.advice ? `<p class="advice-detail">${esc(o.advice.detail)}${o.advice && isFollowing(r.id) && alertsReady() ? " You'll get an alert when it's back." : ''}</p>` : ''}
        ${o?.chance ? chanceHtml(o) : timeline({ ...r, outlook: o })}
        ${o?.advice && o?.text ? `<p class="clock">${esc(o.text)}</p>` : ''}
        ${clock ? `<p class="clock">${esc(clock)}</p>` : ''}
        ${o?.text ? `<p class="explain">${esc(estimateExplainer(o))}</p>` : ''}
        ${o?.cause ? `<p class="explain">${esc(WEATHER_NOTE[o.cause])}</p>` : KIND_NOTE[o?.kind] ? `<p class="explain">${esc(KIND_NOTE[o.kind])}</p>` : ''}
      </div>`);
  }

  parts.push(r.other
    ? `<p class="footnote" data-key="follow">This attraction never posts a wait, so it doesn't send alerts.</p>`
    : `
    <div class="group ${down ? 'spaced-sm' : ''}" data-key="follow"><div class="row">
      ${icon('bell', 'row-icon tint-accent')}
      <span class="row-label">Alerts for this ride</span>
      <button class="switch" type="button" role="switch" aria-checked="${isFollowing(r.id)}" aria-label="Alerts for ${esc(r.name)}" data-act="follow"></button>
    </div></div>`);
  parts.push(waitAlertHtml(r));

  if (!detail) {
    parts.push(failed
      ? `<div class="retry" data-key="retry"><p class="footnote">Couldn't load this ride's wait times and history.</p>
          <button class="btn-secondary pressable" type="button" data-act="retry">Try again</button></div>`
      : skeleton('ride'));
    return parts.join('');
  }

  // Wait times today
  if (detail.waits.some(([, v]) => v != null)) {
    parts.push(`<h2 class="section-label" data-key="waits-label">Wait times today</h2>
      <div class="group padded" data-chart="wait" data-key="wait-chart" data-sig="${sigOf(detail.waits)}"></div>
      <p class="footnote" data-key="waits-foot">Drag across the chart to see the wait at any time. Gaps are when it was down or closed.</p>`);
  }

  // When the line is usually shortest.
  const bt = detail.bestTimes;
  if (bt) {
    parts.push(`<h2 class="section-label" data-key="best-label">Best time to ride</h2>
      <div class="group padded" data-key="best">
        <p class="best-line">Usually shortest around <strong>${fmtHour(bt.best.hour)}</strong> (${bt.best.wait} min), longest around ${fmtHour(bt.worst.hour)} (${bt.worst.wait} min).</p>
        <div data-chart="hours" data-key="hours-chart" data-sig="${sigOf(bt.typical)}"></div>
      </div>
      <p class="footnote" data-key="best-foot">Typical posted wait each hour, from ${bt.days} day${bt.days === 1 ? '' : 's'} of history. Tap an hour.</p>`);
  }

  // Today. If the ride went down before today's log begins, the live
  // down-since time still says when, so show that rather than nothing.
  const today = [...detail.today];
  if (down && !today.some((e) => e.type === 'DOWN' && e.at >= r.downSince - 120_000)) {
    today.push({ type: 'DOWN', at: r.downSince, opening: o?.kind === 'opening' });
    today.sort((a, b) => a.at - b.at);
  }
  parts.push('<h2 class="section-label" data-key="today-label">Today</h2>');
  parts.push(today.length
    ? `<div class="group" data-key="today">${today.map((e) => `
      <div class="row" data-key="${e.type}-${e.at}">
        ${e.type === 'CLOSED' ? icon('moon', 'row-icon tint-orange') : icon(e.type === 'DOWN' ? 'down' : 'arrow-up', `row-icon ${e.type === 'DOWN' ? 'tint-red' : 'tint-green'}`)}
        <span class="row-label">${e.type === 'CLOSED' ? 'Closed' : e.type === 'DOWN' ? (e.opening ? 'Delayed opening' : 'Went down') : e.late ? 'Opened' : 'Back up'}${
          e.type === 'UP' && e.downtimeMs && !e.late ? `<small>after ${fmtDuration(e.downtimeMs)}</small>`
          : e.type === 'CLOSED' && e.downtimeMs ? `<small>after ${fmtDuration(e.downtimeMs)} down</small>` : ''}</span>
        <span class="row-detail">${fmtTime(e.at)}</span>
      </div>`).join('')}</div>`
    : '<div class="group plain" data-key="today"><div class="row"><span class="row-label muted">No outages so far today</span></div></div>');

  // History
  const h = detail.history;
  if (h?.archivedDays) {
    parts.push(`<h2 class="section-label" data-key="hist-label">Last ${h.days.length} days</h2>
      <div class="group padded" data-key="hist">
        <div class="stats">
          <div><p class="stat-label">Outages</p><p class="stat-value">${h.days.reduce((n, d) => n + d.outages, 0)}</p></div>
          <div><p class="stat-label">Typical breakdown</p><p class="stat-value">${h.typicalMinutes != null ? fmtDuration(h.typicalMinutes * 60000) : 'n/a'}</p></div>
          <div><p class="stat-label">Longest breakdown</p><p class="stat-value">${h.longestMinutes != null ? fmtDuration(h.longestMinutes * 60000) : 'n/a'}</p></div>
        </div>
        <div data-chart="days" data-key="days-chart" data-sig="${sigOf(h.days)}"></div>
      </div>`);
    if (h.last.length) {
      parts.push(`<h2 class="section-label" data-key="last-label">Recent outages</h2>
        <div class="group plain" data-key="last">${h.last.map((ep) => `
        <div class="row" data-key="${ep.start}">
          <span class="row-label">${esc(fmtDay(ep.start))}<small>${esc([
            `Went down at ${fmtTime(ep.start)}`,
            { hold: 'park-wide hold', opening: 'delayed opening' }[ep.kind],
            ep.reopened ? '' : "didn't reopen that day",
          ].filter(Boolean).join(' · '))}</small></span>
          <span class="row-detail">${ep.reopened ? fmtDuration(ep.minutes * 60000) : ''}</span>
        </div>`).join('')}</div>`);
    }
    parts.push(`<p class="footnote" data-key="hist-foot">Outage history comes from the ThemeParks.wiki archive, ${h.archivedDays} days so far and growing nightly.</p>`);
  }
  return parts.join('');
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
  const parts = [`<p class="page-sub" data-key="hours">${esc(hoursText())}</p>`];
  const { openingTime: open, closingTime: close, lateEvent } = dash.park;
  if (open || close) {
    parts.push(`<div class="group plain" data-key="hours-list">
      ${open ? `<div class="row" data-key="opens"><span class="row-label">Opens</span><span class="row-detail">${fmtTime(Date.parse(open))}</span></div>` : ''}
      ${close ? `<div class="row" data-key="closes"><span class="row-label">Closes</span><span class="row-detail">${fmtTime(Date.parse(close))}</span></div>` : ''}
      ${lateEvent ? `<div class="row" data-key="event"><span class="row-label">${esc(lateEvent.name)}<small>Alerts keep going until it ends</small></span><span class="row-detail">until ${fmtTime(Date.parse(lateEvent.closingTime))}</span></div>` : ''}
    </div>`);
  }
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
  return parts.join('');
}

function openHold() {
  if (!dash) return;
  pages.push({
    key: 'hold',
    url: '/hold',
    back: backLabel(),
    title: () => 'Park-wide hold',
    render: holdHtml,
  });
}

function holdHtml() {
  const holds = dash.rides.filter((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold' && !r.other);
  const parts = [`<p class="page-sub" data-key="note">${esc(KIND_NOTE.hold)}</p>`];
  if (!holds.length) {
    // Left open while the rides came back: say so rather than go blank.
    parts.push(`<div class="group padded" data-key="over"><p class="big-outlook">The hold is over</p><p class="explain">Every ride in it is running again or has closed. They're listed under Back up recently on Down now.</p></div>`);
    return parts.join('');
  }
  const text = holds[0]?.outlook?.text;
  if (text) parts.push(`<div class="group padded" data-key="range"><p class="big-outlook">${esc(text)}</p><p class="explain">${esc(estimateExplainer(holds[0].outlook))}</p></div>`);
  parts.push(`<h2 class="section-label" data-key="count">${holds.length} ride${holds.length === 1 ? '' : 's'} still in this hold</h2>
    <div class="group plain" data-key="rides">${holds.map((r) => `
    <button class="row pressable" type="button" data-ride="${esc(r.id)}">
      <span class="row-label">${esc(r.name)}<small>${esc(downWhen(r))}</small></span>
      <span class="row-detail">${downFor(r)}</span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`);
  return parts.join('');
}

// Placeholder shapes while something loads, so content settles into place
// instead of popping in under the reader.
function skeleton(kind) {
  if (kind === 'cards') {
    return `<div class="cards" data-key="skeleton">${[0, 1].map(() => `
      <div class="card sk-card" aria-hidden="true"><span class="sk sk-line w60"></span><span class="sk sk-line w35"></span><span class="sk sk-bar"></span><span class="sk sk-line w50"></span></div>`).join('')}</div>`;
  }
  const rows = kind === 'ride' ? 3 : 5;
  return `<div class="group sk-group" data-key="skeleton" aria-hidden="true">${Array.from({ length: rows }, () => `
    <div class="row"><span class="row-label"><span class="sk sk-line w60"></span><span class="sk sk-line w35"></span></span></div>`).join('')}</div>`;
}

// Taps on pages: one delegated listener, so patched content never loses a
// handler.
$('#pages').addEventListener('click', (e) => {
  const page = pages.top;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!page || !act) return;
  if (act === 'follow' && page.rideId) toggleFollow(page.rideId);
  else if (act === 'retry') { page.failed = false; pages.draw(page); page.load?.(); }
  else if (act.startsWith('wait-') && page.rideId) {
    haptic();
    const alert = dash.trip.waitAlerts?.[page.rideId];
    const armed = alert && !alert.sentAt;
    const m = act.slice(5);
    setWaitAlert(page.rideId, m === 'off' || (armed && Number(m) === alert.max) ? null : Number(m));
  }
});

// Any element carrying a ride id opens that ride, wherever it sits.
document.addEventListener('click', (e) => {
  if (e.target.closest('.switch')) return;
  const t = e.target.closest('[data-ride]');
  if (t) openRide(t.dataset.ride);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('article[data-ride]')) {
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
    if (!d || box._drawn === box.dataset.sig) continue;
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

function waitChart(box, { waits, now }) {
  const W = Math.max(160, contentWidth(box)), H = 116, top = 6, bottom = 2;
  const pts = waits.map(([t, w]) => ({ t, w }));
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
  let lastShown = null;
  const show = (t, fromUser) => {
    const p = at(t);
    // A tick each time the finger crosses onto a different reading.
    if (fromUser && lastShown !== null && p !== lastShown) haptic();
    lastShown = fromUser ? p : null;
    readout.textContent = `${fromUser ? fmtTime(t) : 'Now'} · ${p.w == null ? 'not running' : `${p.w} min wait`}`;
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t));
    cross.setAttribute('visibility', fromUser ? 'visible' : 'hidden');
    if (p.w != null) {
      dot.setAttribute('cx', x(t)); dot.setAttribute('cy', y(p.w));
      dot.setAttribute('visibility', 'visible');
    } else dot.setAttribute('visibility', 'hidden');
  };
  const latest = pts[pts.length - 1];
  svg.setAttribute('aria-label', `Wait times today, from ${fmtTime(t0)} to now. Now ${latest.w == null ? 'not running' : `${latest.w} minutes`}.`);
  show(t1, false);

  // Scrub: the crosshair follows the finger along X; vertical drags still scroll.
  let cursor = t1;
  const fromEvent = (e) => {
    const r = svg.getBoundingClientRect();
    return t0 + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (t1 - t0);
  };
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); cursor = fromEvent(e); show(cursor, true); });
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || svg.hasPointerCapture(e.pointerId)) { cursor = fromEvent(e); show(cursor, true); }
  });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(t1, false); });
  // Lifting the finger goes back to "Now", as Stocks and Weather do.
  for (const type of ['pointerup', 'pointercancel']) {
    svg.addEventListener(type, (e) => { if (e.pointerType !== 'mouse') { cursor = t1; show(t1, false); } });
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
    `<span>${i % every === 0 ? esc(fmtHour(h).replace(' ', '')) : ''}</span>`).join('')}</div>`);
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
    readout.textContent = `${user ? fmtHour(h) : `Now (${fmtHour(h)})`} · ${t != null ? `today ${t} min` : 'no reading today'}${u != null ? `, usually ${u}` : ''}`;
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
  const scrub = (e) => { const h = hourAt(e); if (h !== last) { if (last !== null) haptic(); last = h; show(h, true); } };
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); scrub(e); });
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || svg.hasPointerCapture(e.pointerId)) scrub(e); });
  for (const t of ['pointerup', 'pointercancel']) svg.addEventListener(t, (e) => { if (e.pointerType !== 'mouse') { last = null; show(nowH, false); } });
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
  toast('A new version of ParkAlert is ready', { label: 'Reload', run: () => worker.postMessage('activate'), sticky: true });
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
}

/* ---------- Screens & navigation ---------- */
function showSetup() {
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  document.body.classList.add('no-tabbar');
  document.title = 'ParkAlert';
  renderSetupParks();
}

const onSetup = () => !$('#setup').classList.contains('hidden');

async function showApp({ firstRun = false } = {}) {
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
  // Tapping the tab you're already on scrolls it back to the top, as on iOS.
  t.onclick = () => (view === t.dataset.view
    ? window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
    : switchView(t.dataset.view));
});
$('#btn-locate').onclick = locate;

const joinInput = $('#join-code');
const joinBtn = $('#join-form button');
const syncJoin = () => { joinBtn.disabled = joinInput.value.trim().length !== 6; };
joinInput.addEventListener('input', syncJoin);
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
const withDash = (fn) => () => (dash ? fn() : toast('Still connecting. Try again in a moment.'));
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
    try { await navigator.share({ title: 'ParkAlert', text, url }); } catch {}
    return;
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
  sheet.open(el(`<div>
    ${sheetHead('Add to Home Screen', 'ParkAlert then opens full screen from its own icon, without Safari around it.')}
    <ol class="steps">
      <li class="step"><h3>Tap Share</h3><p>The ${icon('share', 'inline-icon')} button in Safari's toolbar.</p></li>
      <li class="step"><h3>Tap Add to Home Screen</h3><p>Scroll down the list if you don't see it, then tap Add.</p></li>
    </ol>
    <div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="done">Done</button></div>
  </div>`));
  $('#sheet-body [data-act=done]').onclick = () => sheet.close();
};
syncInstall();

const nav = $('#nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 2), { passive: true });

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
    else showSetup();
  }
  // An invite opened offline earlier, still waiting.
  if (!joinParam && pendingInvite()) {
    setPendingInvite(pendingInvite());
    if (navigator.onLine !== false) tryInvite();
  }
})();

