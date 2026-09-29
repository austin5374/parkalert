import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARKS, getPark } from './parks.js';
import { trips, parkState, createTrip, getTrip, saveTrips, touchTrip, flushState, activeParkIds, history } from './store.js';
import { rideHistory, rideToday, parkSummary, waitTrend } from './insights.js';
import { parkCrowd, crowdToday, rideBestTimes } from './crowdstate.js';
import { scorecard } from './scorecard.js';
import { parkDayStart, localDate } from './time.js';
import { currentWaitAlerts, pruneWaitAlerts, WAIT_ALERT_MIN, WAIT_ALERT_MAX } from './waitalerts.js';
import { startPolling, stopPolling, pollPark, freshPark, simulateTransition, downOutlook, currentSchedule, appLink } from './poller.js';
import { PORT, NTFY_BASE, HEALTH_TOKEN } from './config.js';
import { parkStatus, rideCounts } from './parkstatus.js';
import { startHistorySync } from './history.js';
import { startWeatherSync } from './weather.js';
import { deliver, MAX_DEVICES, deviceMuted } from './deliver.js';
import { vapidKeys, isPushEndpoint } from './webpush.js';
import { HttpError, requireObject, requireRideId, parseTripPatch, parseWaitAlert, parseSubscription, parseDeviceMute } from './validate.js';
import { LIMITS, createLimiter, clientKey, createKnownCodes } from './ratelimit.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// What the app's own files add up to: stamped into index.html as it is
// served and sent with every dashboard, so a page left open across a
// deploy can tell it is running old code and reload.
export const APP_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['index.html', 'app.js', 'time.js', 'style.css', 'sw.js']) {
    try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch {}
  }
  return h.digest('hex').slice(0, 12);
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Everything the page loads comes from here. Inline styles are allowed
// because the templates set a few style attributes; scripts never are, so
// even a slip in escaping could not run one.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const limit = Object.fromEntries(Object.entries(LIMITS).map(([name, cfg]) => [name, createLimiter(cfg)]));
const knownCodes = createKnownCodes();

function tooMany(res, waitMs) {
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(waitMs / 1000)) });
  res.end(JSON.stringify({ error: 'too many requests, try again shortly' }));
}

const MAX_BODY = 100_000;
// A park has a few dozen rides; this keeps one trip from bloating trips.json.
const MAX_WAIT_ALERTS = 100;
const HEALTH_STALE_MS = 5 * 60_000;

// Bytes are joined before decoding, so a character split across chunks
// survives. Past the limit nothing more is kept, and the connection closes
// after the 413 rather than reading on.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (size > MAX_BODY) return;
      size += c.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const data = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// A park's time zone: from its schedule once fetched, else from the park list.
const zoneOf = (parkId) => parkState[parkId]?.timezone || getPark(parkId)?.timezone || 'America/New_York';

const parkToday = (parkId, now = Date.now()) => localDate(now, zoneOf(parkId));

function tripView(trip) {
  const { code, topic, parkId, watched, mute, rideMutes } = trip;
  return { code, topic, parkId, watched, mute, rideMutes, waitAlerts: currentWaitAlerts(trip, parkToday(parkId)), phones: trip.devices?.length || 0, crowdAlerts: !!trip.crowdAlerts };
}


