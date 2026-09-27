/* ParkAlert client */
const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 30_000;

let tripCode = localStorage.getItem('parkalert.trip');
let dash = null; // last /dashboard payload
let parks = [];
let refreshTimer = null;

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

/* ---------- Setup / park detection ---------- */
function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
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

function locate() {
  const status = $('#setup-status');
  if (!navigator.geolocation || !window.isSecureContext) {
    status.textContent = 'Location needs HTTPS — pick your park below.';
    return;
  }
  status.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const park = nearestPark({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      if (park) {
        status.textContent = `Found you at ${park.name}!`;
        startTrip(park.id);
      } else {
        status.textContent = "You don't seem to be at a park — pick one below.";
      }
    },
    () => { status.textContent = 'Location unavailable — pick your park below.'; },
    { timeout: 10_000, maximumAge: 60_000 }
  );
}

async function startTrip(parkId) {
  const { trip } = await api('/trips', { method: 'POST', body: { parkId } });
  setTrip(trip.code);
}

function setTrip(code) {
  tripCode = code.toUpperCase();
  localStorage.setItem('parkalert.trip', tripCode);
  showApp();
}

function leaveTrip() {
  localStorage.removeItem('parkalert.trip');
  tripCode = null;
  dash = null;
  clearInterval(refreshTimer);
  showSetup(false);
}

/* ---------- Rendering helpers ---------- */
function ago(ts) {
  const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function statusLabel(s) {
  return { OPERATING: 'Open', DOWN: 'Down', CLOSED: 'Closed', REFURBISHMENT: 'Refurb' }[s] || s;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function renderParkButtons(container, onPick) {
  container.innerHTML = '';
  for (const p of parks) {
    const b = el(`<button>${p.name}</button>`);
    if (dash && p.id === dash.park.id) b.classList.add('current');
    b.onclick = () => onPick(p);
    container.appendChild(b);
  }
}

/* ---------- Dashboard rendering ---------- */
function isWatched(rideId) {
  return dash.trip.watched === null || dash.trip.watched.includes(rideId);
}

function fmtLocal(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderHeader() {
  $('#park-name').textContent = dash.park.name;
  const bits = [];
  const close = fmtLocal(dash.park.closingTime);
  if (close) bits.push(`Closes ${close}`);
  if (dash.lastPoll) bits.push(`Updated ${ago(dash.lastPoll)} ago`);
  if (dash.lastError) bits.push('⚠️ update failed');
  $('#park-meta').textContent = bits.join(' · ');

  const muted = dash.trip.mute && (dash.trip.mute.until === null || dash.trip.mute.until > Date.now());
  const btn = $('#btn-mute');
  btn.textContent = muted ? '🔕' : '🔔';
  btn.classList.toggle('muted', !!muted);
}

function renderDown() {
  const list = $('#down-list');
  const down = dash.rides
    .filter((r) => r.status === 'DOWN')
    .sort((a, b) => (a.downSince || 0) - (b.downSince || 0));
  list.innerHTML = '';
  if (!down.length) {
    list.appendChild(el(`<div class="empty"><span class="big">🎉</span>
      No rides are down right now.<br>You'll get a push the moment one goes down.</div>`));
    return;
  }
  for (const r of down) {
    list.appendChild(el(`
      <div class="ride-row is-down">
        <div class="ride-info">
          <div class="ride-name">${r.name}</div>
          <div class="ride-sub">Down since ${fmtLocal(new Date(r.downSince).toISOString())}${isWatched(r.id) ? '' : ' · not watching'}</div>
        </div>
        <div class="down-time">${ago(r.downSince)}</div>
      </div>`));
  }
}

function renderRides() {
  const list = $('#rides-list');
  const watchedCount = dash.trip.watched === null ? dash.rides.length : dash.trip.watched.length;
  $('#watch-summary').textContent =
    dash.trip.watched === null ? 'Watching all rides' : `Watching ${watchedCount} of ${dash.rides.length} rides`;
  $('#btn-watch-all').classList.toggle('hidden', dash.trip.watched === null);

  const rides = [...dash.rides].sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = '';
  for (const r of rides) {
    const watched = isWatched(r.id);
    const rideMuted = !!dash.trip.rideMutes[r.id];
    const row = el(`
      <div class="ride-row">
        <button class="icon-btn star ${watched ? '' : 'off'}" aria-label="Watch ${r.name}">⭐</button>
        <div class="ride-info">
          <div class="ride-name">${r.name}</div>
          <div class="ride-sub">${statusLabel(r.status)} for ${ago(r.since)}${r.waitTime != null ? ` · ${r.waitTime} min wait` : ''}</div>
        </div>
        <span class="status-chip status-${r.status}">${statusLabel(r.status)}</span>
        <button class="icon-btn bell ${rideMuted ? 'off' : ''}" aria-label="Mute ${r.name}">${rideMuted ? '🔕' : '🔔'}</button>
      </div>`);
    row.querySelector('.star').onclick = () => toggleWatch(r.id);
    row.querySelector('.bell').onclick = () => toggleRideMute(r.id);
    list.appendChild(row);
  }
}

function renderSettings() {
  $('#trip-code').textContent = tripCode;
  $('#ntfy-topic').textContent = dash.trip.topic;
  $('#link-ntfy-web').href = `https://ntfy.sh/${dash.trip.topic}`;
  const m = dash.trip.mute;
  const active = m && (m.until === null || m.until > Date.now());
  $('#btn-mute-toggle').textContent = active ? 'Unmute' : 'Mute';
  $('#mute-status').textContent = !active ? ''
    : m.until === null ? 'Muted until you unmute.'
    : `Muted until ${new Date(m.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  renderParkButtons($('#settings-park-list'), async (p) => {
    if (p.id === dash.park.id) return;
    await patchTrip({ parkId: p.id });
    refresh();
  });
}

function renderAll() {
  if (!dash) return;
  renderHeader();
  renderDown();
  renderRides();
  renderSettings();
}

/* ---------- Actions ---------- */
async function toggleWatch(rideId) {
  const all = dash.rides.map((r) => r.id);
  let watched = dash.trip.watched === null ? all : [...dash.trip.watched];
  watched = watched.includes(rideId) ? watched.filter((id) => id !== rideId) : [...watched, rideId];
  if (watched.length === all.length) watched = null;
  dash.trip.watched = watched;
  renderAll();
  await patchTrip({ watched });
}

async function toggleRideMute(rideId) {
  const rideMutes = { ...dash.trip.rideMutes };
  if (rideMutes[rideId]) delete rideMutes[rideId];
  else rideMutes[rideId] = true;
  dash.trip.rideMutes = rideMutes;
  renderAll();
  await patchTrip({ rideMutes });
}

async function setMute(mute) {
  dash.trip.mute = mute;
  renderAll();
  await patchTrip({ mute });
}

async function refresh() {
  if (!tripCode) return;
  try {
    dash = await api(`/trips/${tripCode}/dashboard`);
    renderAll();
  } catch (err) {
    if (err.status === 404) leaveTrip(); // trip deleted server-side
  }
}

/* ---------- Screens & navigation ---------- */
function showSetup(autoLocate = true) {
  $('#setup').classList.remove('hidden');
  $('#app').classList.add('hidden');
  renderParkButtons($('#park-list'), (p) => startTrip(p.id));
  if (autoLocate) locate();
}

function showApp() {
  $('#setup').classList.add('hidden');
  $('#app').classList.remove('hidden');
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === name));
}

/* ---------- Wire up ---------- */
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
$('#btn-locate').onclick = locate;

$('#join-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return;
  try {
    await api(`/trips/${code}`);
    setTrip(code);
  } catch {
    $('#setup-status').textContent = `Trip "${code}" not found.`;
  }
};

$('#btn-mute').onclick = () => {
  const active = dash?.trip.mute && (dash.trip.mute.until === null || dash.trip.mute.until > Date.now());
  setMute(active ? null : { until: null });
};
$('#btn-mute-toggle').onclick = () => $('#btn-mute').onclick();
$('#btn-mute-1h').onclick = () => setMute({ until: Date.now() + 3600_000 });

$('#btn-watch-all').onclick = async () => {
  dash.trip.watched = null;
  renderAll();
  await patchTrip({ watched: null });
};

$('#btn-share').onclick = async () => {
  const url = `${location.origin}/?join=${tripCode}`;
  const text = `Join my ParkAlert trip (${dash.park.name}) — code ${tripCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'ParkAlert', text, url }); } catch {}
  } else {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    $('#btn-share').textContent = 'Copied!';
    setTimeout(() => ($('#btn-share').textContent = 'Share trip link'), 1500);
  }
};

