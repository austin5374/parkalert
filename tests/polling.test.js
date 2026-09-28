// The real poll path, from ThemeParks.wiki response to ntfy push, against fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
let fakes, trips, parkState, pollPark, MAX_GAP_MS;

before(async () => {
  fakes = await startFakes();
  ({ trips, parkState } = await import('../server/store.js'));
  ({ pollPark, MAX_GAP_MS } = await import('../server/poller.js'));
});
after(() => fakes.close());

// One trip following everything at PARK, and a known previous snapshot.
function setup(prevRides, lastPoll) {
  fakes.pushes.length = 0;
  for (const k of Object.keys(trips)) delete trips[k];
  trips.AAAAAA = { code: 'AAAAAA', topic: 't-a', parkId: PARK, watched: null, mute: null, rideMutes: {} };
  parkState[PARK] = { rides: prevRides, timezone: 'America/New_York', schedule: null, lastPoll };
}
const ride = (name, status, since) => ({ name, status, since, downSince: status === 'DOWN' ? since : null, downFrom: status === 'DOWN' ? 'OPERATING' : null });

test('a change since a recent poll alerts as usual', async () => {
  const now = Date.now();
  setup({ p1: ride('Ride P1', 'OPERATING', now - 3600_000) }, now - 60_000);
  fakes.upstream.live[PARK] = [{ id: 'p1', name: 'Ride P1', status: 'DOWN' }];
  await pollPark(PARK);
  assert.deepEqual(fakes.pushes.map((p) => p.title), ['Ride P1 is down']);
});

test('after a gap in polling there are no alerts, and clocks start afresh', async () => {
  const now = Date.now();
  const yesterday = now - 18 * 3600_000;
  // Left for another park yesterday afternoon with p2 down and p3 running.
  setup({ p2: ride('Ride P2', 'DOWN', yesterday), p3: ride('Ride P3', 'OPERATING', yesterday) }, yesterday);
  fakes.upstream.live[PARK] = [
    { id: 'p2', name: 'Ride P2', status: 'OPERATING', waitTime: 20 },
    { id: 'p3', name: 'Ride P3', status: 'DOWN' },
  ];
  await pollPark(PARK);
  assert.deepEqual(fakes.pushes, [], 'no "back up, was down 18h" and no stale "down"');
  const { rides, recent } = parkState[PARK];
  assert.ok(rides.p3.downSince >= now, 'a ride down now is not "down 18 hr"');
  assert.ok(rides.p2.since >= now);
  assert.deepEqual(recent, []);
});

test('the gap threshold sits between a redeploy and a park hop', () => {
  assert.ok(MAX_GAP_MS >= 5 * 60_000 && MAX_GAP_MS <= 30 * 60_000);
});

test('an empty live response is a failed poll, not every ride vanishing', async () => {
  const now = Date.now();
  setup({ p4: ride('Ride P4', 'DOWN', now - 30 * 60_000) }, now - 60_000);
  fakes.upstream.live[PARK] = [];
  await pollPark(PARK);
  assert.equal(parkState[PARK].lastError, 'live data came back empty');
  assert.equal(parkState[PARK].rides.p4.downSince, now - 30 * 60_000);
});

test('a down ride that closes mid-day sends "has closed"', async () => {
  const now = Date.now();
  setup({ p5: ride('Ride P5', 'DOWN', now - 40 * 60_000) }, now - 60_000);
  fakes.upstream.live[PARK] = [{ id: 'p5', name: 'Ride P5', status: 'CLOSED' }];
  await pollPark(PARK);
  assert.deepEqual(fakes.pushes.map((p) => p.title), ['Ride P5 has closed']);
  assert.match(fakes.pushes[0].message, /^Down since .*, now closed\. It may not reopen today · Magic Kingdom$/);
});

test('a wait alert fires once when the wait drops to the limit, and not while paused', async () => {
  const { localDate } = await import('../server/time.js');
  const now = Date.now();
  const today = localDate(now, 'America/New_York');
  setup({ p6: ride('Ride P6', 'OPERATING', now - 3600_000) }, now - 60_000);
  trips.AAAAAA.waitAlerts = { p6: { max: 30, day: today, setAt: now } };
  const poll = async (waitTime) => {
    fakes.upstream.live[PARK] = [{ id: 'p6', name: 'Ride P6', status: 'OPERATING', waitTime }];
    parkState[PARK].lastPoll = Date.now() - 60_000;
    await pollPark(PARK);
  };
  await poll(45);
  assert.deepEqual(fakes.pushes, []);
  trips.AAAAAA.mute = { until: Date.now() + 60_000 };
  await poll(25);
  assert.deepEqual(fakes.pushes, [], 'paused: held, not used up');
  trips.AAAAAA.mute = null;
  await poll(25);
  assert.deepEqual(fakes.pushes.map((p) => p.title), ['Ride P6: 25 min wait']);
  assert.equal(trips.AAAAAA.waitAlerts.p6.sentWait, 25);
  await poll(20);
  assert.equal(fakes.pushes.length, 1, 'only once');
});
