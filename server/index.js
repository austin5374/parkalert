import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARKS, getPark } from './parks.js';
import { trips, parkState, createTrip, getTrip, saveTrips, touchTrip, history } from './store.js';
import { rideHistory, rideToday, parkSummary, parkDayStart } from './insights.js';
import { startPolling, pollPark, simulateTransition, downOutlook, currentSchedule, APP_URL } from './poller.js';
import { startHistorySync } from './history.js';
import { publish } from './notify.js';
import { HttpError, requireObject, parseTripPatch } from './validate.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tripView(trip) {
  const { code, topic, parkId, watched, mute, rideMutes } = trip;
  return { code, topic, parkId, watched, mute, rideMutes };
}

const NTFY_BASE = process.env.NTFY_BASE || 'https://ntfy.sh';

async function dashboard(trip) {
  touchTrip(trip);
  if (!parkState[trip.parkId]?.lastPoll) await pollPark(trip.parkId);
  const state = parkState[trip.parkId] || {};
  const park = getPark(trip.parkId);
  const schedule = currentSchedule(state);
  return {
    trip: tripView(trip),
    park: {
      id: trip.parkId,
      name: park?.name || 'Unknown park',
      timezone: state.timezone || null,
      openingTime: schedule?.openingTime || null,
      closingTime: schedule?.closingTime || null,
      lateEvent: schedule?.lateEvent || null,
    },
    ntfyBase: NTFY_BASE,
    recent: (state.recent || []).filter((e) => e.at > Date.now() - 2 * 3600_000),
    lastPoll: state.lastPoll || null,
    lastError: state.lastError || null,
    now: Date.now(),
    rides: Object.entries(state.rides || {}).map(([id, r]) => ({
      id,
      ...r,
      ...(r.status === 'DOWN' && r.downSince
        ? { outlook: downOutlook(trip.parkId, id, (Date.now() - r.downSince) / 60_000) }
        : {}),
    })),
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/parks') {
    return json(res, 200, { parks: PARKS });
  }

  if (req.method === 'POST' && url.pathname === '/api/trips') {
    const body = requireObject(await readBody(req));
    if (typeof body.parkId !== 'string' || !getPark(body.parkId)) return json(res, 400, { error: 'unknown parkId' });
    const trip = createTrip(body.parkId);
    pollPark(trip.parkId); // warm up state so the first dashboard load is instant
    return json(res, 201, { trip: tripView(trip) });
  }

  const trip = parts[1] === 'trips' && parts[2] ? getTrip(parts[2]) : null;
  if (parts[1] === 'trips' && parts[2] && !trip) {
    return json(res, 404, { error: 'trip not found' });
  }

  if (trip && req.method === 'GET' && parts[3] === 'dashboard') {
    return json(res, 200, await dashboard(trip));
  }

  // Everything the ride detail sheet shows: live status, today's changes and
  // wait times, and this ride's record in the outage archive.
  if (trip && req.method === 'GET' && parts[3] === 'rides' && parts[4]) {
    const state = parkState[trip.parkId] || {};
    // Own properties only, so "__proto__" or "constructor" is just not found.
    const ride = state.rides && Object.hasOwn(state.rides, parts[4]) ? state.rides[parts[4]] : null;
    if (!ride) return json(res, 404, { error: 'ride not found' });
    const now = Date.now();
    const dayStart = parkDayStart(state.timezone || 'America/New_York', now);
    return json(res, 200, {
      ride: { id: parts[4], ...ride },
      outlook: ride.status === 'DOWN' && ride.downSince
        ? downOutlook(trip.parkId, parts[4], (now - ride.downSince) / 60_000)
        : null,
      today: rideToday(state.recent, parts[4], dayStart),
      waits: (state.waits?.[parts[4]] || []).filter(([t]) => t >= dayStart),
      history: rideHistory(history.episodes[trip.parkId] || [], parts[4], history.fetched[trip.parkId] || []),
      now,
    });
  }

  if (trip && req.method === 'GET' && parts[3] === 'park') {
    const state = parkState[trip.parkId] || {};
    const names = Object.fromEntries(Object.entries(state.rides || {}).map(([id, r]) => [id, r.name]));
    const dayStart = parkDayStart(state.timezone || 'America/New_York');
    const today = (state.recent || []).filter((e) => e.at >= dayStart);
    return json(res, 200, {
      today: {
        downs: today.filter((e) => e.type === 'DOWN').length,
        rides: new Set(today.filter((e) => e.type === 'DOWN').map((e) => e.id)).size,
      },
      week: parkSummary(history.episodes[trip.parkId] || [], history.fetched[trip.parkId] || [], names),
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
    saveTrips();
    return json(res, 200, { trip: tripView(trip) });
  }

  // Fire a fake DOWN or back-up transition through the real notification
  // pipeline — for testing pushes without waiting for a real ride outage.
  // curl -X POST .../api/trips/CODE/simulate -d '{"type":"up"}'   (or "down")
  if (trip && req.method === 'POST' && parts[3] === 'simulate') {
    const body = requireObject(await readBody(req));
    const result = await simulateTransition(trip, body.type === 'down' ? 'down' : 'up');
    return json(res, result.error ? 409 : 200, result);
  }

  if (trip && req.method === 'POST' && parts[3] === 'test') {
    const ok = await publish(trip.topic, {
      title: 'ParkAlert test',
      message: 'Alerts are working on this phone. Tap to open ParkAlert.',
      tags: 'white_check_mark',
      click: APP_URL,
    });
    return json(res, ok ? 200 : 502, { ok });
  }

  json(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  if (url.pathname === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath);
  // Every file revalidates. With a max-age on scripts, a phone could pair a
  // freshly deployed index.html with the previous app.js for five minutes and
  // break; an unchanged file costs a 304 and no body.
  const stat = fs.statSync(filePath);
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  });
  fs.createReadStream(filePath).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
  });
}
