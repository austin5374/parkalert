// A wait alert is used up only when a phone could see it: with every phone
// paused it waits, and goes out once one is back.
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
let store, notifyWaitAlerts, localDate, origin;

before(async () => {
  await new Promise((r) => pushService.listen(0, r));
  await new Promise((r) => ntfy.listen(0, r));
  origin = `http://127.0.0.1:${pushService.address().port}`;
  process.env.PUSH_TEST_ORIGIN = origin;
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-wait-'));
  store = await import('../server/store.js');
  ({ notifyWaitAlerts } = await import('../server/poller.js'));
  ({ localDate } = await import('../server/time.js'));
});
after(() => { pushService.close(); ntfy.close(); });

const keys = () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
};

test("with the trip's only phone paused, a wait alert waits instead of being used up", async () => {
  const now = Date.now();
  const today = localDate(now, 'America/New_York');
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  const phone = { id: 'p1', endpoint: `${origin}/p1`, keys: keys(), mute: { until: now + 3600_000 } };
  const trip = { code: 'WWWWWW', topic: 'w', parkId: PARK, watched: null, rideMutes: {}, devices: [phone], createdAt: now, waitAlerts: { a: { max: 30, day: today, setAt: now } } };
  store.trips.WWWWWW = trip;
  const rides = { a: { name: 'Ride A', status: 'OPERATING', waitTime: 25 } };
  store.parkState[PARK] = { timezone: 'America/New_York', schedule: null, rides };
  hits.length = 0;
  assert.equal(await notifyWaitAlerts(PARK, rides, now), 0);
  assert.equal(trip.waitAlerts.a.sentAt, undefined, 'still armed');
  phone.mute = null; // the phone is back
  assert.equal(await notifyWaitAlerts(PARK, rides, now + 60_000), 1);
  assert.deepEqual(hits, ['/p1']);
  assert.ok(trip.waitAlerts.a.sentAt);
});
