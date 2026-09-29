// The app's own notifications, end to end: devices registered on a trip get
// each alert through a fake push service, a paused phone doesn't, and a
// subscription the service says is gone is dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hits = []; // { path, headers, body }
const goneIds = new Set();
const pushService = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.statusCode = goneIds.has(req.url) ? 410 : 201;
    res.end();
  });
});
const ntfy = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });

let deliver, trips, origin;
before(async () => {
  await new Promise((r) => pushService.listen(0, r));
  await new Promise((r) => ntfy.listen(0, r));
  origin = `http://127.0.0.1:${pushService.address().port}`;
  process.env.PUSH_TEST_ORIGIN = origin;
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-deliver-'));
  ({ deliver } = await import('../server/deliver.js'));
  ({ trips } = await import('../server/store.js'));
});
after(() => { pushService.close(); ntfy.close(); });

function phoneKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
const device = (id, extra = {}) => ({ id, endpoint: `${origin}/${id}`, keys: phoneKeys(), mute: null, ...extra });

test('every phone on the trip gets the alert, encrypted and signed', async () => {
  hits.length = 0;
  const trip = { code: 'AAAAAA', topic: 't', devices: [device('a'), device('b')] };
  trips.AAAAAA = trip;
  const result = await deliver(trip, { title: 'Space Mountain is down', message: 'Usually back in 10 to 40 min', priority: 3 }, { tag: 'ride:x' });
  assert.deepEqual(result, { ok: true, ntfy: true, devices: 2 });
  assert.deepEqual(hits.map((h) => h.path).sort(), ['/a', '/b']);
  for (const h of hits) {
    assert.equal(h.headers['content-encoding'], 'aes128gcm');
    assert.match(h.headers.authorization, /^vapid t=.+, k=.+/);
    assert.equal(h.headers.ttl, '3600');
    assert.ok(h.body.length > 86, 'header plus ciphertext');
  }
});

test('a phone paused on its own is skipped; the rest still get it', async () => {
  hits.length = 0;
  const trip = { code: 'BBBBBB', topic: 't', devices: [device('c', { mute: { until: Date.now() + 60_000 } }), device('d')] };
  await deliver(trip, { title: 'x', message: 'y' });
  assert.deepEqual(hits.map((h) => h.path), ['/d']);
});

test('a test goes to the one phone that asked for it', async () => {
  hits.length = 0;
  const trip = { code: 'CCCCCC', topic: 't', devices: [device('e'), device('f')] };
  await deliver(trip, { title: 'test', message: 'test' }, { device: 'f' });
  assert.deepEqual(hits.map((h) => h.path), ['/f']);
});

test('a subscription the push service says is gone is removed from the trip', async () => {
  goneIds.add('/g');
  const trip = { code: 'DDDDDD', topic: 't', devices: [device('g'), device('h')] };
  await deliver(trip, { title: 'x', message: 'y' });
  assert.deepEqual(trip.devices.map((d) => d.id), ['h']);
});

test('alerts go out urgent, and quiet updates and routine pushes do not', async () => {
  hits.length = 0;
  const trip = { code: 'EEEEEE', topic: 't', devices: [device('i')] };
  await deliver(trip, { title: 'back up', message: 'm', priority: 4 });
  await deliver(trip, { title: 'down', message: 'm', priority: 3, urgency: 'high' });
  await deliver(trip, { title: 'lines building', message: 'm', priority: 3 });
  await deliver(trip, { title: '6 of 18 back', message: 'm', priority: 4, quiet: true });
  assert.deepEqual(hits.map((h) => h.headers.urgency), ['high', 'high', 'normal', 'normal']);
});

test('a push to a trip whose only phone is paused reaches nobody who will see it', async () => {
  const { reachedSomeone, hasReceiver } = await import('../server/deliver.js');
  const paused = { mute: { until: Date.now() + 60_000 } };
  const trip = { code: 'FFFFFF', topic: 't', devices: [device('p', paused)] };
  const result = await deliver(trip, { title: 'wait', message: 'm' });
  assert.deepEqual([result.ntfy, result.devices], [true, 0]);
  assert.equal(reachedSomeone(trip, result), false, 'ntfy accepted it, but no phone here uses ntfy');
  assert.equal(hasReceiver(trip), false);
  trip.ntfyConfirmedAt = Date.now(); // a phone on ntfy said a test arrived
  assert.equal(reachedSomeone(trip, result), true);
  assert.equal(hasReceiver({ topic: 't' }), true, 'a trip on ntfy alone is reached through it');
});
