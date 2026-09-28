// End to end through the real notification path, against a fake ntfy server.
// Node runs each test file in its own process, so the environment set here
// is in place before the server modules read it.
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
  req.on('end', () => {
    received.push(JSON.parse(body));
    res.end('{}');
  });
});

let trips, parkState, notifyTrips;
const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';

before(async () => {
  await new Promise((r) => ntfy.listen(0, r));
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.PUBLIC_URL = 'https://parkalert.example';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-test-'));
  ({ trips, parkState } = await import('../server/store.js'));
  ({ notifyTrips } = await import('../server/poller.js'));
});
after(() => ntfy.close());

function setup({ down = 0, trip = {} } = {}) {
  received.length = 0;
  for (const k of Object.keys(trips)) delete trips[k];
  trips.AAAAAA = { code: 'AAAAAA', topic: 't-a', parkId: PARK, watched: null, mute: null, rideMutes: {}, ...trip };
  const now = Date.now();
  const rides = {};
  for (let i = 0; i < down; i++) {
    rides[`r${i}`] = { name: `Ride ${i}`, status: 'DOWN', downSince: now, downFrom: 'OPERATING' };
  }
  parkState[PARK] = { rides, timezone: 'America/New_York', schedule: null };
  return Object.entries(rides).map(([id, r]) => ({ type: 'DOWN', ride: { id, ...r } }));
}

test('a storm hold is one push naming the rides, and tapping it opens the app', async () => {
  const events = setup({ down: 6 });
  const { sent } = await notifyTrips(PARK, events, { simulated: true });
  assert.equal(sent, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, '6 rides just went down');
  assert.match(received[0].message, /Ride 0, Ride 1, Ride 2, Ride 3, Ride 4 and 1 more/);
  assert.match(received[0].message, /Park-wide hold at Magic Kingdom/);
  assert.equal(received[0].click, 'https://parkalert.example');
});

test('two rides down at once are still two separate alerts', async () => {
  const events = setup({ down: 2 });
  await notifyTrips(PARK, events, { simulated: true });
  assert.deepEqual(received.map((m) => m.title).sort(), ['Ride 0 is down', 'Ride 1 is down']);
});

test('grouping counts only the rides this trip follows', async () => {
  const events = setup({ down: 4, trip: { watched: ['r0', 'r1'] } });
  const { sent, skipped } = await notifyTrips(PARK, events, { simulated: true });
  assert.equal(sent, 2);
  assert.equal(skipped, 2);
});

test('a paused trip gets nothing', async () => {
  const events = setup({ down: 3, trip: { mute: { until: Date.now() + 60_000 } } });
  const { sent } = await notifyTrips(PARK, events, { simulated: true });
  assert.equal(sent, 0);
  assert.equal(received.length, 0);
});

test('a delayed opening says the ride is now open, and how late', async () => {
  setup();
  const ev = { type: 'UP', ride: { id: 'x', name: 'Seven Dwarfs Mine Train', status: 'OPERATING' }, downtimeMs: 40 * 60_000, late: true };
  await notifyTrips(PARK, [ev], { simulated: true });
  assert.equal(received[0].title, 'Seven Dwarfs Mine Train is now open');
  assert.match(received[0].message, /^Opened 40 min late · Magic Kingdom/);
});