$('#btn-copy-topic').onclick = async () => {
  await navigator.clipboard.writeText(dash.trip.topic);
  $('#btn-copy-topic').textContent = 'Copied!';
  setTimeout(() => ($('#btn-copy-topic').textContent = 'Copy topic'), 1500);
};

$('#btn-test-notif').onclick = async () => {
  const btn = $('#btn-test-notif');
  btn.textContent = 'Sending…';
  try {
    await api(`/trips/${tripCode}/test`, { method: 'POST' });
    btn.textContent = 'Sent ✓';
  } catch {
    btn.textContent = 'Failed — try again';
  }
  setTimeout(() => (btn.textContent = 'Send test notification'), 2000);
};

$('#btn-leave').onclick = () => {
  if (confirm('Leave this trip? Your phone will stop showing it (the trip itself keeps running).')) {
    leaveTrip();
  }
};

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

/* ---------- Boot ---------- */
(async function boot() {
  ({ parks } = await api('/parks'));

  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam) {
    history.replaceState(null, '', '/');
    try {
      await api(`/trips/${joinParam.toUpperCase()}`);
      setTrip(joinParam);
      return;
    } catch {}
  }

  if (tripCode) {
    try {
      await api(`/trips/${tripCode}`);
      showApp();
      return;
    } catch {
      localStorage.removeItem('parkalert.trip');
      tripCode = null;
    }
  }
  showSetup();
})();

// Tick relative times even between refreshes.
setInterval(() => { if (dash && !document.hidden) renderHeader(), renderDown(); }, 30_000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
