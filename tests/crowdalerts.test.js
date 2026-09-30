// "Lines are building", end to end: waits outpacing a usual day reach the
// trips that asked for it, once each, and nobody else; a hold pauses it.
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
let store, notifyCrowds, parseTripPatch, parkCrowd;
before(async () => {
  await new Promise((r) => ntfy.listen(0, r));
  process.env.NTFY_BASE = `http://127.0.0.1:${ntfy.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-crowd-'));
  store = await import('../server/store.js');
  ({ notifyCrowds } = await import('../server/poller.js'));
  ({ parseTripPatch } = await import('../server/validate.js'));
  ({ parkCrowd } = await import('../server/crowdstate.js'));
});
after(() => ntfy.close());

const MIN = 60_000;
// Seven big rides, usually 30 min (one usually 40), all posting.
function park(now, waits, extra = {}) {
  const rides = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const usual = Object.fromEntries(rides.map((id) => [id, Array(24).fill(id === 'g' ? 40 : 30)]));
  store.history.waits = { [PARK]: { '2026-09-20': usual, '2026-09-21': usual, '2026-09-22': usual } };
  store.parkState[PARK] = {
    timezone: 'America/New_York',
    schedule: null,
    lastPoll: now,
    rides: Object.fromEntries(rides.map((id) => [id, { name: `Ride ${id}`, status: 'OPERATING', waitTime: waits[id] ?? 60 }])),
    // Half an hour ago, waits were at their usual.
    crowd: [[now - 40 * MIN, 1, 31], [now - 35 * MIN, 1, 31]],
    ...extra,
  };
}

test('waits outpacing a usual day alert each trip that asked, once, with rides worth heading for', async () => {
  const now = Date.now();
  park(now, { g: 20 });
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.YESYES = { code: 'YESYES', topic: 'yes', parkId: PARK, crowdAlerts: true, createdAt: now };
  store.trips.PICKYY = { code: 'PICKYY', topic: 'picky', parkId: PARK, crowdAlerts: true, watched: ['a'], createdAt: now };
  store.trips.NONONO = { code: 'NONONO', topic: 'no', parkId: PARK, createdAt: now };
  received.length = 0;
  assert.equal(await notifyCrowds(PARK, now), 2);
  const byTopic = Object.fromEntries(received.map((m) => [m.topic, m]));
  assert.deepEqual(Object.keys(byTopic).sort(), ['picky', 'yes']);
  assert.match(byTopic.yes.title, /Lines are building at Magic Kingdom/);
  assert.match(byTopic.yes.message, /average about 54 min, up from 31 half an hour ago/);
  assert.match(byTopic.yes.message, /Shorter than usual now: Ride g 20 min \(usually 40\)/);
  assert.doesNotMatch(byTopic.picky.message, /Shorter than usual/, 'only rides the trip follows');
  // Not again within two hours for those trips...
  received.length = 0;
  assert.equal(await notifyCrowds(PARK, now + MIN), 0);
  // ...but a trip that turns it on now still hears, while lines are building.
  store.trips.LATEYY = { code: 'LATEYY', topic: 'late', parkId: PARK, crowdAlerts: true, createdAt: now };
  assert.equal(await notifyCrowds(PARK, now + 2 * MIN), 1);
  assert.deepEqual(received.map((m) => m.topic), ['late']);
});

test('during a hold and for half an hour after, the crowd level pauses and nothing alerts', async () => {
  const now = Date.now();
  park(now, {}, { incidents: { h1: { id: 'h1', kind: 'hold', rides: ['x'], start: now - 20 * MIN } } });
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.YESYES = { code: 'YESYES', topic: 'yes', parkId: PARK, crowdAlerts: true, createdAt: now };
  received.length = 0;
  assert.equal(await notifyCrowds(PARK, now), 0);
  assert.deepEqual(store.parkState[PARK].crowd, [], 'readings from before the hold are dropped');
  assert.equal(parkCrowd(PARK, now).paused, 'hold');
  // Twenty minutes after it ended: still settling.
  store.parkState[PARK].incidents.h1.endedAt = now;
  store.parkState[PARK].lastPoll = now + 20 * MIN;
  assert.equal(await notifyCrowds(PARK, now + 20 * MIN), 0);
  assert.equal(parkCrowd(PARK, now + 20 * MIN).paused, 'hold');
  // Past the half hour, readings start again from scratch.
  store.parkState[PARK].lastPoll = now + 31 * MIN;
  assert.equal(await notifyCrowds(PARK, now + 31 * MIN), 0, 'no reading from half an hour ago yet');
  const c = parkCrowd(PARK, now + 31 * MIN);
  assert.equal(c.paused, null);
  assert.equal(c.label, 'Much busier than usual');
  assert.equal(received.length, 0);
});

test('the setting must be true or false', () => {
  assert.deepEqual(parseTripPatch({ crowdAlerts: true }, () => true), { crowdAlerts: true });
  assert.throws(() => parseTripPatch({ crowdAlerts: 'yes' }, () => true), /crowdAlerts/);
});
