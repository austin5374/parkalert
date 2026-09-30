// What a trip has alerts on: a new trip starts with the park's headliners
// (every ride while the archive is too young to know them), and attractions
// that never post a wait never alert.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const EPCOT = '47f90d2c-e191-4239-a466-5892ef59a88b';
let fakes, server, base, store, notifyTrips;

// Twelve rides that post waits (r1 longest) and a castle that never does.
const RIDES = Array.from({ length: 12 }, (_, i) => ({ id: `r${i + 1}`, name: `Ride ${i + 1}`, usual: 120 - i * 10 }));
before(async () => {
  fakes = await startFakes();
  fakes.upstream.live[MK] = [
    ...RIDES.map((r) => ({ id: r.id, name: r.name, status: 'OPERATING', waitTime: r.usual })),
    { id: 'castle', name: 'Cinderella Castle', status: 'OPERATING' },
  ];
  fakes.upstream.live[EPCOT] = [{ id: 'e1', name: 'Epcot Ride', status: 'OPERATING', waitTime: 20 }];
  store = await import('../server/store.js');
  const day = Object.fromEntries(RIDES.map((r) => [r.id, Array(24).fill(r.usual)]));
  store.history.waits = { [MK]: { '2026-09-20': day, '2026-09-21': day, '2026-09-22': day } };
  ({ server } = await import('../server/index.js'));
  ({ notifyTrips } = await import('../server/poller.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fakes.close();
});

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'X-Forwarded-For': '192.0.2.9' }, body: body && JSON.stringify(body) });
  return res.json();
};

test("a new trip has alerts on for the park's ten headliners; a park with no archive yet, every ride", async () => {
  const { trip } = await call('POST', '/api/trips', { parkId: MK });
  assert.deepEqual(trip.watched, RIDES.slice(0, 10).map((r) => r.id));
  // Hopping to a park it hasn't been to: that park's default, and back again
  // restores what it had.
  let t = (await call('PATCH', `/api/trips/${trip.code}`, { parkId: EPCOT })).trip;
  assert.equal(t.watched, null);
  t = (await call('PATCH', `/api/trips/${trip.code}`, { watched: [] })).trip;
  t = (await call('PATCH', `/api/trips/${trip.code}`, { parkId: MK })).trip;
  assert.deepEqual(t.watched, RIDES.slice(0, 10).map((r) => r.id));
  t = (await call('PATCH', `/api/trips/${trip.code}`, { parkId: EPCOT })).trip;
  assert.deepEqual(t.watched, [], 'a list chosen at a park is kept for it');
});

test('the dashboard marks attractions that never post a wait, and gives each ride its usual wait', async () => {
  const { trip } = await call('POST', '/api/trips', { parkId: MK });
  const dash = await call('GET', `/api/trips/${trip.code}/dashboard`);
  const castle = dash.rides.find((r) => r.id === 'castle');
  assert.equal(castle.other, true);
  const r1 = dash.rides.find((r) => r.id === 'r1');
  assert.equal(r1.other, undefined);
  assert.equal(r1.usual, 120);
});

test('an attraction that never posts a wait never alerts, even for a trip following everything', async () => {
  const now = Date.now();
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.ALLALL = { code: 'ALLALL', topic: 'all', parkId: MK, watched: null, rideMutes: {}, createdAt: now };
  fakes.pushes.length = 0;
  const castle = { id: 'castle', ...store.parkState[MK].rides.castle, status: 'DOWN', downSince: now };
  await notifyTrips(MK, [{ type: 'DOWN', ride: castle }], { now });
  assert.equal(fakes.pushes.length, 0);
  const ride = { id: 'r3', ...store.parkState[MK].rides.r3, status: 'DOWN', downSince: now };
  await notifyTrips(MK, [{ type: 'DOWN', ride }], { now });
  assert.equal(fakes.pushes.length, 1);
  assert.match(fakes.pushes[0].title, /Ride 3 is down/);
});
