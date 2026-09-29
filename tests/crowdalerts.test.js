// "Lines are building", end to end: a real rise at a busy hour reaches the
// trips that asked for it, once, and nobody else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const received = [];
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { received.push(JSON.parse(body)); res.end('{}'); });
});

const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
let store, notifyCrowds, parseTripPatch;
before(async () => {
  await new Promise((r) => ntfy.listen(0, r));
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-crowd-'));
  store = await import('../server/store.js');
  ({ notifyCrowds } = await import('../server/poller.js'));
  ({ parseTripPatch } = await import('../server/validate.js'));
});
after(() => ntfy.close());

test('a jump in the big-ride waits at a busy time alerts only the trips that asked, once', async () => {
  const rides = ['a', 'b', 'c', 'd'];
  const usual = Object.fromEntries(rides.map((id) => [id, Array(24).fill(30)]));
  store.history.waits = { [PARK]: { '2026-09-20': usual, '2026-09-21': usual, '2026-09-22': usual } };
  const now = Date.now();
  store.parkState[PARK] = {
    timezone: 'America/New_York',
    schedule: null,
    rides: Object.fromEntries(rides.map((id) => [id, { name: `Ride ${id}`, status: 'OPERATING', waitTime: 60 }])),
    crowd: [[now - 40 * 60_000, 32], [now - 20 * 60_000, 45]],
  };
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.YESYES = { code: 'YESYES', topic: 'yes', parkId: PARK, crowdAlerts: true, createdAt: now };
  store.trips.NONONO = { code: 'NONONO', topic: 'no', parkId: PARK, createdAt: now };
  received.length = 0;
  assert.equal(await notifyCrowds(PARK, now), 1);
  assert.deepEqual(received.map((m) => m.topic), ['yes']);
  assert.match(received[0].title, /Lines are building at Magic Kingdom/);
  assert.match(received[0].message, /average 60 min, up from 32/);
  // Not again within two hours, however it goes.
  assert.equal(await notifyCrowds(PARK, now + 60_000), 0);
});

test('the setting must be true or false', () => {
  assert.deepEqual(parseTripPatch({ crowdAlerts: true }, () => true), { crowdAlerts: true });
  assert.throws(() => parseTripPatch({ crowdAlerts: 'yes' }, () => true), /crowdAlerts/);
});
