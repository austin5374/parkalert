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
let offline = false;
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

// Re-rendering a list replaces its nodes, which drops keyboard and
// screen-reader focus to the top of the page every refresh and on every
// toggle. Note which control had focus and put it back on its replacement.
function keepFocus(root, render) {
  const a = document.activeElement;
  const attr = a && a !== root && root.contains(a) ? ['data-id', 'data-ride', 'data-act'].find((n) => a.hasAttribute(n)) : null;
  const selector = attr && `${a.tagName.toLowerCase()}[${attr}="${CSS.escape(a.getAttribute(attr))}"]`;
  render();
  if (selector && !root.contains(a)) root.querySelector(selector)?.focus({ preventScroll: true });
}

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
const alertsReady = () => localStorage.getItem(alertsReadyKey()) === '1';

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
// server refuses, it moves back and says so.
async function save(apply, body, afterSave) {
  const before = structuredClone(dash.trip);
  apply(dash.trip);
  renderAll();
  try {
    const { trip } = await patchTrip(body);
    Object.assign(dash.trip, trip);
    afterSave?.(before);
    return true;
  } catch {
    dash.trip = before;
    renderAll();
    toast("Couldn't save that. Check your connection and try again.");
    return false;
  }
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(text, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { hideToast(); action.run(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2800);
}
function hideToast() { $('#toast').classList.remove('show'); }

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
// 0.998 is UIScrollView's normal rate: a short, fast flick carries far.
const project = (v, rate = 0.998) => ((v / 1000) * rate) / (1 - rate);

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/* ---------- Sheet ---------- */
const sheet = (() => {
  const layer = $('#sheet-layer'), panel = $('#sheet'), scrim = $('#scrim'), body = $('#sheet-body');
  let y = 0, h = 1, anim = null, isOpen = false, returnFocus = null, onClosed = null;
  // closing: the close animation is running (isOpen is already false).

  // The sheet's height changes after it opens (a ride's history loads in),
  // so it is read again whenever a close or a drag needs it.
  const measure = () => { h = panel.getBoundingClientRect().height || h; return h; };
  // Detents, as in Maps: a tall ride sheet rests at a medium height (rest > 0,
  // the offset that leaves 55% of the screen showing) and a drag up or a
  // flick takes it to full height (rest = 0). Short sheets only have full.
  let rest = 0;
  let medium = 0; // the medium detent's offset, or 0 when there isn't one
  let wantMedium = false; // this sheet has a medium detent once it is tall enough
  let pendingMedium = false; // opened short; take the medium detent when it grows
  const MEDIUM_SHARE = 0.55;
  // Worked out again whenever the content's height changes (a ride's
  // history loads after the sheet opens): a sheet resting at medium stays
  // there, now with the same 55% of the screen showing.
  const setDetents = () => {
    const wasMedium = medium > 0 && rest === medium;
    measure();
    medium = wantMedium && h > innerHeight * (MEDIUM_SHARE + 0.07) ? Math.round(h - innerHeight * MEDIUM_SHARE) : 0;
    return wasMedium;
  };
  const app = $('#app');
  // While a full-height sheet is up, the page behind recedes a little, as
  // behind an iOS page sheet; nothing moves under reduced motion.
  const recede = (v) => {
    const full = h >= innerHeight - 80 && !reducedMotion();
    const p = full ? Math.max(0, Math.min(1, 1 - v / (medium || h))) : 0;
    app.style.transform = p ? `scale(${1 - 0.06 * p})` : '';
    app.style.borderRadius = p ? `${Math.round(12 * p)}px` : '';
    document.documentElement.classList.toggle('sheet-up', p > 0);
  };
  const paint = (v) => {
    y = v;
    panel.style.transform = `translateY(${v}px)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v / h)));
    recede(v);
  };

  function animateTo(target, velocity = 0, damping = 1, done) {
    anim?.stop();
    if (reducedMotion()) {
      paint(target);
      done?.();
      return;
    }
    // Always from the live, on-screen value, so a sheet grabbed mid-flight never jumps.
    anim = spring({ from: y, to: target, velocity, damping, response: 0.32, onUpdate: paint, onDone: done });
  }

  // While a sheet is up, the page behind it is out of reach: Tab stays in the
  // sheet and screen readers don't wander into the page, as aria-modal says.
  const background = [$('#app'), $('#setup')];
  const setInert = (on) => background.forEach((n) => { n.inert = on; });

  function finishClose() {
    recede(h);
    layer.classList.add('hidden');
    setInert(false);
    body.replaceChildren();
    returnFocus?.focus?.({ preventScroll: true });
    const cb = onClosed;
    onClosed = null;
    cb?.();
  }

  // Back (the browser's, Android's, or a sheet's own back button) closes the
  // sheet, or steps back through sheets opened from sheets, instead of
  // leaving the app. Each open or pushed view adds a history entry; closing
  // any other way (scrim, drag, Escape) takes them back off.
  let depth = 0; // history entries this sheet has added
  let skipPops = 0; // popstate events caused by our own history.go()
  let onBack = null; // app hook: step back one view; false when at the first
  let entryAfterPop = false; // a sheet opened while our history.go() was still pending
  addEventListener('popstate', () => {
    if (skipPops) {
      skipPops--;
      if (!skipPops && entryAfterPop) { entryAfterPop = false; history.pushState({ parkalertSheet: depth }, ''); }
      return;
    }
    if (!isOpen) { depth = 0; return; }
    depth = Math.max(0, depth - 1);
    if (onBack?.()) return;
    depth = 0;
    dismiss();
  });
  // history.go() is asynchronous: an entry pushed before it lands would be
  // the one it takes away, so it waits for that popstate.
  const addEntry = () => {
    if (skipPops) { entryAfterPop = true; depth++; return; }
    history.pushState({ parkalertSheet: depth + 1 }, '');
    depth++;
  };

  function open(content, { onClose, detent = 'large' } = {}) {
    // Opened again while still closing: finish the old sheet's bookkeeping
    // and rise from where it is now, rather than snapping to the bottom.
    const wasClosing = closing;
    if (closing) {
      closing = false;
      const cb = onClosed;
      onClosed = null;
      cb?.();
    }
    // Focus goes back to what opened the first sheet, not to a row inside a
    // sheet that is about to be replaced.
    if (!isOpen) {
      if (!wasClosing) returnFocus = document.activeElement;
      addEntry();
    }
    onClosed = onClose || null;
    body.replaceChildren(content);
    body.scrollTop = 0;
    layer.classList.remove('hidden');
    setInert(true);
    h = panel.getBoundingClientRect().height || 400;
    wantMedium = detent === 'medium';
    setDetents();
    // A medium sheet that opens short (its content still loading) takes the
    // medium detent as soon as it grows into one.
    rest = medium;
    pendingMedium = wantMedium && !medium;
    if (!isOpen && !wasClosing) paint(h);
    isOpen = true;
    animateTo(rest);
    panel.focus({ preventScroll: true });
  }

  // A view opened from the current one (a ride from the hold list): same
  // sheet, new content, one more step for Back.
  function push(content) {
    addEntry();
    replace(content);
  }
  function replace(content) {
    body.replaceChildren(content);
    body.scrollTop = 0;
    panel.focus({ preventScroll: true });
    if (setDetents()) {
      rest = medium;
      animateTo(rest);
    }
  }

  let closing = false;
  function dismiss(velocity = 0) {
    if (!isOpen) return;
    isOpen = false;
    closing = true;
    animateTo(measure(), velocity, 1, () => { closing = false; finishClose(); });
  }
  function close(velocity = 0) {
    if (!isOpen) return;
    if (depth) {
      skipPops++;
      history.go(-depth);
      depth = 0;
    }
    dismiss(velocity);
  }

  // Drag: 1:1 with the finger from where it grabbed, rubber-banded above the
  // top, and on release the flick's projected resting point decides.
  let drag = null;
  function begin(clientY, t) {
    anim?.stop();
    measure();
    drag = { startY: clientY, from: y, samples: [{ t, y }] };
  }
  function follow(clientY, t) {
    let next = drag.from + (clientY - drag.startY);
    if (next < 0) next = rubberband(next, h);
    paint(next);
    drag.samples.push({ t, y: next });
    if (drag.samples.length > 8) drag.samples.shift();
  }
  function release(t) {
    // Only the last 80 ms count: a finger that stopped before lifting has no
    // velocity, however fast it was moving earlier.
    const s = drag.samples.filter((p) => t - p.t <= 80);
    const a = s[0], b = s[s.length - 1];
    const v = s.length > 1 && b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s
    drag = null;
    const to = y + project(v);
    // Past 45% of the way from the lowest detent to the bottom closes; else
    // the nearest detent to where the flick would come to rest.
    const low = medium || 0;
    if (to > low + (h - low) * 0.45) return close(v);
    rest = medium && to > medium / 2 ? medium : 0;
    // Settling back after a flick carries its momentum, so a little give reads right.
    animateTo(rest, v, Math.abs(v) > 300 ? 0.82 : 1);
  }

  // The grabber drags with any pointer (a mouse included).
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

  // Anywhere else on the sheet, as in Maps: a downward pull while the
  // content is at the top moves the sheet; otherwise the content scrolls. A
  // scroll that reaches the top mid-gesture hands over to the sheet, one
  // continuous motion. Charts keep their horizontal scrub.
  let touch = null; // { startY, lastY, mode: null | 'sheet' | 'scroll' }
  body.addEventListener('touchstart', (e) => {
    if (!isOpen || e.touches.length > 1 || e.target.closest('.chart')) { touch = null; return; }
    touch = { startY: e.touches[0].clientY, lastY: e.touches[0].clientY, mode: null };
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
    const atTop = body.scrollTop <= 0;
    if (touch.mode === null && Math.abs(cy - touch.startY) < 6) return;
    // Below full height, the content doesn't scroll: the sheet moves, up to
    // full height or down to close.
    const belowFull = y > 0.5;
    if (((atTop && goingDown) || belowFull) && e.cancelable) {
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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });

  // A finger on the sheet (dragging it, scrubbing a chart) or a scroll still
  // coasting holds off live refreshes: replacing the content then would
  // jump under the finger or stop the momentum dead. The newest refresh
  // waits and lands once the sheet is still.
  let touching = false;
  let lastScroll = 0;
  let pending = null; // { content, after }
  let retry = null;
  body.addEventListener('pointerdown', () => { touching = true; });
  body.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  grabber.addEventListener('pointerdown', () => { touching = true; });
  body.addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true });
  const settle = () => {
    touching = false;
    flush();
  };
  for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) addEventListener(t, settle, true);

  const busy = () => touching || !!drag || performance.now() - lastScroll < 250;
  function flush() {
    clearTimeout(retry);
    if (!pending || !isOpen) { pending = null; return; }
    if (busy()) { retry = setTimeout(flush, 250); return; }
    const { content, after } = pending;
    pending = null;
    const top = body.scrollTop;
    keepFocus(body, () => body.replaceChildren(content));
    body.scrollTop = top;
    const wasMedium = setDetents();
    if (medium && (wasMedium || pendingMedium)) {
      pendingMedium = false;
      rest = medium;
      animateTo(rest);
    }
    after?.();
  }

  // Swap content in place (live refresh), keeping the reader's scroll
  // position and focus.
  function update(content, after) {
    if (!isOpen) return;
    pending = { content, after };
    flush();
  }

  return {
    open, push, replace, update, close: () => close(),
    get isOpen() { return isOpen; },
    set onBack(fn) { onBack = fn; },
  };
})();

// back: the label of the view this one was opened from ("Hold"), shown as
// a back button above the title, as a pushed card in Find My has.
function sheetHead(title, html, back = null) {
  return `<div class="sheet-head">${back ? `<button class="sheet-back pressable" type="button" data-act="back">${icon('chevron', 'back-chevron')}<span>${esc(back)}</span></button>` : ''}<h2 class="title-2" id="sheet-title">${esc(title)}</h2>${html ? `<p>${html}</p>` : ''}</div>`;
}
document.addEventListener('click', (e) => { if (e.target.closest('#sheet [data-act=back]')) history.back(); });

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
  if (code.toUpperCase() !== tripCode) {
    // Never show one trip's rides under another trip's code.
    dash = null;
    offline = false;
  }
  tripCode = code.toUpperCase();
  localStorage.setItem('parkalert.trip', tripCode);
  showApp({ firstRun });
}

function leaveTrip() {
  localStorage.removeItem('parkalert.trip');
  tripCode = null;
  dash = null;
  clearInterval(refreshTimer);
  showSetup();
}

/* ---------- Header ---------- */
function alertState() {
  const m = dash.trip.mute;
  if (m && (m.until === null || m.until > Date.now())) return { kind: 'paused', until: m.until };
  // The same rule the server mutes by: the day's last close, events included.
  const close = dash.park.lastCloseTime || dash.park.lateEvent?.closingTime || dash.park.closingTime;
  if (close && Date.now() > Date.parse(close)) return { kind: 'closed' };
  if (!alertsReady()) return { kind: 'setup' };
  return { kind: 'on' };
}

function hoursText() {
  const { openingTime: open, closingTime: close, lateEvent, lastCloseTime } = dash.park;
  const now = Date.now();
  const lastClose = lastCloseTime || lateEvent?.closingTime || close;
  if (open && now < Date.parse(open)) return `Opens ${fmtTime(Date.parse(open))}`;
  if (lastClose && now > Date.parse(lastClose)) return 'Closed for the day';
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
function fitTitle() {
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
addEventListener('resize', () => dash && fitTitle());

function renderHeader() {
  $('#park-name').textContent = parkLabel(dash.park.name);
  document.title = `${parkLabel(dash.park.name)} · ParkAlert`;

  const meta = $('#park-meta');
  const stale = !dash.lastPoll || Date.now() - dash.lastPoll > STALE_MS || !!dash.lastError;
  meta.textContent = offline
    ? `Offline · as of ${fmtUntil(dash.lastPoll)}`
    : stale
      ? `Updated ${dash.lastPoll ? fmtDuration(Date.now() - dash.lastPoll) : 'a while'} ago · reconnecting`
      : hoursText();
  meta.classList.toggle('warn', offline || stale);

  const st = alertState();
  const [glyph, label] = {
    on: ['bell', 'Alerts on'],
    paused: ['pause', 'Paused'],
    closed: ['moon', 'Park closed'],
    setup: ['bell-off', 'Set up alerts'],
  }[st.kind];
  const pill = $('#btn-alerts');
  pill.className = `pill pressable ${st.kind}`;
  pill.innerHTML = `${icon(glyph)}<span>${label}</span>`;
  fitTitle(); // after the pill, whose label sets the room left
  pill.setAttribute('aria-label', st.kind === 'paused' && st.until ? `Alerts paused until ${fmtUntil(st.until)}` : label);

  const down = dash.rides.filter((r) => r.status === 'DOWN' && isFollowing(r.id)).length;
  const badge = $('#down-badge');
  badge.textContent = down;
  badge.classList.toggle('hidden', !down);
}

/* ---------- Down now ---------- */
function isFollowing(rideId) {
  const t = dash.trip;
  return (t.watched === null || t.watched.includes(rideId)) && !t.rideMutes?.[rideId];
}

// Elapsed in red, and the usual reopening window shaded just ahead of it.
function timeline(r) {
  const w = r.outlook?.window;
  if (!w || w.lo == null) return '';
  const spent = (Date.now() - r.downSince) / 60000;
  const hi = w.hi ?? w.lo * 2;
  const end = (spent + hi) * 1.12 || 1;
  const pct = (m) => `${Math.min(100, (m / end) * 100).toFixed(1)}%`;
  return `<div class="timeline" aria-hidden="true">
    <span class="window" style="left:${pct(spent + w.lo)};width:${pct(hi - w.lo)}"></span>
    <span class="spent" style="width:${pct(spent)}"></span>
  </div>`;
}

function downCard(r) {
  const o = r.outlook || {};
  const following = isFollowing(r.id);
  const since = o.kind === 'opening' ? `Delayed opening since ${fmtTime(r.downSince)}` : `Down since ${fmtTime(r.downSince)}`;
  const foot = [
    basisLine(o),
    following ? '' : 'Not following',
  ].filter(Boolean).join(' · ');
  return `
    <article class="card pressable ${following ? '' : 'unfollowed'}" data-ride="${esc(r.id)}" role="button" tabindex="0"
             aria-label="${esc(r.name)}, down ${fmtDuration(Date.now() - r.downSince)}. Show details">
      <div class="card-top">
        <h3 class="card-title">${esc(r.name)}</h3>
        <span class="elapsed">${fmtDuration(Date.now() - r.downSince)}</span>
        ${icon('chevron', 'chevron')}
      </div>
      <p class="card-sub">${since}</p>
      ${timeline(r)}
      ${o.text ? `<p class="card-outlook">${esc(o.text)}</p>` : ''}
      ${foot ? `<p class="card-foot">${esc(foot)}</p>` : ''}
    </article>`;
}

function setupRow() {
  const row = el(`
    <div class="group" style="margin-top:1.2rem"><button class="row pressable" type="button">
      ${icon('bell', 'row-icon tint-accent')}
      <span class="row-label">Set up alerts on this phone</span>
      ${icon('chevron', 'chevron')}
    </button></div>`);
  row.querySelector('button').onclick = openAlertSetup;
  return row;
}

function renderDown() {
  keepFocus($('#view-down'), drawDown);
}

function drawDown() {
  const list = $('#down-list');
  const down = dash.rides
    .filter((r) => r.status === 'DOWN' && r.downSince)
    .sort((a, b) => (isFollowing(b.id) - isFollowing(a.id)) || b.downSince - a.downSince);
  list.replaceChildren();

  if (!dash.lastPoll) {
    // No ride data yet is not the same as nothing being down.
    list.appendChild(el(`
      <div class="empty offline">
        ${icon('wifi-off')}
        <h2 class="title-2">No ride data yet</h2>
        <p>The park's ride feed isn't answering right now. This updates on its own.</p>
      </div>`));
  } else if (!down.length) {
    list.appendChild(el(`
      <div class="empty">
        ${icon('check-circle')}
        <h2 class="title-2">Everything's running</h2>
        <p>${alertState().kind === 'closed' ? 'The park is closed for the day.' : "You'll get an alert when a ride you follow goes down."}</p>
      </div>`));
  } else {
    const holds = down.filter((r) => r.outlook?.kind === 'hold');
    const rest = down.filter((r) => r.outlook?.kind !== 'hold');
    if (holds.length) {
      const hdr = el(`<button class="hold-header pressable" type="button">${icon('bolt')}<span>Park-wide hold · ${holds.length} rides</span>${icon('chevron', 'chevron')}</button>`);
      hdr.onclick = () => openHold();
      list.appendChild(hdr);
      list.appendChild(el(`<div class="cards">${holds.map(downCard).join('')}</div>`));
    }
    if (rest.length) {
      if (holds.length) list.appendChild(el('<h2 class="section-label">Down</h2>'));
      list.appendChild(el(`<div class="cards">${rest.map(downCard).join('')}</div>`));
    }
  }
  if (!alertsReady()) list.appendChild(setupRow());
  renderRecent(new Set(down.map((r) => r.id)));
}

// Rides that came back, or gave up and closed, recently: so an alert opened
// late still makes sense. Each ride's latest word only.
function renderRecent(downIds) {
  const block = $('#recent-block');
  const status = new Map(dash.rides.map((r) => [r.id, r.status]));
  const seen = new Set();
  const latest = (dash.recent || []).filter((e) => {
    if ((e.type !== 'UP' && e.type !== 'CLOSED') || downIds.has(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
    return e.type === 'UP' || status.get(e.id) === 'CLOSED';
  });
  const ups = latest.filter((e) => e.type === 'UP');
  const closed = latest.filter((e) => e.type === 'CLOSED');
  block.replaceChildren();
  if (closed.length) {
    block.appendChild(el('<h2 class="section-label">Closed after an outage</h2>'));
    block.appendChild(el(`<div class="group">${closed.map((e) => `
      <button class="row recent-row pressable" type="button" data-ride="${esc(e.id)}">
        ${icon('moon', 'row-icon tint-orange')}
        <span class="row-label">${esc(e.name)}<small>Closed at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)} down` : ''}</small></span>
        ${icon('chevron', 'chevron')}
      </button>`).join('')}</div>`));
  }
  if (!ups.length) return;
  block.appendChild(el('<h2 class="section-label">Back up recently</h2>'));
  block.appendChild(el(`<div class="group">${ups.map((e) => `
    <button class="row recent-row pressable" type="button" data-ride="${esc(e.id)}">
      ${icon('arrow-up', 'row-icon tint-green')}
      <span class="row-label">${esc(e.name)}<small>${e.late
        ? `Opened at ${fmtTime(e.at)}${e.downtimeMs ? `, ${fmtDuration(e.downtimeMs)} late` : ''}`
        : `Back at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}`}</small></span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`));
}

/* ---------- Rides ---------- */
// A small marker in the Rides list for a ride with a wait alert still to go off.
function waitBadge(r) {
  const a = dash.trip.waitAlerts?.[r.id];
  return a && !a.sentAt ? `<span class="wait-badge" title="Wait alert">${icon('timer')}≤${a.max}</span>` : '';
}

function rideMeta(r) {
  if (r.status === 'OPERATING') return `Open${r.waitTime != null ? ` · ${r.waitTime} min wait` : ''}`;
  if (r.status === 'DOWN') return `Down ${r.downSince ? fmtDuration(Date.now() - r.downSince) : ''}`.trim();
  if (r.status === 'REFURBISHMENT') return 'Refurbishment';
  return 'Closed';
}

// A–Z, or shortest wait first: what's quickest to ride right now. Running
// rides by posted wait, then down ones, then closed. Remembered per phone.
let rideSort = (() => { try { return localStorage.getItem('parkalert.rideSort') || 'name'; } catch { return 'name'; } })();
const byName = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name));
function rideOrder(a, b) {
  if (rideSort !== 'wait') return byName(a, b);
  const rank = (r) => (r.status === 'OPERATING' ? 0 : r.status === 'DOWN' ? 1 : 2);
  return rank(a) - rank(b) || (a.waitTime ?? Infinity) - (b.waitTime ?? Infinity) || byName(a, b);
}

function setRideSort(sort) {
  rideSort = sort;
  try { localStorage.setItem('parkalert.rideSort', sort); } catch {}
  document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === sort)));
  if (dash) renderRides();
}
document.querySelectorAll('[data-sort]').forEach((b) => { b.onclick = () => setRideSort(b.dataset.sort); });
setRideSort(rideSort);

function renderRides() {
  keepFocus($('#rides-list'), drawRides);
}

function drawRides() {
  const q = $('#ride-search').value.trim();
  const all = [...dash.rides].sort(rideOrder);
  const shown = q ? all.filter((r) => matchesSearch(r.name, q)) : all;
  const following = all.filter((r) => isFollowing(r.id)).length;

  $('#follow-summary').textContent = following === all.length ? `Following all ${all.length}` : `Following ${following} of ${all.length}`;
  const btn = $('#btn-follow-all');
  btn.textContent = following === all.length ? 'Unfollow all' : 'Follow all';
  btn.onclick = following === all.length ? unfollowAll : followAll;
  // While searching it would be unclear whether this acts on the matches or on everything.
  btn.classList.toggle('hidden', !!q);

  const list = $('#rides-list');
  list.className = 'group rides';
  if (!shown.length) {
    list.innerHTML = `<p class="no-results">No rides match “${esc(q)}”.</p>`;
    return;
  }
  list.innerHTML = shown.map((r) => {
    const on = isFollowing(r.id);
    return `
      <div class="row ride-row">
        <button class="row-main pressable" type="button" data-ride="${esc(r.id)}">
          <span class="row-label">${esc(r.name)}
            <span class="meta ${r.status}"><span class="dot ${r.status}"></span>${esc(rideMeta(r))}${waitBadge(r)}${icon('chevron', 'meta-chevron')}</span>
          </span>
        </button>
        <button class="switch" type="button" role="switch" aria-checked="${on}" data-id="${esc(r.id)}"
                aria-label="Alerts for ${esc(r.name)}"></button>
      </div>`;
  }).join('');
}

$('#rides-list').addEventListener('click', (e) => {
  const sw = e.target.closest('.switch');
  if (sw) toggleFollow(sw.dataset.id);
});

// One control per ride. The old star (watch) and bell (mute) did the same job
// two different ways; following now clears any leftover per-ride mute too.
function toggleFollow(rideId) {
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
  save((t) => { t.watched = null; t.rideMutes = {}; }, { watched: null, rideMutes: {} });
}

function unfollowAll() {
  save((t) => { t.watched = []; }, { watched: [] }, (before) => {
    toast('Unfollowed every ride', {
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
  d.textContent = ready ? 'Working' : 'Not set up';
  d.className = `row-detail ${ready ? 'ok' : 'warn'}`;
  const st = alertState();
  $('#pause-detail').textContent = st.kind === 'paused' ? (st.until ? `Until ${fmtUntil(st.until)}` : 'Paused') : 'Off';
  $('#park-detail').textContent = parkLabel(dash.park.name);
}

// Before the first dashboard arrives there is nothing to show but where that
// stands: loading, or unreachable with a way to try again.
function renderNoData() {
  $('#park-name').textContent = 'ParkAlert';
  $('#park-name').style.fontSize = '';
  $('#park-name').classList.remove('wrap');
  const meta = $('#park-meta');
  meta.textContent = offline ? 'Offline. Waiting for a connection…' : 'Loading…';
  meta.classList.toggle('warn', offline);
  $('#btn-alerts').classList.add('hidden');
  $('#down-badge').classList.add('hidden');
  $('#trip-code').textContent = tripCode;
  for (const id of ['#setup-detail', '#pause-detail', '#park-detail', '#follow-summary']) $(id).textContent = '';
  $('#btn-follow-all').classList.add('hidden');
  $('#recent-block').replaceChildren();

  const state = offline
    ? el(`<div class="empty offline">
        ${icon('wifi-off')}
        <h2 class="title-2">Can't reach ParkAlert</h2>
        <p>Rides show up here as soon as your phone reconnects.</p>
        <button class="btn-secondary pressable" type="button">Try again</button>
      </div>`)
    : el('<div class="empty loading" role="status"><p>Loading rides…</p></div>');
  state.querySelector('button')?.addEventListener('click', () => {
    offline = false;
    renderAll();
    refresh();
  });
  $('#down-list').replaceChildren(state);
  $('#rides-list').className = 'group rides';
  $('#rides-list').innerHTML = `<p class="no-results">${offline ? 'Rides show up once your phone reconnects.' : 'Loading rides…'}</p>`;
}

function renderAll() {
  if (!dash) return renderNoData();
  renderHeader();
  renderDown();
  renderRides();
  renderTrip();
}

/* ---------- Sheets ---------- */
function openPause() {
  const st = alertState();
  // 7am on the park's clock: this morning if it's not 7 yet, else tomorrow.
  // The phone's own midnight would make a 12:30am pause last 30 hours.
  const tz = dash.park.timezone || undefined;
  const morning = nextLocalHour(Date.now(), tz, 7);
  const thisMorning = localDay(morning, tz) === localDay(Date.now(), tz);
  const options = [
    ['For 1 hour', Date.now() + 3600_000],
    ['For 3 hours', Date.now() + 3 * 3600_000],
    [thisMorning ? 'Until 7 this morning' : 'Until tomorrow morning', morning],
  ];
  const note = st.kind === 'closed'
    ? 'The park is closed, so alerts are already off until it opens.'
    : 'Nobody on this trip gets alerts while paused. The Down now list keeps updating.';
  const content = el(`<div>${sheetHead('Pause alerts', note)}</div>`);
  if (st.kind === 'paused') {
    const g = el(`<div class="group plain"><button class="row pressable" type="button">${icon('bell', 'row-icon tint-accent')}<span class="row-label">Resume alerts now</span></button></div>`);
    g.querySelector('button').onclick = () => { sheet.close(); setMute(null); };
    content.appendChild(g);
    content.appendChild(el('<div style="height:1.2rem"></div>'));
  }
  const g = el('<div class="group plain"></div>');
  for (const [label, until] of options) {
    const row = el(`<button class="row pressable" type="button"><span class="row-label">${label}</span></button>`);
    row.onclick = () => { sheet.close(); setMute({ until }); };
    g.appendChild(row);
  }
  content.appendChild(g);
  sheet.open(content);
}

function setMute(mute) {
  save((t) => { t.mute = mute; }, { mute }, (before) => {
    const text = mute ? `Alerts paused until ${fmtUntil(mute.until)}` : 'Alerts are back on';
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
  const content = el(`<div>${sheetHead('Park', 'Changes the park for everyone on this trip. Each park keeps its own follow list.')}</div>`);
  content.appendChild(parkGroups(dash.park.id, async (p) => {
    sheet.close();
    if (p.id === dash.park.id) return;
    const from = dash.park.id;
    try {
      await patchTrip({ parkId: p.id });
      await refresh();
      toast(`Switched to ${parkLabel(p.name)}`, {
        label: 'Undo',
        run: async () => { await patchTrip({ parkId: from }); refresh(); },
      });
    } catch {
      toast("Couldn't switch parks. Check your connection.");
    }
  }));
  content.appendChild(el('<div style="height:0.5rem"></div>'));
  sheet.open(content);
}

function openLeave() {
  const content = el(`<div>
    ${sheetHead('Leave this trip?', `This phone stops showing it. The trip keeps running for anyone else on it, and you can rejoin with code <strong>${esc(tripCode)}</strong>.`)}
    <div class="btn-stack">
      <button class="btn-secondary danger pressable" type="button" data-act="leave">Leave trip</button>
      <button class="btn-secondary pressable" type="button" data-act="cancel">Cancel</button>
    </div>
  </div>`);
  content.querySelector('[data-act=leave]').onclick = () => { sheet.close(); leaveTrip(); };
  content.querySelector('[data-act=cancel]').onclick = () => sheet.close();
  sheet.open(content);
}

// The whole point of the app lives in this sheet, so it opens on its own the
// first time a trip is created or joined, and stays one tap away after that.
function openAlertSetup() {
  const topic = dash.trip.topic;
  const base = dash.ntfyBase || 'https://ntfy.sh';
  const host = base.replace(/^https?:\/\//, '');
  const deepLink = `ntfy://${host}/${topic}?display=${encodeURIComponent(`ParkAlert ${tripCode}`)}${base.startsWith('https') ? '' : '&secure=false'}`;
  const ready = alertsReady();

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
    ${sheetHead('Get alerts on this phone', 'Alerts arrive through ntfy, a free notification app. No account needed, and it takes about a minute.')}
    <ol class="steps">
      <li class="step"><h3>Install ntfy</h3><p>Already have it? Skip ahead.</p>${install}</li>
      <li class="step"><h3>Subscribe to this trip</h3>${subscribe}</li>
      <li class="step ${ready ? 'done' : ''}"><h3>Send a test</h3>
        <p>${ready ? 'Alerts are working on this phone.' : 'Make sure it shows up as a notification.'}</p>
        <button class="btn-primary pressable" type="button" data-act="test">${icon('send')}<span>Send test alert</span></button>
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
    <div class="btn-stack"><button class="btn-secondary pressable" type="button" data-act="later">${ready ? 'Done' : 'Set up later'}</button></div>
  </div>`);

  const q = (a) => content.querySelector(`[data-act=${a}]`);
  if (q('copy')) {
    q('copy').onclick = async () => {
      try { await navigator.clipboard.writeText(topic); q('copy').textContent = 'Copied'; }
      catch { toast('Press and hold the topic to copy it'); }
    };
  }
  q('test').onclick = async () => {
    const btn = q('test');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Sending…';
    try {
      await api(`/trips/${tripCode}/test`, { method: 'POST' });
      btn.querySelector('span').textContent = 'Sent. Send another';
      content.querySelector('.confirm').classList.remove('hidden');
    } catch {
      btn.querySelector('span').textContent = "Couldn't send. Try again";
    }
    btn.disabled = false;
  };
  q('yes').onclick = () => {
    localStorage.setItem(alertsReadyKey(), '1');
    sheet.close();
    renderAll();
    toast('Alerts are working on this phone');
  };
  q('no').onclick = () => content.querySelector('.tip').classList.remove('hidden');
  q('later').onclick = () => sheet.close();
  sheet.open(content);
}

/* ---------- Detail sheets ---------- */
// What the open sheet is showing, so a background refresh can bring it up to date.
let sheetContext = null;

// Sheets opened from sheets (a ride from the hold or park sheet) stack:
// Back returns to the one below, rebuilt with fresh data.
const sheetStack = [];
function openSheet(content, context) {
  // The context is set after open(), which may first finish off a sheet
  // still closing (whose onClose clears the context). Ride sheets open at
  // the medium detent, so the list stays in view behind them.
  sheet.open(content, {
    detent: context.type === 'ride' ? 'medium' : 'large',
    onClose: () => { sheetContext = null; sheetStack.length = 0; },
  });
  sheetStack.length = 0;
  sheetContext = context;
  mountCharts($('#sheet-body'));
}
function pushSheet(content, context) {
  sheetStack.push(sheetContext);
  sheetContext = context;
  sheet.push(content);
  mountCharts($('#sheet-body'));
}
sheet.onBack = () => {
  if (!sheetStack.length) return false;
  sheetContext = sheetStack.pop();
  if (sheetContext.type === 'hold') sheet.replace(holdSheet());
  if (sheetContext.type === 'park') {
    sheet.replace(parkSheet(lastParkInfo));
    loadPark();
  }
  mountCharts($('#sheet-body'));
  return true;
};
const BACK_LABEL = { hold: 'Hold', park: 'Park' };

function updateSheet(content) {
  sheet.update(content, () => mountCharts($('#sheet-body')));
}

const KIND_NOTE = {
  hold: 'Several rides went down together, which usually means lightning nearby or another park-wide hold. These run longer than a breakdown, and the rides tend to reopen together.',
  opening: 'This ride did not open on time. Delayed openings are estimated from past delayed openings, not breakdowns.',
};

function statusLine(r) {
  if (r.status === 'DOWN' && r.downSince) return `Down for ${fmtDuration(Date.now() - r.downSince)}, since ${fmtTime(r.downSince)}`;
  return rideMeta(r);
}

// What a range rests on, in a few words for the card.
function basisLine(o) {
  if (!o?.basis) return '';
  if (o.cause) {
    if (o.basis.from === 'rule') return 'From the 30-minute lightning rule';
    return `From ${o.basis.outages} past ${o.cause === 'rain' ? 'rain closures' : 'storms'} ${o.basis.from === 'ride' ? 'for this ride' : 'at this park'}`;
  }
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  return `From ${o.basis.outages} past outages ${where}`;
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
  if (!o?.basis) return o?.text ? 'This outage is already longer than nearly every past one here, so there is no honest range to give.' : '';
  const kind = { hold: 'park-wide holds', opening: 'delayed openings' }[o.kind] || 'breakdowns';
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  return `Based on ${o.basis.outages} past ${kind} ${where} that lasted at least as long as this one has so far. The middle half of them reopened within the range above.`;
}

async function openRide(rideId) {
  const r = dash?.rides.find((x) => x.id === rideId);
  if (!r) return;
  // Open at once with what is already known; the history fills in a moment later.
  const from = sheet.isOpen && BACK_LABEL[sheetContext?.type];
  const context = { type: 'ride', id: rideId, back: from || null };
  if (from) pushSheet(rideSheet(r, null, from), context);
  else openSheet(rideSheet(r, null), context);
  await loadRide(rideId);
}

async function loadRide(rideId) {
  try {
    const detail = await api(`/trips/${tripCode}/rides/${encodeURIComponent(rideId)}`);
    if (sheetContext?.type === 'ride' && sheetContext.id === rideId) updateSheet(rideSheet(detail.ride, detail, sheetContext.back));
  } catch {
    if (sheetContext?.id === rideId) {
      const note = $('#sheet-body [data-loading]');
      if (note) note.textContent = "Couldn't load this ride's history. Pull down on the list to retry.";
    }
  }
}

// Wait alert: "tell me when the wait is at most N". Only limits under the
// current posted wait are offered, since one at or over it would go off at
// once; a ride that isn't posting a wait can take any of them.
const WAIT_CHOICES = [10, 15, 20, 30, 45, 60];

function waitAlertBlock(r) {
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
          ? `It's ${posted} min now. Tell me when it's at most:`
          : 'Tell me when it is running with a wait of at most:';
  const box = el(`
    <div>
      <h2 class="section-label">Wait alert</h2>
      <div class="group padded wait-alert">
        <p class="wait-state">${icon('timer', 'inline-icon')} ${esc(state)}</p>
        ${choices.length ? `<div class="chips" role="group" aria-label="Wait alert limit">
          ${choices.map((m) => `<button class="chip pressable" type="button" data-act="wait-${m}" aria-pressed="${armed && alert.max === m}">${m} min</button>`).join('')}
          ${armed ? '<button class="chip pressable" type="button" data-act="wait-off">Off</button>' : ''}
        </div>` : ''}
      </div>
      <p class="footnote">Goes to everyone on this trip, once, and only today.</p>
    </div>`);
  box.querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => {
      const m = b.dataset.act.slice(5);
      setWaitAlert(r.id, m === 'off' || (armed && Number(m) === alert.max) ? null : Number(m));
    };
  });
  return box;
}

async function setWaitAlert(rideId, max) {
  try {
    const path = `/trips/${tripCode}/wait-alerts/${encodeURIComponent(rideId)}`;
    const { trip } = await api(path, max == null ? { method: 'DELETE' } : { method: 'PUT', body: { max } });
    dash.trip = trip;
    renderAll();
    if (sheetContext?.type === 'ride' && sheetContext.id === rideId) loadRide(rideId);
    toast(max == null ? 'Wait alert off' : `We'll tell you when it's ${max} min or less`);
  } catch {
    toast("Couldn't save that. Check your connection and try again.");
  }
}

function rideSheet(r, detail, back = null) {
  const o = detail ? detail.outlook : r.outlook;
  const down = r.status === 'DOWN' && r.downSince;
  const wrap = el(`<div class="ride-sheet">${sheetHead(r.name, esc(statusLine(r)), back)}</div>`);
  wrap.querySelector('.sheet-head p').classList.toggle('tint-red', !!down);

  if (down) {
    const w = o?.window;
    const clock = w && w.lo != null
      ? `Likely back between ${fmtTime(Date.now() + w.lo * 60000)} and ${fmtTime(Date.now() + (w.hi ?? w.lo * 2) * 60000)}`
      : '';
    wrap.appendChild(el(`
      <div class="group padded outlook-block">
        ${o?.cause ? `<p class="kind-tag hold">${icon('bolt')}${o.cause === 'rain' ? 'Rain' : 'Lightning'}${o.weather === 'passed' ? ', now passed' : ''}${o.kind === 'hold' ? ' · park-wide hold' : ''}</p>`
          : o?.kind === 'hold' ? `<p class="kind-tag hold">${icon('bolt')}Park-wide hold</p>` : ''}
        ${o?.kind === 'opening' ? '<p class="kind-tag">Delayed opening</p>' : ''}
        <p class="big-outlook">${esc(o?.text || 'Not enough history to estimate yet')}</p>
        ${clock ? `<p class="clock">${esc(clock)}</p>` : ''}
        ${timeline({ ...r, outlook: o })}
        ${o?.text ? `<p class="explain">${esc(estimateExplainer(o))}</p>` : ''}
        ${o?.cause ? `<p class="explain">${esc(WEATHER_NOTE[o.cause])}</p>` : KIND_NOTE[o?.kind] ? `<p class="explain">${esc(KIND_NOTE[o.kind])}</p>` : ''}
      </div>`));
  }

  const follow = el(`
    <div class="group ${down ? 'spaced-sm' : ''}"><div class="row">
      ${icon('bell', 'row-icon tint-accent')}
      <span class="row-label">Alerts for this ride</span>
      <button class="switch" type="button" role="switch" aria-checked="${isFollowing(r.id)}" aria-label="Alerts for ${esc(r.name)}" data-act="follow"></button>
    </div></div>`);
  follow.querySelector('.switch').onclick = (e) => {
    toggleFollow(r.id);
    e.currentTarget.setAttribute('aria-checked', String(isFollowing(r.id)));
  };
  wrap.appendChild(follow);
  wrap.appendChild(waitAlertBlock(r));

  if (!detail) {
    wrap.appendChild(el('<p class="footnote" data-loading>Loading wait times and outage history…</p>'));
    return wrap;
  }

  // Wait times today
  const numeric = detail.waits.filter(([, v]) => v != null);
  if (numeric.length) {
    wrap.appendChild(el('<h2 class="section-label">Wait times today</h2>'));
    const box = el('<div class="group padded" data-chart="wait"></div>');
    box._data = { waits: detail.waits, now: detail.now };
    wrap.appendChild(box);
    wrap.appendChild(el('<p class="footnote">Drag across the chart to see the wait at any time. Gaps are when it was down or closed.</p>'));
  }

  // Today. If the ride went down before today's log begins, the live
  // down-since time still says when, so show that rather than nothing.
  wrap.appendChild(el('<h2 class="section-label">Today</h2>'));
  const today = [...detail.today];
  if (down && !today.some((e) => e.type === 'DOWN' && e.at >= r.downSince - 120_000)) {
    today.push({ type: 'DOWN', at: r.downSince, opening: o?.kind === 'opening' });
    today.sort((a, b) => a.at - b.at);
  }
  if (today.length) {
    wrap.appendChild(el(`<div class="group">${today.map((e) => `
      <div class="row">
        ${e.type === 'CLOSED' ? icon('moon', 'row-icon tint-orange') : icon(e.type === 'DOWN' ? 'down' : 'arrow-up', `row-icon ${e.type === 'DOWN' ? 'tint-red' : 'tint-green'}`)}
        <span class="row-label">${e.type === 'CLOSED' ? 'Closed' : e.type === 'DOWN' ? (e.opening ? 'Delayed opening' : 'Went down') : e.late ? 'Opened' : 'Back up'}${
          e.type === 'UP' && e.downtimeMs ? `<small>${e.late ? `${fmtDuration(e.downtimeMs)} late` : `after ${fmtDuration(e.downtimeMs)}`}</small>`
          : e.type === 'CLOSED' && e.downtimeMs ? `<small>after ${fmtDuration(e.downtimeMs)} down</small>` : ''}</span>
        <span class="row-detail">${fmtTime(e.at)}</span>
      </div>`).join('')}</div>`));
  } else {
    wrap.appendChild(el('<div class="group plain"><div class="row"><span class="row-label muted">No outages so far today</span></div></div>'));
  }

  // History
  const h = detail.history;
  if (h.archivedDays) {
    wrap.appendChild(el(`<h2 class="section-label">Last ${h.days.length} days</h2>`));
    const stats = el(`
      <div class="group padded">
        <div class="stats">
          <div><p class="stat-label">Outages</p><p class="stat-value">${h.days.reduce((n, d) => n + d.outages, 0)}</p></div>
          <div><p class="stat-label">Typical</p><p class="stat-value">${h.typicalMinutes != null ? fmtDuration(h.typicalMinutes * 60000) : 'n/a'}</p></div>
          <div><p class="stat-label">Longest</p><p class="stat-value">${h.longestMinutes != null ? fmtDuration(h.longestMinutes * 60000) : 'n/a'}</p></div>
        </div>
        <div data-chart="days"></div>
      </div>`);
    stats.querySelector('[data-chart]')._data = { days: h.days };
    wrap.appendChild(stats);
    if (h.last.length) {
      wrap.appendChild(el('<h2 class="section-label">Recent outages</h2>'));
      wrap.appendChild(el(`<div class="group plain">${h.last.map((ep) => `
        <div class="row">
          <span class="row-label">${esc(fmtDay(ep.start))}<small>${esc([
            { hold: 'Park-wide hold', opening: 'Delayed opening' }[ep.kind],
            ep.reopened ? '' : "Didn't reopen that day",
          ].filter(Boolean).join(' · ') || `Went down at ${fmtTime(ep.start)}`)}</small></span>
          <span class="row-detail">${ep.reopened ? fmtDuration(ep.minutes * 60000) : ''}</span>
        </div>`).join('')}</div>`));
    }
    wrap.appendChild(el(`<p class="footnote">Outage history comes from the ThemeParks.wiki archive, ${h.archivedDays} days so far and growing nightly.</p>`));
  }
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  return wrap;
}

function fmtDay(ts) {
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: dash?.park.timezone }).format(new Date(ts));
}

async function openParkInfo() {
  if (!dash) return;
  openSheet(parkSheet(null), { type: 'park' });
  await loadPark();
}

let lastParkInfo = null;
async function loadPark() {
  try {
    const info = await api(`/trips/${tripCode}/park`);
    lastParkInfo = info;
    if (sheetContext?.type === 'park') updateSheet(parkSheet(info));
  } catch {}
}

function parkSheet(info) {
  const downNow = dash.rides.filter((r) => r.status === 'DOWN').length;
  const wrap = el(`<div>${sheetHead(parkLabel(dash.park.name), esc(hoursText()))}</div>`);
  const { openingTime: open, closingTime: close, lateEvent } = dash.park;
  if (open || close) {
    wrap.appendChild(el(`<div class="group plain">
      ${open ? `<div class="row"><span class="row-label">Opens</span><span class="row-detail">${fmtTime(Date.parse(open))}</span></div>` : ''}
      ${close ? `<div class="row"><span class="row-label">Closes</span><span class="row-detail">${fmtTime(Date.parse(close))}</span></div>` : ''}
      ${lateEvent ? `<div class="row"><span class="row-label">${esc(lateEvent.name)}<small>Alerts keep going until it ends</small></span><span class="row-detail">until ${fmtTime(Date.parse(lateEvent.closingTime))}</span></div>` : ''}
    </div>`));
  }
  wrap.appendChild(el(`<div class="group padded spaced-sm"><div class="stats">
    <div><p class="stat-label">Down now</p><p class="stat-value">${downNow}</p></div>
    <div><p class="stat-label">Outages today</p><p class="stat-value">${info ? info.today.downs : '…'}</p></div>
    <div><p class="stat-label">Typical outage</p><p class="stat-value">${info?.week.typicalBreakdownMinutes != null ? fmtDuration(info.week.typicalBreakdownMinutes * 60000) : info ? 'n/a' : '…'}</p></div>
  </div></div>`));
  if (info?.week.leastReliable.length) {
    wrap.appendChild(el(`<h2 class="section-label">Most outages, last ${info.week.days} days</h2>`));
    // Only rides in today's live data have a sheet to open; one that has been
    // renamed or closed for the season is listed, not offered as a button.
    const live = new Set(dash.rides.map((r) => r.id));
    wrap.appendChild(el(`<div class="group plain">${info.week.leastReliable.map((r) => {
      const label = `<span class="row-label">${esc(r.name)}<small>${r.outages} outage${r.outages === 1 ? '' : 's'}, ${fmtDuration(r.minutes * 60000)} down in total</small></span>`;
      return live.has(r.id)
        ? `<button class="row pressable" type="button" data-ride="${esc(r.id)}">${label}${icon('chevron', 'chevron')}</button>`
        : `<div class="row">${label}</div>`;
    }).join('')}</div>`));
    if (info.week.holdDays) {
      wrap.appendChild(el(`<p class="footnote">Park-wide holds happened on ${info.week.holdDays} of those ${info.week.days} days.</p>`));
    }
  }
  if (info?.estimates?.groups.length) {
    // How the reopen estimates have done here, scored as rides came back.
    wrap.appendChild(el(`<h2 class="section-label">How the estimates did, last ${info.estimates.days} days</h2>`));
    wrap.appendChild(el(`<div class="group plain">${info.estimates.groups.map((g) => `
      <div class="row"><span class="row-label">${esc(g.label)}<small>${g.n} outage${g.n === 1 ? '' : 's'}${g.closed ? `, ${g.closed} closed for the day` : ''} · ranges about ${g.width} min wide</small></span>
      <span class="row-detail">${g.inRange}% in range</span></div>`).join('')}</div>`));
    wrap.appendChild(el('<p class="footnote">A range is the middle half of past outages like it, so about half should land inside. Ranges after the weather clears are the tight ones; breakdowns are hard to call closely.</p>'));
  }
  wrap.appendChild(el(`<p class="footnote">${dash.lastPoll ? `Ride status updated at ${fmtTime(dash.lastPoll)}. ` : ''}Pull down on any list to refresh.</p>`));
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  return wrap;
}

function openHold() {
  openSheet(holdSheet(), { type: 'hold' });
}

function holdSheet() {
  const holds = dash.rides.filter((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold');
  const text = holds[0]?.outlook?.text;
  const wrap = el(`<div>${sheetHead('Park-wide hold', esc(KIND_NOTE.hold))}</div>`);
  if (!holds.length) {
    // Left open while the rides came back: say so rather than go blank.
    wrap.appendChild(el(`<div class="group padded"><p class="big-outlook">The hold is over</p><p class="explain">Every ride in it is running again or has closed. They're listed under Back up recently on Down now.</p></div>`));
    return wrap;
  }
  if (text) wrap.appendChild(el(`<div class="group padded"><p class="big-outlook">${esc(text)}</p><p class="explain">${esc(estimateExplainer(holds[0].outlook))}</p></div>`));
  wrap.appendChild(el(`<h2 class="section-label">${holds.length} ride${holds.length === 1 ? '' : 's'} still in this hold</h2>`));
  wrap.appendChild(el(`<div class="group plain">${holds.map((r) => `
    <button class="row pressable" type="button" data-ride="${esc(r.id)}">
      <span class="row-label">${esc(r.name)}<small>Down since ${fmtTime(r.downSince)}</small></span>
      <span class="row-detail">${fmtDuration(Date.now() - r.downSince)}</span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`));
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  return wrap;
}

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

function mountCharts(root) {
  for (const box of root.querySelectorAll('[data-chart]')) {
    if (box._mounted || !box._data) continue;
    box._mounted = true;
    if (box.dataset.chart === 'wait') waitChart(box, box._data);
    if (box.dataset.chart === 'days') dayBars(box, box._data);
  }
}

// Posted waits hold until they change, so the line steps rather than slopes.
function waitChart(box, { waits, now }) {
  const W = Math.max(200, box.clientWidth - 32), H = 116, top = 16, bottom = 2;
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
    svgEl('line', { x1: 0, x2: W, y1: base, y2: base, class: 'axis' })
  );
  const maxLabel = svgEl('text', { x: 0, y: y(max) - 3, class: 'tick' });
  maxLabel.textContent = `${max} min`;
  svg.append(maxLabel);

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
  svg.addEventListener('keydown', (e) => {
    const step = (t1 - t0) / 40;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      cursor = Math.min(t1, Math.max(t0, cursor + (e.key === 'ArrowRight' ? step : -step)));
      show(cursor, true);
    }
  });

  const axis = el(`<div class="chart-x"><span>${fmtTime(t0)}</span><span>Now</span></div>`);
  box.append(readout, svg, axis);
}

// One column per archived day: minutes down. Tap a column for that day.
function dayBars(box, { days }) {
  const W = Math.max(200, box.clientWidth), H = 96, base = H - 2;
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
  const labels = el(`<div class="chart-days" style="grid-template-columns:repeat(${days.length},1fr)">${days.map((d) => `<span>${esc(fmtWeekday(d.date))}</span>`).join('')}</div>`);
  box.append(readout, svg, labels);
}

const dateOnly = (d) => new Date(`${d}T12:00:00Z`);
const fmtDate = (d) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateOnly(d));
const fmtWeekday = (d) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short', timeZone: 'UTC' }).format(dateOnly(d));

/* ---------- Pull to refresh ---------- */
// Only on touch, only from the very top, rubber-banded, and it springs home.
(() => {
  const main = $('main'), ptr = $('#ptr');
  const THRESHOLD = 64, HOLD = 52;
  let start = null, pull = 0, busy = false, anim = null;
  const paint = (v) => {
    pull = v;
    main.style.transform = v ? `translateY(${v}px)` : '';
    ptr.style.opacity = String(Math.min(1, v / THRESHOLD));
    ptr.style.transform = `translateY(${v / 2 - 30}px) rotate(${v * 4}deg)`;
    ptr.classList.toggle('armed', v >= THRESHOLD);
  };
  const settle = (to, done) => {
    anim?.stop();
    if (reducedMotion()) { paint(to); done?.(); return; }
    anim = spring({ from: pull, to, damping: 1, response: 0.3, onUpdate: paint, onDone: done });
  };
  main.addEventListener('touchstart', (e) => {
    if (busy || sheet.isOpen || scrollY > 0 || e.touches.length > 1) return;
    anim?.stop();
    start = e.touches[0].clientY;
  }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (start == null) return;
    const dy = e.touches[0].clientY - start;
    if (dy <= 0) { if (pull) paint(0); return; }
    if (e.target.closest('.chart')) { start = null; return; }
    e.preventDefault();
    paint(rubberband(dy, 480, 0.55));
  }, { passive: false });
  main.addEventListener('touchend', async () => {
    if (start == null) return;
    start = null;
    if (pull < THRESHOLD) { settle(0); return; }
    busy = true;
    ptr.classList.add('spinning');
    navigator.vibrate?.(8);
    settle(HOLD);
    await refresh();
    ptr.classList.remove('spinning');
    settle(0, () => { busy = false; });
  });
})();

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
  }
  renderAll();
  if (!offline && sheetContext?.type === 'ride') loadRide(sheetContext.id);
  if (!offline && sheetContext?.type === 'park') loadPark();
  if (sheetContext?.type === 'hold') updateSheet(holdSheet());
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
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
  if (pendingOpen) openPending();
  else if (firstRun && dash && !alertsReady()) openAlertSetup();
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
    if (dash.rides.some((r) => r.id === ride)) openRide(ride);
    else toast("That ride isn't in today's ride list any more");
  } else if (view === 'hold' && dash.rides.some((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold')) {
    openHold();
  }
}

// Each tab keeps its own scroll position, as in any tab bar app; only
// tapping the tab you're already on goes back to the top.
const scrollByView = {};
function switchView(name, { top = false } = {}) {
  if (name !== view) scrollByView[view] = scrollY;
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
$('#btn-alerts').onclick = withDash(() => (alertState().kind === 'setup' ? openAlertSetup() : openPause()));
$('#row-setup').onclick = withDash(openAlertSetup);
$('#row-pause').onclick = withDash(openPause);
$('#row-park').onclick = withDash(openPark);
$('#row-leave').onclick = openLeave;
$('#row-test').onclick = async () => {
  const d = $('#test-detail');
  d.textContent = 'Sending…';
  try {
    await api(`/trips/${tripCode}/test`, { method: 'POST' });
    toast('Test alert sent. Check your notifications.');
  } catch (err) {
    toast(err.status === 429 ? 'That was a lot of tests. Try again in a few minutes.' : "Couldn't send the test. Try again in a moment.");
  }
  d.textContent = '';
};

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

$('#ride-search').addEventListener('input', () => dash && renderRides());
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
addEventListener('offline', () => { offline = true; if (dash) renderHeader(); });

// Keep elapsed times honest between refreshes.
setInterval(() => {
  if (!dash || document.hidden) return;
  renderHeader();
  renderDown();
  if (sheetContext?.type === 'hold') updateSheet(holdSheet());
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
  const params = new URLSearchParams(location.search);
  const joinParam = params.get('join');
  // A tapped push: ?trip=CODE and a ride or view to open. On iPhone the link
  // may open in Safari, which has its own storage and no saved trip, so the
  // code in the link decides which trip to show.
  const tripParam = params.get('trip');
  if (params.get('ride') || params.get('view')) pendingOpen = { ride: params.get('ride'), view: params.get('view') };
  if (tripParam && !joinParam) {
    history.replaceState(null, '', '/');
    const code = tripParam.toUpperCase();
    if (code !== tripCode) {
      const previous = tripCode;
      setTrip(code);
      if (previous) toast(`Showing trip ${code}`, { label: 'Undo', run: () => setTrip(previous) });
      return;
    }
  }
  if (joinParam) {
    history.replaceState(null, '', '/');
    setPendingInvite(joinParam.toUpperCase());
    if (await tryInvite()) return;
  }

  // A saved trip opens straight away, online or not. A trip that no longer
  // exists is caught by the first refresh, which says so and leaves it.
  if (tripCode) showApp();
  else showSetup();
  // An invite opened offline earlier, still waiting.
  if (!joinParam && pendingInvite()) {
    setPendingInvite(pendingInvite());
    if (navigator.onLine !== false) tryInvite();
  }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
