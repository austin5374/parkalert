// The HTTP API end to end: the real server on a random port, against a fake
// ThemeParks.wiki and ntfy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const EPCOT = '47f90d2c-e191-4239-a466-5892ef59a88b';
let fakes, server, base;

before(async () => {
  fakes = await startFakes();
  for (const park of [MK, EPCOT]) {
    fakes.upstream.live[park] = [
      { id: `${park}-1`, name: 'First Ride', status: 'OPERATING', waitTime: 20 },
      { id: `${park}-2`, name: 'Second Ride', status: 'DOWN' },
    ];
  }
  ({ server } = await import('../server/index.js'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fakes.close();
});

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const newTrip = async (parkId = MK) => (await call('POST', '/api/trips', { parkId })).body.trip;

test('creating a trip returns a shareable code and a private topic', async () => {
  const { status, body } = await call('POST', '/api/trips', { parkId: MK });
  assert.equal(status, 201);
  assert.match(body.trip.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(body.trip.topic, new RegExp(`^parkalert-${body.trip.code.toLowerCase()}-[a-z0-9]{8}$`));
});

test('bad requests are 400s that say what is wrong, not 500s', async () => {
  for (const body of ['{oops', 'null', '[1,2]', '7']) {
    const r = await call('POST', '/api/trips', body);
    assert.equal(r.status, 400, `POST ${body}`);
    assert.ok(!/Cannot read|TypeError/.test(r.body.error), r.body.error);
  }
  assert.equal((await call('POST', '/api/trips', { parkId: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/trips', { parkId: { id: MK } })).status, 400);
});

test('codes are case-insensitive and unknown ones are 404', async () => {
  const trip = await newTrip();
  assert.equal((await call('GET', `/api/trips/${trip.code.toLowerCase()}`)).status, 200);
  assert.equal((await call('GET', '/api/trips/ZZZZZZ')).status, 404);
});

test('the dashboard carries the park, its rides and a reopen outlook for down rides', async () => {
  const trip = await newTrip();
  const { status, body } = await call('GET', `/api/trips/${trip.code}/dashboard`);
  assert.equal(status, 200);
  assert.equal(body.park.name, 'Magic Kingdom');
  assert.equal(body.rides.length, 2);
  assert.ok(body.rides.find((r) => r.status === 'DOWN').outlook);
});

test('a ride that is not in the park is 404, including prototype names', async () => {
  const trip = await newTrip();
  await call('GET', `/api/trips/${trip.code}/dashboard`);
  assert.equal((await call('GET', `/api/trips/${trip.code}/rides/${MK}-1`)).status, 200);
  for (const id of ['nope', '__proto__', 'constructor', 'toString']) {
    assert.equal((await call('GET', `/api/trips/${trip.code}/rides/${id}`)).status, 404, id);
  }
});

test('PATCH saves valid changes', async () => {
  const trip = await newTrip();
  const until = Date.now() + 3600_000;
  const r = await call('PATCH', `/api/trips/${trip.code}`, { watched: ['a', 'a', 'b'], mute: { until }, rideMutes: { c: true, d: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.trip.watched, ['a', 'b']);
  assert.deepEqual(r.body.trip.mute, { until });
  assert.deepEqual(r.body.trip.rideMutes, { c: true });
  const back = await call('PATCH', `/api/trips/${trip.code}`, { watched: null, mute: null, rideMutes: {} });
  assert.deepEqual([back.body.trip.watched, back.body.trip.mute, back.body.trip.rideMutes], [null, null, {}]);
});

test('PATCH rejects bad shapes and changes nothing', async () => {
  const trip = await newTrip();
  for (const body of [
    { watched: [1, { a: 2 }] },
    { watched: 'all' },
    { watched: Array.from({ length: 501 }, (_, i) => `r${i}`) },
    { mute: { until: 'tomorrow' } },
    { mute: 5 },
    { rideMutes: [1, 2, 3] },
    { rideMutes: { a: 'yes' } },
    { parkId: 'nope' },
    { watched: ['ok'], mute: { until: 'bad' } }, // one bad field rejects the lot
  ]) {
    const r = await call('PATCH', `/api/trips/${trip.code}`, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const now = (await call('GET', `/api/trips/${trip.code}`)).body.trip;
  assert.deepEqual([now.watched, now.mute, now.rideMutes], [null, null, {}]);
});

test('each park keeps its own follow list across park hops', async () => {
  const trip = await newTrip(MK);
  await call('PATCH', `/api/trips/${trip.code}`, { watched: [`${MK}-1`] });
  let t = (await call('PATCH', `/api/trips/${trip.code}`, { parkId: EPCOT })).body.trip;
  assert.equal(t.parkId, EPCOT);
  assert.equal(t.watched, null, 'a new park starts by following everything');
  t = (await call('PATCH', `/api/trips/${trip.code}`, { parkId: MK })).body.trip;
  assert.deepEqual(t.watched, [`${MK}-1`]);
});

test('the test alert reaches the trip topic with a tap-to-open link', async () => {
  const trip = await newTrip();
  fakes.pushes.length = 0;
  assert.equal((await call('POST', `/api/trips/${trip.code}/test`)).status, 200);
  assert.equal(fakes.pushes.length, 1);
  assert.equal(fakes.pushes[0].topic, trip.topic);
});

test('unknown routes are 404', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('DELETE', '/api/parks')).status, 404);
});
