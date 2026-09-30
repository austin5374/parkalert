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
const slowTopics = new Set(); // deliveries to these take a second
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body);
    setTimeout(() => {
      received.push({ ...msg, at: Date.now() });
      res.end('{}');
    }, slowTopics.has(msg.topic) ? 1000 : 0);
  });
});

let trips, parkState, notifyTrips, syncIncidents;
const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';

before(async () => {
  await new Promise((r) => ntfy.listen(0, r));
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.PUBLIC_URL = 'https://parkalert.example';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-test-'));
  ({ trips, parkState } = await import('../server/store.js'));
  ({ notifyTrips, syncIncidents } = await import('../server/poller.js'));
});
after(() => ntfy.close());

// down: rides going down now; hold: as one park-wide hold (an incident).
function setup({ down = 0, trip = {}, hold = false } = {}) {
  received.length = 0;
  for (const k of Object.keys(trips)) delete trips[k];
  trips.AAAAAA = { code: 'AAAAAA', topic: 't-a', parkId: PARK, watched: null, mute: null, rideMutes: {}, ...trip };
  const now = Date.now();
  const rides = {};
  for (let i = 0; i < down; i++) {
    rides[`r${i}`] = { name: `Ride ${i}`, status: 'DOWN', downSince: now, downFrom: 'OPERATING', ...(hold ? { liveKind: 'hold', holdSize: down, incident: 'hold-1' } : { liveKind: 'breakdown' }) };
  }
  parkState[PARK] = { rides, timezone: 'America/New_York', schedule: null };
  syncIncidents(PARK, parkState[PARK], rides, now);
  return Object.entries(rides).map(([id, r]) => ({ type: 'DOWN', ride: { id, ...r } }));
}

test('a storm hold is one push naming the rides, and tapping it opens the hold', async () => {
  const events = setup({ down: 6, hold: true });
  const { sent } = await notifyTrips(PARK, events, { simulated: true });
  assert.equal(sent, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].title, '6 rides paused at once');
  assert.match(received[0].message, /Ride 0, Ride 1, Ride 2, Ride 3, Ride 4 and 1 more/);
  assert.match(received[0].message, /Magic Kingdom · /);
  assert.equal(received[0].click, 'https://parkalert.example/?trip=AAAAAA&view=hold');
});

test("an incident's rides coming back are one update, then an all-clear", async () => {
  const events = setup({ down: 4, hold: true });
  await notifyTrips(PARK, events);
  received.length = 0;
  const rides = parkState[PARK].rides;
  const up = (id) => ({ type: 'UP', ride: { id, ...rides[id], status: 'OPERATING' }, downtimeMs: 40 * 60_000, incident: 'hold-1' });
  rides.r0.status = 'OPERATING';
  rides.r1.status = 'OPERATING';
  await notifyTrips(PARK, [], { updates: [{ incident: 'hold-1', ups: [up('r0'), up('r1')], final: false }] });
  assert.deepEqual(received.map((m) => m.title), ['2 of 4 rides are back up']);
  assert.equal(received[0].priority, 2, 'a quiet update');
  rides.r2.status = 'OPERATING';
  rides.r3.status = 'CLOSED';
  await notifyTrips(PARK, [], { updates: [{ incident: 'hold-1', ups: [up('r2')], final: true }] });
  assert.equal(received[1].title, '3 of 4 rides are back up');
  assert.match(received[1].message, /Closed for now: Ride 3$/);
});

test("tapping a one-ride push opens that ride's sheet, on the right trip", async () => {
  const events = setup({ down: 1 });
  await notifyTrips(PARK, events, { simulated: true });
  assert.equal(received[0].click, 'https://parkalert.example/?trip=AAAAAA&ride=r0');
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
  assert.match(received[0].message, /^Opened at \d+:\d\d\u00a0[AP]M, late · Magic Kingdom/);
});

test('a trip nobody has opened in three weeks gets no pushes', async () => {
  // The same trip, opened 20 days ago, does get the push: the only
  // difference below is the three weeks.
  let events = setup({ down: 1, trip: { lastSeenAt: Date.now() - 20 * 24 * 3600_000, createdAt: 0 } });
  assert.equal((await notifyTrips(PARK, events, { simulated: true })).sent, 1);
  events = setup({ down: 1, trip: { lastSeenAt: Date.now() - 22 * 24 * 3600_000, createdAt: 0 } });
  const { sent } = await notifyTrips(PARK, events, { simulated: true });
  assert.equal(sent, 0);
  assert.equal(received.length, 0);
});

test('one slow phone does not hold up the others', async () => {
  const events = setup({ down: 1 });
  // The slow phone comes first, so sending in turn would make the other wait.
  slowTopics.add('t-a');
  trips.BBBBBB = { ...trips.AAAAAA, code: 'BBBBBB', topic: 't-b' };
  const start = Date.now();
  const { sent } = await notifyTrips(PARK, events, { simulated: true });
  slowTopics.clear();
  assert.equal(sent, 2);
  const fast = received.find((m) => m.topic === 't-b');
  assert.ok(fast.at - start < 500, `fast trip waited ${fast.at - start} ms`);
});
