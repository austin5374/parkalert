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

  function finishClose() {
    layer.classList.add('hidden');
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

  return { open, close: () => close(), get isOpen() { return isOpen; } };
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

// Location is asked for only when the person taps for it, never on arrival.
function locate() {
  if (!navigator.geolocation || !window.isSecureContext) {
    setupStatus('Location needs a secure connection here. Pick your park below.', true);
    return;
  }
  setupStatus('Finding your park…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
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
  pill.setAttribute('aria-label', st.kind === 'paused' && st.until ? `Alerts paused until ${fmtTime(st.until)}` : label);

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
    <article class="card ${following ? '' : 'unfollowed'}">
      <div class="card-top">
        <h3 class="card-title">${esc(r.name)}</h3>
        <span class="elapsed">${fmtDuration(Date.now() - r.downSince)}</span>
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
  const list = $('#down-list');
  const down = dash.rides
    .filter((r) => r.status === 'DOWN' && r.downSince)
    .sort((a, b) => (isFollowing(b.id) - isFollowing(a.id)) || b.downSince - a.downSince);
  list.replaceChildren();

  if (!down.length) {
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
      list.appendChild(el(`<p class="hold-header">${icon('bolt')}<span>Park-wide hold · ${holds.length} rides</span></p>`));
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
    <div class="row recent-row">
      ${icon('arrow-up', 'row-icon tint-green')}
      <span class="row-label">${esc(e.name)}<small>Back at ${fmtTime(e.at)}${e.downtimeMs ? ` after ${fmtDuration(e.downtimeMs)}` : ''}</small></span>
    </div>`).join('')}</div>`));
}

/* ---------- Rides ---------- */
function rideMeta(r) {
  if (r.status === 'OPERATING') return `Open${r.waitTime != null ? ` · ${r.waitTime} min wait` : ''}`;
  if (r.status === 'DOWN') return `Down ${r.downSince ? fmtDuration(Date.now() - r.downSince) : ''}`.trim();
  if (r.status === 'REFURBISHMENT') return 'Refurbishment';
  return 'Closed';
}

function renderRides() {
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
        <span class="row-label">${esc(r.name)}
          <span class="meta ${r.status}"><span class="dot ${r.status}"></span>${esc(rideMeta(r))}</span>
        </span>
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
  $('#pause-detail').textContent = st.kind === 'paused' ? (st.until ? `Until ${fmtTime(st.until)}` : 'Paused') : 'Off';
  $('#park-detail').textContent = parkLabel(dash.park.name);
}

function renderAll() {
  if (!dash) return;
  renderHeader();
  renderDown();
  renderRides();
  renderTrip();
}

/* ---------- Sheets ---------- */
function openPause() {
  const st = alertState();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(7, 0, 0, 0);
  const options = [
    ['For 1 hour', Date.now() + 3600_000],
    ['For 3 hours', Date.now() + 3 * 3600_000],
    ['Until tomorrow morning', tomorrow.getTime()],
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
    const text = mute ? `Alerts paused until ${fmtTime(mute.until)}` : 'Alerts are back on';
    toast(text, { label: 'Undo', run: () => save((t) => { t.mute = before.mute; }, { mute: before.mute }) });
  });
}

function openPark() {
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
    if (!dash) $('#park-meta').textContent = 'Offline. Waiting for a connection…';
  }
  renderAll();
}

/* ---------- Screens & navigation ---------- */
function showSetup() {
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  document.body.classList.add('no-tabbar');
  document.title = 'ParkAlert';
  $('#setup-parks').replaceChildren(parkGroups(null, (p) => startTrip(p.id)));
}

async function showApp({ firstRun = false } = {}) {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  document.body.classList.remove('no-tabbar');
  switchView('down');
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
      : "Can't reach ParkAlert right now. Check your connection.", true);
  }
};

$('#btn-alerts').onclick = () => (alertState().kind === 'setup' ? openAlertSetup() : openPause());
$('#row-setup').onclick = openAlertSetup;
$('#row-pause').onclick = openPause;
$('#row-park').onclick = openPark;
$('#row-leave').onclick = openLeave;
$('#row-test').onclick = async () => {
  const d = $('#test-detail');
  d.textContent = 'Sending…';
  try {
    await api(`/trips/${tripCode}/test`, { method: 'POST' });
    toast('Test alert sent. Check your notifications.');
  } catch {
    toast("Couldn't send the test. Try again in a moment.");
  }
  d.textContent = '';
};

$('#btn-share').onclick = async () => {
  const url = `${location.origin}/?join=${tripCode}`;
  const text = `Join my ParkAlert trip at ${parkLabel(dash.park.name)}. Code ${tripCode}`;
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

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('online', refresh);
addEventListener('offline', () => { offline = true; if (dash) renderHeader(); });

// Keep elapsed times honest between refreshes.
setInterval(() => {
  if (!dash || document.hidden) return;
  renderHeader();
  renderDown();
}, TICK_MS);

/* ---------- Boot ---------- */
(async function boot() {
  try {
    ({ parks } = await api('/parks'));
  } catch {
    $('#setup').classList.remove('hidden');
    setupStatus("Can't reach ParkAlert right now. Check your connection and reload.", true);
    return;
  }

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
    } catch {
      toast(`Invite code ${code} wasn't found`);
    }
  }

  if (tripCode) {
    try {
      await api(`/trips/${tripCode}`);
    } catch (err) {
      if (err.status === 404) {
        localStorage.removeItem('parkalert.trip');
        tripCode = null;
        showSetup();
        return;
      }
      // Offline at launch: keep the trip and show what we can.
    }
    showApp();
    return;
  }
  showSetup();
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
