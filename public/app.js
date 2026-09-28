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
function fmtTime(ts) {
  if (ts == null) return '';
  return new Intl.DateTimeFormat([], {
    hour: 'numeric', minute: '2-digit', timeZone: dash?.park.timezone || undefined,
  }).format(new Date(ts));
}

// A time that may not be today, said the way a person would: "9:30 PM",
// "tomorrow at 7:00 AM", or "Mon at 7:00 AM". Park days, not phone days.
function fmtUntil(ts) {
  const tz = dash?.park.timezone || undefined;
  const today = localDay(Date.now(), tz);
  const day = localDay(ts, tz);
  if (day === today) return fmtTime(ts);
  if (day === localDay(Date.now() + 24 * 3600_000, tz)) return `tomorrow at ${fmtTime(ts)}`;
  const weekday = new Intl.DateTimeFormat([], { weekday: 'short', timeZone: tz }).format(new Date(ts));
  return `${weekday} at ${fmtTime(ts)}`;
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function sortKey(name) {
  return name.replace(/^[^a-z0-9]+/i, '').replace(/^the\s+/i, '').toLowerCase();
}

const alertsReadyKey = () => `parkalert.alertsReady.${tripCode}`;
const alertsReady = () => localStorage.getItem(alertsReadyKey()) === '1';

/* ---------- API ---------- */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
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
const project = (v, rate = 0.99) => ((v / 1000) * rate) / (1 - rate);

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/* ---------- Sheet ---------- */
const sheet = (() => {
  const layer = $('#sheet-layer'), panel = $('#sheet'), scrim = $('#scrim'), body = $('#sheet-body');
  let y = 0, h = 1, anim = null, isOpen = false, returnFocus = null, onClosed = null;

  const paint = (v) => {
    y = v;
    panel.style.transform = `translateY(${v}px)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v / h)));
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
    layer.classList.add('hidden');
    setInert(false);
    body.replaceChildren();
    returnFocus?.focus?.({ preventScroll: true });
    const cb = onClosed;
    onClosed = null;
    cb?.();
  }

  function open(content, { onClose } = {}) {
    returnFocus = document.activeElement;
    onClosed = onClose || null;
    body.replaceChildren(content);
    body.scrollTop = 0;
    layer.classList.remove('hidden');
    setInert(true);
    h = panel.getBoundingClientRect().height || 400;
    if (!isOpen) paint(h);
    isOpen = true;
    animateTo(0);
    panel.focus({ preventScroll: true });
  }

  function close(velocity = 0) {
    if (!isOpen) return;
    isOpen = false;
    animateTo(h, velocity, 1, finishClose);
  }

  // Drag: 1:1 with the finger from where it grabbed, rubber-banded above the
  // top, and on release the flick's projected resting point decides.
  let drag = null;
  function down(e) {
    if (e.button > 0 || !isOpen) return;
    if (e.target.closest('button, a, input')) return;
    anim?.stop();
    drag = { startY: e.clientY, from: y, samples: [{ t: e.timeStamp, y }], id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    let next = drag.from + (e.clientY - drag.startY);
    if (next < 0) next = rubberband(next, h);
    paint(next);
    drag.samples.push({ t: e.timeStamp, y: next });
    if (drag.samples.length > 6) drag.samples.shift();
  }
  function up(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const s = drag.samples, a = s[0], b = s[s.length - 1];
    const v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s
    drag = null;
    if (y + project(v) > h * 0.45) close(v);
    // Settling back after a flick carries its momentum, so a little give reads right.
    else animateTo(0, v, Math.abs(v) > 300 ? 0.82 : 1);
  }
  for (const zone of [$('#grabber'), body]) {
    zone.addEventListener('pointerdown', (e) => {
      // In the scrolling body, only the header region drags the sheet.
      if (zone === body && !e.target.closest('.sheet-head')) return;
      down(e);
    });
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
  }
  scrim.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });

  // A finger on the sheet (scrubbing a chart, say) holds off live refreshes.
  let touching = false;
  body.addEventListener('pointerdown', () => { touching = true; });
  for (const t of ['pointerup', 'pointercancel']) addEventListener(t, () => { touching = false; }, true);

  // Swap content in place (live refresh), keeping the reader's scroll
  // position and focus. Skipped mid-touch; the next refresh catches up.
  function update(content) {
    if (!isOpen || touching) return;
    const top = body.scrollTop;
    keepFocus(body, () => body.replaceChildren(content));
    body.scrollTop = top;
  }

  return { open, update, close: () => close(), get isOpen() { return isOpen; } };
})();

function sheetHead(title, html) {
  return `<div class="sheet-head"><h2 class="title-2" id="sheet-title">${esc(title)}</h2>${html ? `<p>${html}</p>` : ''}</div>`;
}

/* ---------- Parks ---------- */
const RESORTS = [
  { name: 'Walt Disney World', timezone: 'America/New_York' },
  { name: 'Disneyland Resort', timezone: 'America/Los_Angeles' },
];
const parkLabel = (name) => name.replace(' (CA)', '');

// The park list is only needed to pick a park, so a phone that already has a
// trip never waits on it (or fails without it) at launch.
async function loadParks() {
  if (!parks.length) ({ parks } = await api('/parks'));
  return parks;
}

function parkGroups(currentId, onPick) {
  const wrap = document.createElement('div');
  for (const resort of RESORTS) {
    const list = parks.filter((p) => p.timezone === resort.timezone);
    if (!list.length) continue;
    wrap.appendChild(el(`<h2 class="section-label">${esc(resort.name)}</h2>`));
    const group = el('<div class="group plain"></div>');
    for (const p of list) {
      const selected = p.id === currentId;
      const row = el(`
        <button class="row pressable ${selected ? 'selected' : ''}" type="button" ${selected ? 'aria-current="true"' : ''}>
          <span class="row-label">${esc(parkLabel(p.name))}</span>
          ${selected ? icon('check', 'check') : icon('chevron', 'chevron')}
        </button>`);
      row.onclick = () => onPick(p);
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
  $('#setup-parks').replaceChildren(parkGroups(null, (p) => startTrip(p.id)));
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

async function startTrip(parkId) {
  try {
    const { trip } = await api('/trips', { method: 'POST', body: { parkId } });
    setTrip(trip.code, { firstRun: true });
  } catch {
    setupStatus("Can't reach ParkAlert right now. Check your connection.", true);
  }
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
  const close = dash.park.lateEvent?.closingTime || dash.park.closingTime;
  if (close && Date.now() > Date.parse(close)) return { kind: 'closed' };
  if (!alertsReady()) return { kind: 'setup' };
  return { kind: 'on' };
}

function hoursText() {
  const { openingTime: open, closingTime: close, lateEvent } = dash.park;
  const now = Date.now();
  const lastClose = lateEvent?.closingTime || close;
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
    ? `Offline · showing ${fmtTime(dash.lastPoll)} data`
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
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis?.from] || 'across all parks';
  const foot = [
    o.basis ? `From ${o.basis.outages} past outages ${where}` : '',
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

// Rides that came back recently, so an alert opened late still makes sense.
function renderRecent(downIds) {
  const block = $('#recent-block');
  const seen = new Set();
  const ups = (dash.recent || []).filter((e) => {
    if (e.type !== 'UP' || downIds.has(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  block.replaceChildren();
  if (!ups.length) return;
  block.appendChild(el('<h2 class="section-label">Back up recently</h2>'));
  block.appendChild(el(`<div class="group">${ups.map((e) => `
    <button class="row recent-row pressable" type="button" data-ride="${esc(e.id)}">
      ${icon('arrow-up', 'row-icon tint-green')}
      <span class="row-label">${esc(e.name)}<small>Back at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}</small></span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`));
}

/* ---------- Rides ---------- */
function rideMeta(r) {
  if (r.status === 'OPERATING') return `Open${r.waitTime != null ? ` · ${r.waitTime} min wait` : ''}`;
  if (r.status === 'DOWN') return `Down ${r.downSince ? fmtDuration(Date.now() - r.downSince) : ''}`.trim();
  if (r.status === 'REFURBISHMENT') return 'Refurbishment';
  return 'Closed';
}

function renderRides() {
  keepFocus($('#rides-list'), drawRides);
}

function drawRides() {
  const q = $('#ride-search').value.trim().toLowerCase();
  const all = [...dash.rides].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  const shown = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
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
            <span class="meta ${r.status}"><span class="dot ${r.status}"></span>${esc(rideMeta(r))}${icon('chevron', 'meta-chevron')}</span>
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

function openSheet(content, context) {
  sheetContext = context;
  sheet.open(content, { onClose: () => { sheetContext = null; } });
  mountCharts($('#sheet-body'));
}

function updateSheet(content) {
  sheet.update(content);
  mountCharts($('#sheet-body'));
}

const KIND_NOTE = {
  hold: 'Several rides went down together, which usually means lightning nearby or another park-wide hold. These run longer than a breakdown, and the rides tend to reopen together.',
  opening: 'This ride did not open on time. Delayed openings are estimated from past delayed openings, not breakdowns.',
};

function statusLine(r) {
  if (r.status === 'DOWN' && r.downSince) return `Down for ${fmtDuration(Date.now() - r.downSince)}, since ${fmtTime(r.downSince)}`;
  return rideMeta(r);
}

function estimateExplainer(o) {
  if (!o?.basis) return o?.text ? 'This outage is already longer than nearly every past one here, so there is no honest range to give.' : '';
  const kind = { hold: 'park-wide holds', opening: 'delayed openings' }[o.kind] || 'breakdowns';
  const where = { ride: 'of this ride', park: 'at this park' }[o.basis.from] || 'across all parks';
  return `Based on ${o.basis.outages} past ${kind} ${where} that lasted at least as long as this one has so far. The middle half of them reopened within the range above.`;
}

async function openRide(rideId) {
  const r = dash?.rides.find((x) => x.id === rideId);
  if (!r) return;
  // Open at once with what is already known; the history fills in a moment later.
  openSheet(rideSheet(r, null), { type: 'ride', id: rideId });
  await loadRide(rideId);
}

async function loadRide(rideId) {
  try {
    const detail = await api(`/trips/${tripCode}/rides/${encodeURIComponent(rideId)}`);
    if (sheetContext?.type === 'ride' && sheetContext.id === rideId) updateSheet(rideSheet(detail.ride, detail));
  } catch {
    if (sheetContext?.id === rideId) {
      const note = $('#sheet-body [data-loading]');
      if (note) note.textContent = "Couldn't load this ride's history. Pull down on the list to retry.";
    }
  }
}

function rideSheet(r, detail) {
  const o = detail ? detail.outlook : r.outlook;
  const down = r.status === 'DOWN' && r.downSince;
  const wrap = el(`<div class="ride-sheet">${sheetHead(r.name, esc(statusLine(r)))}</div>`);
  wrap.querySelector('.sheet-head p').classList.toggle('tint-red', !!down);

  if (down) {
    const w = o?.window;
    const clock = w && w.lo != null
      ? `Likely back between ${fmtTime(Date.now() + w.lo * 60000)} and ${fmtTime(Date.now() + (w.hi ?? w.lo * 2) * 60000)}`
      : '';
    wrap.appendChild(el(`
      <div class="group padded outlook-block">
        ${o?.kind === 'hold' ? `<p class="kind-tag hold">${icon('bolt')}Park-wide hold</p>` : ''}
        ${o?.kind === 'opening' ? '<p class="kind-tag">Delayed opening</p>' : ''}
        <p class="big-outlook">${esc(o?.text || 'Not enough history to estimate yet')}</p>
        ${clock ? `<p class="clock">${esc(clock)}</p>` : ''}
        ${timeline({ ...r, outlook: o })}
        ${o?.text ? `<p class="explain">${esc(estimateExplainer(o))}</p>` : ''}
        ${KIND_NOTE[o?.kind] ? `<p class="explain">${esc(KIND_NOTE[o.kind])}</p>` : ''}
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
    today.push({ type: 'DOWN', at: r.downSince });
    today.sort((a, b) => a.at - b.at);
  }
  if (today.length) {
    wrap.appendChild(el(`<div class="group">${today.map((e) => `
      <div class="row">
        ${icon(e.type === 'DOWN' ? 'down' : 'arrow-up', `row-icon ${e.type === 'DOWN' ? 'tint-red' : 'tint-green'}`)}
        <span class="row-label">${e.type === 'DOWN' ? 'Went down' : 'Back up'}${e.type === 'UP' && e.downtimeMs ? `<small>after ${fmtDuration(e.downtimeMs)}</small>` : ''}</span>
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
          <span class="row-detail">${ep.reopened ? '' : 'at least '}${fmtDuration(ep.minutes * 60000)}</span>
        </div>`).join('')}</div>`));
    }
    wrap.appendChild(el(`<p class="footnote">Outage history comes from the ThemeParks.wiki archive, ${h.archivedDays} days so far and growing nightly.</p>`));
  }
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  return wrap;
}

function fmtDay(ts) {
  return new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: dash?.park.timezone }).format(new Date(ts));
}

async function openParkInfo() {
  if (!dash) return;
  openSheet(parkSheet(null), { type: 'park' });
  await loadPark();
}

async function loadPark() {
  try {
    const info = await api(`/trips/${tripCode}/park`);
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
    wrap.appendChild(el(`<div class="group plain">${info.week.leastReliable.map((r) => `
      <button class="row pressable" type="button" data-ride="${esc(r.id)}">
        <span class="row-label">${esc(r.name)}<small>${r.outages} outage${r.outages === 1 ? '' : 's'}, ${fmtDuration(r.minutes * 60000)} down in total</small></span>
        ${icon('chevron', 'chevron')}
      </button>`).join('')}</div>`));
    if (info.week.holdDays) {
      wrap.appendChild(el(`<p class="footnote">Park-wide holds happened on ${info.week.holdDays} of those ${info.week.days} days.</p>`));
    }
  }
  wrap.appendChild(el(`<p class="footnote">${dash.lastPoll ? `Ride status updated at ${fmtTime(dash.lastPoll)}. ` : ''}Pull down on any list to refresh.</p>`));
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  return wrap;
}

function openHold() {
  const holds = dash.rides.filter((r) => r.status === 'DOWN' && r.outlook?.kind === 'hold');
  const text = holds[0]?.outlook?.text;
  const wrap = el(`<div>${sheetHead('Park-wide hold', esc(KIND_NOTE.hold))}</div>`);
  if (text) wrap.appendChild(el(`<div class="group padded"><p class="big-outlook">${esc(text)}</p><p class="explain">${esc(estimateExplainer(holds[0].outlook))}</p></div>`));
  wrap.appendChild(el(`<h2 class="section-label">${holds.length} rides in this hold</h2>`));
  wrap.appendChild(el(`<div class="group plain">${holds.map((r) => `
    <button class="row pressable" type="button" data-ride="${esc(r.id)}">
      <span class="row-label">${esc(r.name)}<small>Down since ${fmtTime(r.downSince)}</small></span>
      <span class="row-detail">${fmtDuration(Date.now() - r.downSince)}</span>
      ${icon('chevron', 'chevron')}
    </button>`).join('')}</div>`));
  wrap.appendChild(el('<div style="height:1rem"></div>'));
  openSheet(wrap, { type: 'hold' });
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
const fmtDate = (d) => new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(dateOnly(d));
const fmtWeekday = (d) => new Intl.DateTimeFormat([], { weekday: 'short', timeZone: 'UTC' }).format(dateOnly(d));

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
async function refresh() {
  if (!tripCode) return;
  try {
    dash = await api(`/trips/${tripCode}/dashboard`);
    offline = false;
  } catch (err) {
    if (err.status === 404) {
      toast(`Trip ${tripCode} no longer exists`);
      leaveTrip();
      return;
    }
    offline = true;
  }
  renderAll();
  if (!offline && sheetContext?.type === 'ride') loadRide(sheetContext.id);
  if (!offline && sheetContext?.type === 'park') loadPark();
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
  switchView('down');
  renderAll();
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
  if (firstRun && dash && !alertsReady()) openAlertSetup();
}

function switchView(name) {
  view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
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

const nav = $('#nav');
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 2), { passive: true });

// Coming back (to the tab, or online) catches up whichever screen is showing.
const resume = () => (onSetup() ? (!parks.length && renderSetupParks()) : refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
addEventListener('online', resume);
addEventListener('offline', () => { offline = true; if (dash) renderHeader(); });

// Keep elapsed times honest between refreshes.
setInterval(() => {
  if (!dash || document.hidden) return;
  renderHeader();
  renderDown();
}, TICK_MS);

/* ---------- Boot ---------- */
(async function boot() {
  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam) {
    history.replaceState(null, '', '/');
    const code = joinParam.toUpperCase();
    const previous = tripCode;
    try {
      await api(`/trips/${code}`);
      setTrip(code, { firstRun: previous !== code });
      // Tapping someone's invite should never silently strand your own trip.
      if (previous && previous !== code) {
        toast(`Joined trip ${code}`, { label: 'Undo', run: () => setTrip(previous) });
      }
      return;
    } catch (err) {
      toast(err.status === 404
        ? `Invite code ${code} wasn't found`
        : `Couldn't open the invite. Check your connection, or join with code ${code}.`);
    }
  }

  // A saved trip opens straight away, online or not. A trip that no longer
  // exists is caught by the first refresh, which says so and leaves it.
  if (tripCode) showApp();
  else showSetup();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
