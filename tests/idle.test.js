// A trip with a phone signed up keeps alerting for two months after anyone
// last opened it, and its phones hear the day before it stops.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hits = [];
const pushService = http.createServer((req, res) => { req.resume(); req.on('end', () => { hits.push(req.url); res.statusCode = 201; res.end(); }); });
const ntfy = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const DAY = 24 * 3600_000;
let store, warnIdleTrips, origin;

before(async () => {
  await new Promise((r) => pushService.listen(0, r));
  await new Promise((r) => ntfy.listen(0, r));
  origin = `http://127.0.0.1:${pushService.address().port}`;
  process.env.PUSH_TEST_ORIGIN = origin;
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-idle-'));
  store = await import('../server/store.js');
  ({ warnIdleTrips } = await import('../server/poller.js'));
});
after(() => { pushService.close(); ntfy.close(); });

const keys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};

// 1 PM in Orlando on a day in March.
const NOON_ISH = Date.parse('2026-03-10T17:00:00Z');

test('a trip with phones on it stays active for two months, one without for three weeks', () => {
  const now = NOON_ISH;
  const seen = now - 30 * DAY;
  assert.equal(store.isTripActive({ lastSeenAt: seen }, now), false);
  assert.equal(store.isTripActive({ lastSeenAt: seen, devices: [{ id: 'x' }] }, now), true);
  assert.equal(store.isTripActive({ lastSeenAt: seen, ntfyConfirmedAt: seen }, now), true);
  assert.equal(store.isTripActive({ lastSeenAt: now - 61 * DAY, devices: [{ id: 'x' }] }, now), false);
});

test('the day before a trip idles, its phones get one warning, in the daytime', async () => {
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  const trip = {
    code: 'IDLE60', topic: 'i', parkId: PARK, watched: null, rideMutes: {},
    devices: [{ id: 'p1', endpoint: `${origin}/p1`, keys: keys(), mute: null }],
    createdAt: NOON_ISH - 90 * DAY, lastSeenAt: NOON_ISH - 59.5 * DAY,
  };
  store.trips.IDLE60 = trip;
  hits.length = 0;
  // Two days out: nothing yet.
  await warnIdleTrips(NOON_ISH - 2 * DAY);
  assert.deepEqual(hits, []);
  // In the last day, but 3 AM in Orlando: wait for the morning.
  await warnIdleTrips(Date.parse('2026-03-10T07:00:00Z'));
  assert.deepEqual(hits, []);
  await warnIdleTrips(NOON_ISH);
  assert.deepEqual(hits, ['/p1']);
  assert.equal(trip.idleWarnedFor, store.tripIdleAt(trip, NOON_ISH));
  // Once.
  await warnIdleTrips(NOON_ISH + 3600_000);
  assert.deepEqual(hits, ['/p1']);
  // Opened again: the day moves, and so does the warning.
  trip.lastSeenAt = NOON_ISH + 2 * 3600_000;
  await warnIdleTrips(NOON_ISH + 3 * 3600_000);
  assert.deepEqual(hits, ['/p1']);
});

test('no warning for a paused trip, or one with no phones signed up', async () => {
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.NOPHON = { code: 'NOPHON', topic: 'n', parkId: PARK, createdAt: NOON_ISH - 30 * DAY, lastSeenAt: NOON_ISH - 20.5 * DAY };
  store.trips.PAUSED = {
    code: 'PAUSED', topic: 'p', parkId: PARK, mute: { until: null },
    devices: [{ id: 'p2', endpoint: `${origin}/p2`, keys: keys(), mute: null }],
    createdAt: NOON_ISH - 90 * DAY, lastSeenAt: NOON_ISH - 59.5 * DAY,
  };
  hits.length = 0;
  await warnIdleTrips(NOON_ISH);
  assert.deepEqual(hits, []);
});