async function dashboard(trip) {
  touchTrip(trip);
  const state = await freshPark(trip.parkId);
  const park = getPark(trip.parkId);
  const schedule = currentSchedule(state);
  return {
    trip: tripView(trip),
    park: {
      id: trip.parkId,
      name: park?.name || 'Unknown park',
      timezone: zoneOf(trip.parkId),
      openingTime: schedule?.openingTime || null,
      closingTime: schedule?.closingTime || null,
      lateEvent: schedule?.lateEvent || null,
      lastCloseTime: schedule?.lastCloseTime || null, // when alerts stop for the day
      // Open or not, by its hours and its rides together (see parkstatus.js),
      // so the app says what the server mutes by.
      status: parkStatus(state),
      counts: rideCounts(state.rides),
    },
    ntfyBase: NTFY_BASE,
    version: APP_VERSION,
    recent: (state.recent || []).filter((e) => e.at > Date.now() - 2 * 3600_000),
    lastPoll: state.lastPoll || null,
    lastError: state.lastError || null,
    now: Date.now(),
    crowd: parkCrowd(trip.parkId),
    rides: Object.entries(state.rides || {}).map(([id, r]) => ({
      id,
      ...r,
      trend: r.status === 'OPERATING' ? waitTrend(state.waits?.[id]) : null,
      ...(r.status === 'DOWN' && r.downSince
        ? { outlook: downOutlook(trip.parkId, id, (Date.now() - r.downSince) / 60_000) }
        : {}),
    })),
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const who = clientKey(req);
  let wait = limit.api.take(who);
  if (wait) return tooMany(res, wait);

  if (req.method === 'GET' && url.pathname === '/api/parks') {
    return json(res, 200, { parks: PARKS });
  }

  // For an uptime monitor: is every park someone is watching being polled?
  // 503 once any has gone 5 minutes without a good poll, which is what
  // "alerts silently stopped" looks like from outside. (Railway's deploy
  // check uses /api/parks, so an API outage never blocks a deploy.) Which
  // parks have trips on them, and upstream errors, only with HEALTH_TOKEN:
  // otherwise it would show anyone when a family is at a park.
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const now = Date.now();
    const parks = activeParkIds(now).map((id) => {
      const s = parkState[id] || {};
      return {
        id,
        name: getPark(id)?.name || id,
        lastPoll: s.lastPoll || null,
        ageSeconds: s.lastPoll ? Math.round((now - s.lastPoll) / 1000) : null,
        lastError: s.lastError || null,
      };
    });
    const ok = parks.every((p) => p.lastPoll && now - p.lastPoll < HEALTH_STALE_MS);
    const detail = HEALTH_TOKEN && url.searchParams.get('token') === HEALTH_TOKEN;
    return json(res, ok ? 200 : 503, detail
      ? { ok, uptimeSeconds: Math.round(process.uptime()), parks }
      : { ok, uptimeSeconds: Math.round(process.uptime()) });
  }

  // The key browsers need to subscribe to this server's pushes.
  if (req.method === 'GET' && url.pathname === '/api/push-key') {
    return json(res, 200, { publicKey: vapidKeys().publicKey });
  }

  if (req.method === 'POST' && url.pathname === '/api/trips') {
    if ((wait = limit.create.take(who))) return tooMany(res, wait);
    const body = requireObject(await readBody(req));
    if (typeof body.parkId !== 'string' || !getPark(body.parkId)) return json(res, 400, { error: 'unknown parkId' });
    const trip = createTrip(body.parkId);
    knownCodes.add(who, trip.code);
    pollPark(trip.parkId); // warm up state so the first dashboard load is instant
    return json(res, 201, { trip: tripView(trip) });
  }

  // Guessing codes costs a token per miss; once they run out, even a right
  // guess waits, so enumeration gains nothing by pressing on. A code this
  // client has already opened is exempt, so a phone on a trip is never
  // locked out by misses from someone sharing its address.
  const code = parts[1] === 'trips' && parts[2] ? String(parts[2]).toUpperCase() : null;
  if (code && !knownCodes.has(who, code) && (wait = limit.miss.wait(who))) return tooMany(res, wait);
  const trip = code ? getTrip(code) : null;
  if (code && !trip) {
    limit.miss.take(who);
    return json(res, 404, { error: 'trip not found' });
  }
  if (trip) knownCodes.add(who, trip.code);

  // Test and simulated alerts are metered per client and per trip, so
  // neither one caller nor many can flood a trip's phones.
  if (trip && req.method === 'POST' && (parts[3] === 'test' || parts[3] === 'simulate' || (parts[3] === 'devices' && parts[5] === 'test'))) {
    if ((wait = limit.push.take(who) || limit.push.take(`trip:${trip.code}`))) return tooMany(res, wait);
  }

  // Phones ask every 30 seconds and most answers match the last one, so
  // the dashboard carries an ETag (over everything but the clock) and an
  // unchanged one is a 304 with no body: less cellular data in the park.
  // The browser's cache does the revalidating; the app just calls fetch.
  if (trip && req.method === 'GET' && parts[3] === 'dashboard') {
    const body = await dashboard(trip);
    const etag = `"d-${crypto.createHash('sha1').update(JSON.stringify({ ...body, now: 0 })).digest('base64url').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(body));
  }

  // Everything the ride detail sheet shows: live status, today's changes and
  // wait times, and this ride's record in the outage archive.
  if (trip && req.method === 'GET' && parts[3] === 'rides' && parts[4]) {
    const state = parkState[trip.parkId] || {};
    // Own properties only, so "__proto__" or "constructor" is just not found.
    const ride = state.rides && Object.hasOwn(state.rides, parts[4]) ? state.rides[parts[4]] : null;
    if (!ride) return json(res, 404, { error: 'ride not found' });
    const now = Date.now();
    const dayStart = parkDayStart(zoneOf(trip.parkId), now);
    return json(res, 200, {
      ride: { id: parts[4], ...ride },
      outlook: ride.status === 'DOWN' && ride.downSince
        ? downOutlook(trip.parkId, parts[4], (now - ride.downSince) / 60_000)
        : null,
      today: rideToday(state.recent, parts[4], dayStart),
      waits: (state.waits?.[parts[4]] || []).filter(([t]) => t >= dayStart),
      history: rideHistory(history.episodes[trip.parkId] || [], parts[4], history.fetched[trip.parkId] || []),
      bestTimes: rideBestTimes(trip.parkId, parts[4]),
      now,
    });
  }

  if (trip && req.method === 'GET' && parts[3] === 'park') {
    const state = parkState[trip.parkId] || {};
    const names = Object.fromEntries(Object.entries(state.rides || {}).map(([id, r]) => [id, r.name]));
    const dayStart = parkDayStart(zoneOf(trip.parkId));
    const today = (state.recent || []).filter((e) => e.at >= dayStart);
    return json(res, 200, {
      today: {
        downs: today.filter((e) => e.type === 'DOWN').length,
        rides: new Set(today.filter((e) => e.type === 'DOWN').map((e) => e.id)).size,
      },
      week: parkSummary(history.episodes[trip.parkId] || [], history.fetched[trip.parkId] || [], names),
      estimates: scorecard(state.scores),
      crowd: crowdToday(trip.parkId),
    });
  }

  if (trip && req.method === 'GET' && parts.length === 3) {
    return json(res, 200, { trip: tripView(trip) });
  }

  if (trip && req.method === 'PATCH' && parts.length === 3) {
    const patch = parseTripPatch(await readBody(req), (id) => !!getPark(id));
    if (patch.parkId !== undefined && patch.parkId !== trip.parkId) {
      // Ride ids are park-specific, so each park keeps its own follow list and
      // hopping back to a park restores it instead of starting over.
      trip.watchedByPark = { ...trip.watchedByPark, [trip.parkId]: trip.watched };
      trip.parkId = patch.parkId;
      trip.watched = trip.watchedByPark[patch.parkId] ?? null;
      trip.rideMutes = {};
      pollPark(trip.parkId);
    }
    if (patch.watched !== undefined) trip.watched = patch.watched;
    if (patch.mute !== undefined) trip.mute = patch.mute;
    if (patch.rideMutes !== undefined) trip.rideMutes = patch.rideMutes;
    if (patch.crowdAlerts !== undefined) trip.crowdAlerts = patch.crowdAlerts;
    // A phone on ntfy said a test arrived: the topic reaches someone.
    if (patch.ntfyWorking !== undefined) trip.ntfyConfirmedAt = patch.ntfyWorking ? Date.now() : null;
    saveTrips();
    return json(res, 200, { trip: tripView(trip) });
  }

  // A wait-time alert for one ride: PUT { max } sets it (replacing any, and
  // re-arming one already sent), DELETE removes it.
  if (trip && parts[3] === 'wait-alerts' && parts.length === 5 && (req.method === 'PUT' || req.method === 'DELETE')) {
    let rideId;
    try {
      rideId = requireRideId(decodeURIComponent(parts[4]));
    } catch {
      return json(res, 400, { error: 'bad ride id' });
    }
    const today = parkToday(trip.parkId);
    pruneWaitAlerts(trip, today);
    const alerts = { ...trip.waitAlerts };
    if (req.method === 'PUT') {
      const { max } = parseWaitAlert(await readBody(req), WAIT_ALERT_MIN, WAIT_ALERT_MAX);
      alerts[rideId] = { max, day: today, setAt: Date.now() };
      if (Object.keys(alerts).length > MAX_WAIT_ALERTS) return json(res, 400, { error: 'too many wait alerts' });
    } else delete alerts[rideId];
    trip.waitAlerts = alerts;
    saveTrips();
    return json(res, 200, { trip: tripView(trip) });
  }

  // Fire a fake DOWN or back-up transition through the real notification
  // pipeline, for testing pushes without waiting for a real ride outage.
  // curl -X POST .../api/trips/CODE/simulate -d '{"type":"up"}'   (or "down")
  if (trip && req.method === 'POST' && parts[3] === 'simulate') {
    const body = requireObject(await readBody(req));
    const result = await simulateTransition(trip, body.type === 'down' ? 'down' : 'up');
    return json(res, result.error ? 409 : 200, result);
  }

  // This phone's own notifications: register it (again, idempotently, by
  // endpoint), pause it alone, send it a test, or take it off the trip.
  if (trip && parts[3] === 'devices') {
    trip.devices ??= [];
    if (req.method === 'POST' && parts.length === 4) {
      const sub = parseSubscription(await readBody(req), isPushEndpoint);
      let device = trip.devices.find((d) => d.endpoint === sub.endpoint);
      if (device) {
        device.keys = sub.keys;
        device.seenAt = Date.now();
      } else {
        device = { id: crypto.randomBytes(9).toString('base64url'), ...sub, mute: null, createdAt: Date.now(), seenAt: Date.now() };
        trip.devices.push(device);
        // A phone that reinstalled the app many times leaves old ones behind.
        if (trip.devices.length > MAX_DEVICES) trip.devices.splice(0, trip.devices.length - MAX_DEVICES);
      }
      saveTrips();
      return json(res, 201, { device: { id: device.id, mute: device.mute } });
    }
    const device = trip.devices.find((d) => d.id === parts[4]);
    if (!device) return json(res, 404, { error: 'device not found' });
    if (req.method === 'GET' && parts.length === 5) {
      return json(res, 200, { device: { id: device.id, mute: deviceMuted(device) ? device.mute : null } });
    }
    if (req.method === 'PATCH' && parts.length === 5) {
      device.mute = parseDeviceMute(await readBody(req));
      saveTrips();
      return json(res, 200, { device: { id: device.id, mute: device.mute } });
    }
    if (req.method === 'DELETE' && parts.length === 5) {
      trip.devices = trip.devices.filter((d) => d !== device);
      saveTrips();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[5] === 'test') {
      const { ok } = await deliver(trip, {
        title: 'ParkAlert is on',
        message: 'This phone will get an alert when a ride you follow goes down or comes back up.',
        click: appLink(trip),
      }, { device: device.id, tag: 'test' });
      return json(res, ok ? 200 : 502, { ok });
    }
    return json(res, 404, { error: 'not found' });
  }

  if (trip && req.method === 'POST' && parts[3] === 'test') {
    // { to: 'ntfy' } from the ntfy setup: the trip's topic only, since the
    // phone being set up is the one checking. Otherwise every phone on the
    // trip, asked for behind a confirm, so it says what it is rather than
    // "this phone".
    const body = await readBody(req);
    const ntfyOnly = body?.to === 'ntfy';
    const { ok } = await deliver(trip, {
      title: `ParkAlert test for trip ${trip.code}`,
      message: ntfyOnly
        ? 'Sent from the ntfy setup. If you can read this, ntfy alerts reach this phone.'
        : 'Someone on your trip sent a test. If you can read this, alerts reach this phone.',
      click: appLink(trip),
    }, { tag: 'test', ntfyOnly });
    return json(res, ok ? 200 : 502, { ok });
  }

  json(res, 404, { error: 'not found' });
}

// The app's files never change while a version is deployed, so each is read,
// version-stamped (the page and the service worker carry APP_VERSION) and
// gzipped once, then served from memory. Text is sent compressed: app.js is
// 110 KB raw, a real wait on one bar of park signal. Every file revalidates
// by ETag, which is the version, so a deploy is picked up on the next load
// and an unchanged file costs a 304.
const STAMPED = new Set(['index.html', 'sw.js']);
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
const fileCache = new Map(); // relative path -> { type, raw, gz, etag }

function loadStatic(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const ext = path.extname(rel);
  let raw = fs.readFileSync(path.join(PUBLIC_DIR, rel));
  if (STAMPED.has(rel)) raw = Buffer.from(raw.toString('utf8').replaceAll('__APP_VERSION__', APP_VERSION));
  const entry = {
    type: MIME[ext] || 'application/octet-stream',
    raw,
    gz: COMPRESSIBLE.has(ext) ? zlib.gzipSync(raw, { level: 9 }) : null,
    etag: `"${APP_VERSION}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)}"`,
  };
  fileCache.set(rel, entry);
  return entry;
}

function serveStatic(req, res, url) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  // Any path that isn't a file is a screen of the app (/, /ride/<id>, a
  // tapped push's link), and gets the page, which routes itself.
  if (url.pathname === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const file = loadStatic(path.relative(PUBLIC_DIR, filePath));
  const headers = { 'Content-Type': file.type, 'Cache-Control': 'no-cache', ETag: file.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const gzip = file.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) headers['Content-Encoding'] = 'gzip';
  const body = gzip ? file.gz : file.raw;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  // Only meaningful over HTTPS, which on Railway arrives via its proxy.
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    // A request the client got wrong says why; anything else is ours, and
    // its details stay in the log.
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('Connection', 'close');
      if (!res.headersSent) json(res, err.status, { error: err.message });
      return;
    }
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  }
});

// `node server/index.js` serves and polls; tests import `server` instead.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  server.listen(PORT, () => {
    console.log(`[server] ParkAlert listening on http://localhost:${PORT}`);
    console.log(`[server] ${Object.keys(trips).length} trip(s) loaded`);
    startPolling();
    startHistorySync();
    startWeatherSync();
  });
  // Railway stops the old container with SIGTERM on every deploy. Let the
  // poll and pushes under way finish (up to 5 s) so no alert is cut off,
  // then write everything down.
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      await stopPolling(5000);
      flushState();
      process.exit(0);
    });
  }
}
