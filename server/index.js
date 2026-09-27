import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARKS, getPark } from './parks.js';
import { trips, parkState, createTrip, getTrip, saveTrips } from './store.js';
import { startPolling, pollPark, simulateTransition } from './poller.js';
import { publish } from './notify.js';

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
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tripView(trip) {
  const { code, topic, parkId, watched, mute, rideMutes } = trip;
  return { code, topic, parkId, watched, mute, rideMutes };
}

async function dashboard(trip) {
  if (!parkState[trip.parkId]?.lastPoll) await pollPark(trip.parkId);
  const state = parkState[trip.parkId] || {};
  const park = getPark(trip.parkId);
  return {
    trip: tripView(trip),
    park: {
      id: trip.parkId,
      name: park?.name || 'Unknown park',
      timezone: state.timezone || null,
      openingTime: state.schedule?.openingTime || null,
      closingTime: state.schedule?.closingTime || null,
    },
    lastPoll: state.lastPoll || null,
    lastError: state.lastError || null,
    now: Date.now(),
    rides: Object.entries(state.rides || {}).map(([id, r]) => ({ id, ...r })),
  };
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && url.pathname === '/api/parks') {
    return json(res, 200, { parks: PARKS });
  }

  if (req.method === 'POST' && url.pathname === '/api/trips') {
    const body = await readBody(req);
    if (!getPark(body.parkId)) return json(res, 400, { error: 'unknown parkId' });
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

  if (trip && req.method === 'GET' && parts.length === 3) {
    return json(res, 200, { trip: tripView(trip) });
  }

  if (trip && req.method === 'PATCH' && parts.length === 3) {
    const body = await readBody(req);
    if (body.parkId !== undefined && body.parkId !== trip.parkId) {
      if (!getPark(body.parkId)) return json(res, 400, { error: 'unknown parkId' });
      trip.parkId = body.parkId;
      trip.watched = null; // ride ids are park-specific
      trip.rideMutes = {};
      pollPark(trip.parkId);
    }
    if (body.watched !== undefined) {
      trip.watched = Array.isArray(body.watched) ? body.watched : null;
    }
    if (body.mute !== undefined) {
      trip.mute = body.mute ? { until: body.mute.until ?? null } : null;
    }
    if (body.rideMutes !== undefined && typeof body.rideMutes === 'object') {
      trip.rideMutes = body.rideMutes || {};
    }
    saveTrips();
    return json(res, 200, { trip: tripView(trip) });
  }

  // Fire a fake DOWN or back-up transition through the real notification
  // pipeline — for testing pushes without waiting for a real ride outage.
  // curl -X POST .../api/trips/CODE/simulate -d '{"type":"up"}'   (or "down")
  if (trip && req.method === 'POST' && parts[3] === 'simulate') {
    const body = await readBody(req);
    const result = await simulateTransition(trip, body.type === 'down' ? 'down' : 'up');
    return json(res, result.error ? 409 : 200, result);
  }

  if (trip && req.method === 'POST' && parts[3] === 'test') {
    const ok = await publish(trip.topic, {
      title: 'ParkAlert test',
      message: 'Push notifications are working for this trip.',
      tags: 'white_check_mark',
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
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=300',
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[server] ParkAlert listening on http://localhost:${PORT}`);
  console.log(`[server] ${Object.keys(trips).length} trip(s) loaded`);
  startPolling();
});
