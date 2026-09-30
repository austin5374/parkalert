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
// Each test trip comes from its own address, so the suite never runs into
// the per-client limit on creating trips (tested separately).
let tripClient = 0;
async function newTrip(parkId = MK) {
  const res = await fetch(`${base}/api/trips`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': `198.51.100.${++tripClient}` },
    body: JSON.stringify({ parkId }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).trip;
}

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

test("a test from the ntfy setup says so, and an odd body still means everyone", async () => {
  const trip = await newTrip();
  fakes.pushes.length = 0;
  assert.equal((await call('POST', `/api/trips/${trip.code}/test`, { to: 'ntfy' })).status, 200);
  assert.match(fakes.pushes[0].message, /ntfy setup/);
  assert.equal((await call('POST', `/api/trips/${trip.code}/test`, 'null')).status, 200);
  assert.match(fakes.pushes[1].message, /Someone on your trip/);
});

test('unknown routes are 404', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('DELETE', '/api/parks')).status, 404);
});

test('test alerts are rate limited with a Retry-After', async () => {
  const trip = await newTrip();
  const send = () => fetch(`${base}/api/trips/${trip.code}/test`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.7' } });
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await send()).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  const res = await send();
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('guessing trip codes runs out quickly, and then even a right guess waits', async () => {
  const trip = await newTrip();
  const get = (code) => fetch(`${base}/api/trips/${code}`, { headers: { 'X-Forwarded-For': '203.0.113.8' } });
  let misses = 0;
  while ((await get('ZZZZZ2')).status === 404) misses++;
  assert.equal(misses, 30);
  assert.equal((await get(trip.code)).status, 429);
  // Another client is unaffected.
  assert.equal((await fetch(`${base}/api/trips/${trip.code}`)).status, 200);
});

test('a phone already on a trip keeps it when someone behind its address spends the guesses', async () => {
  const trip = await newTrip();
  const get = (code) => fetch(`${base}/api/trips/${code}`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal((await get(trip.code)).status, 200); // opened once
  while ((await get('ZZZZZ3')).status === 404);
  assert.equal((await get('ZZZZZ4')).status, 429);
  assert.equal((await get(trip.code)).status, 200);
});

test('IPv6 clients are limited per /64, not per address', async () => {
  const { networkKey } = await import('../server/ratelimit.js');
  assert.equal(networkKey('2001:db8:abcd:12:1::5'), '2001:db8:abcd:12::/64');
  assert.equal(networkKey('2001:db8:abcd:12:ffff:1:2:3'), '2001:db8:abcd:12::/64');
  assert.equal(networkKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkKey('::ffff:198.51.100.4'), '198.51.100.4');
  assert.equal(networkKey('198.51.100.4'), '198.51.100.4');
});

test('the page and the dashboard carry the same app version, so an old page can tell', async () => {
  const trip = await newTrip();
  const html = await (await fetch(`${base}/`)).text();
  const version = html.match(/name="parkalert-version" content="([0-9a-f]{12})"/)?.[1];
  assert.ok(version, 'index.html is stamped');
  const { body } = await call('GET', `/api/trips/${trip.code}/dashboard`);
  assert.equal(body.version, version);
});

test('an unchanged dashboard is a 304 with no body', async () => {
  const trip = await newTrip();
  // Creating a trip warms its park with a poll; a fresh snapshot is answered
  // without waiting for it, so let it land before comparing.
  const { pollPark } = await import('../server/poller.js');
  await pollPark(MK);
  const first = await fetch(`${base}/api/trips/${trip.code}/dashboard`);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/api/trips/${trip.code}/dashboard`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);
});

test('right after a park switch the dashboard shows that park now, not an old snapshot', async () => {
  const { parkState } = await import('../server/store.js');
  const yesterday = Date.now() - 20 * 3600_000;
  // EPCOT was last polled yesterday, with its first ride down.
  parkState[EPCOT] = {
    timezone: 'America/New_York', schedule: null, lastPoll: yesterday,
    rides: { [`${EPCOT}-1`]: { name: 'First Ride', status: 'DOWN', since: yesterday, downSince: yesterday, downFrom: 'OPERATING' } },
  };
  const trip = await newTrip(MK);
  await call('PATCH', `/api/trips/${trip.code}`, { parkId: EPCOT });
  const { body } = await call('GET', `/api/trips/${trip.code}/dashboard`);
  assert.ok(body.lastPoll > yesterday);
  assert.equal(body.rides.find((r) => r.id === `${EPCOT}-1`).status, 'OPERATING');
});

test('a simulated alert goes through the real pipeline and says it is a test', async () => {
  const trip = await newTrip();
  await call('GET', `/api/trips/${trip.code}/dashboard`);
  fakes.pushes.length = 0;
  const r = await call('POST', `/api/trips/${trip.code}/simulate`, { type: 'down' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sent, 1);
  assert.match(fakes.pushes[0].message, /SIMULATED TEST/);
  assert.match(fakes.pushes[0].title, / is down$/);
  // A paused trip is muted for simulations too.
  await call('PATCH', `/api/trips/${trip.code}`, { mute: { until: null } });
  assert.equal((await call('POST', `/api/trips/${trip.code}/simulate`, { type: 'up' })).body.sent, 0);
});

test('the app and its files are served, with revalidation', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const js = await fetch(`${base}/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  const again = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': js.headers.get('etag') } });
  assert.equal(again.status, 304);
  // Unknown paths are the app, so a shared deep link still opens it.
  assert.match(await (await fetch(`${base}/some/deep/link`)).text(), /<title>ParkAlert<\/title>/);
});

test('nothing outside public/ is ever served', async () => {
  const net = await import('node:net');
  // fetch() normalises "..", so send raw request lines to test the server itself.
  const raw = (target) => new Promise((resolve) => {
    const sock = net.connect(server.address().port, '127.0.0.1', () => sock.end(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('end', () => resolve(out));
  });
  for (const target of ['/../server/index.js', '/%2e%2e/server/index.js', '/..%2fserver/index.js', '/../package.json']) {
    const res = await raw(target);
    assert.ok(!/THEMEPARKS_BASE|"devDependencies"/.test(res), `${target} leaked a file outside public/`);
  }
});

test('an oversized body is refused with a 413, and non-ASCII JSON reads correctly', async () => {
  const trip = await newTrip();
  const big = await call('PATCH', `/api/trips/${trip.code}`, JSON.stringify({ watched: ['x'.repeat(300_000)] }));
  assert.equal(big.status, 413);
  // A name that would straddle chunk boundaries if split mid-character.
  const ids = Array.from({ length: 300 }, (_, i) => `rïdé-${i}-🎢`);
  const r = await call('PATCH', `/api/trips/${trip.code}`, { watched: ids });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.trip.watched, ids);
});

test('every response carries the security headers', async () => {
  for (const path of ['/', '/app.js', '/api/parks', '/api/trips/ZZZZZ3']) {
    const res = await fetch(base + path);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('every park names the resort it is listed under', async () => {
  const { parks } = (await call('GET', '/api/parks')).body;
  assert.ok(parks.every((p) => typeof p.resort === 'string' && p.resort && p.timezone));
});

test("a California park runs on Pacific time even when its schedule doesn't say", async () => {
  const DCA = '832fcd51-ea19-4e77-85c7-75d5843b127c';
  fakes.upstream.schedule[DCA] = { schedule: [] }; // no timezone in the response
  fakes.upstream.live[DCA] = [{ id: 'dca-1', name: 'Ride', status: 'OPERATING', waitTime: 5 }];
  const trip = await newTrip(DCA);
  const { body } = await call('GET', `/api/trips/${trip.code}/dashboard`);
  assert.equal(body.park.timezone, 'America/Los_Angeles');
});

test('health reports each watched park, and fails once one stops being polled', async () => {
  const { parkState } = await import('../server/store.js');
  const trip = await newTrip(MK);
  await call('GET', `/api/trips/${trip.code}/dashboard`);
  let r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.parks, undefined, 'which parks are watched is not public');
  r = await call('GET', '/api/health?token=health-secret');
  assert.ok(r.body.parks.some((p) => p.name === 'Magic Kingdom' && p.ageSeconds < 60));
  assert.ok(!JSON.stringify(r.body).includes(trip.code), 'no trip codes');
  const saved = parkState[MK].lastPoll;
  parkState[MK].lastPoll = Date.now() - 10 * 60_000;
  r = await call('GET', '/api/health');
  parkState[MK].lastPoll = saved;
  assert.equal(r.status, 503);
  assert.equal(r.body.ok, false);
});

test('one client can only mint so many trips', async () => {
  const mint = () => fetch(`${base}/api/trips`, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ parkId: MK }) });
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await mint()).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(201));
  assert.equal(statuses[20], 429);
});

test('wait alerts can be set, re-set and removed, and bad ones are refused', async () => {
  const trip = await newTrip();
  const put = (id, body) => call('PUT', `/api/trips/${trip.code}/wait-alerts/${id}`, body);
  let r = await put(`${MK}-1`, { max: 30 });
  assert.equal(r.status, 200);
  assert.equal(r.body.trip.waitAlerts[`${MK}-1`].max, 30);
  r = await put(`${MK}-1`, { max: 20 });
  assert.equal(r.body.trip.waitAlerts[`${MK}-1`].max, 20);
  for (const body of [{ max: 2 }, { max: 500 }, { max: 12.5 }, { max: '30' }, {}]) {
    assert.equal((await put(`${MK}-1`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await put('%E0%A4%A', { max: 30 })).status, 400, 'malformed id');
  r = await call('DELETE', `/api/trips/${trip.code}/wait-alerts/${MK}-1`);
  assert.deepEqual(r.body.trip.waitAlerts, {});
  assert.deepEqual((await call('GET', `/api/trips/${trip.code}`)).body.trip.waitAlerts, {});
});

test('API JSON over 1 KB is gzipped for clients that take it', async () => {
  const trip = await newTrip();
  const res = await fetch(`${base}/api/trips/${trip.code}/dashboard`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.equal(res.headers.get('vary'), 'Accept-Encoding');
  assert.ok((await res.json()).rides, 'and reads as the same JSON');
  const small = await fetch(`${base}/api/trips/${trip.code}`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(small.headers.get('content-encoding'), null, 'small answers are not worth it');
});

test("the page's one inline script is allowed by its hash, and no other", async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy');
  const html = await res.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(script).digest('base64');
  assert.match(csp, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`));
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*;[^;]*script|script-src[^;]*unsafe-inline/);
});

test('bad input at the edges is a 400 or 404, never a 500 or a silent accept', async () => {
  // A broken escape in the address.
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  const trip = await newTrip();
  await call('GET', `/api/trips/${trip.code}/dashboard`);
  // A wait alert for a ride the park doesn't have could never fire.
  assert.equal((await call('PUT', `/api/trips/${trip.code}/wait-alerts/no-such-ride`, { max: 30 })).status, 404);
  assert.equal((await call('PUT', `/api/trips/${trip.code}/wait-alerts/${MK}-1`, { max: 30 })).status, 200);
  // A pause ends at a real time within the year.
  for (const until of [-5, 0, Date.now() + 400 * 24 * 3600_000]) {
    assert.equal((await call('PATCH', `/api/trips/${trip.code}`, { mute: { until } })).status, 400, `until ${until}`);
  }
  assert.equal((await call('PATCH', `/api/trips/${trip.code}`, { mute: { until: Date.now() + 3600_000 } })).status, 200);
});

test("a trip's own manifest opens the installed app on that trip", async () => {
  const plain = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(plain.start_url, '/');
  const res = await fetch(`${base}/manifest.webmanifest?trip=mklabs`);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
  const own = await res.json();
  assert.equal(own.start_url, '/?trip=MKLABS');
  assert.equal(own.id, plain.id, 'still the same app');
  assert.equal((await (await fetch(`${base}/manifest.webmanifest?trip=<script>`)).json()).start_url, '/', 'only a code');
});

test('a phone whose push subscription was replaced keeps its place and its pause', async () => {
  const trip = await newTrip();
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const sub = (tag) => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const raw = publicKey.export({ format: 'jwk' });
    const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]).toString('base64url');
    return { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${tag}`, keys: { p256dh, auth: randomBytes(16).toString('base64url') } } };
  };
  const made = await call('POST', `/api/trips/${trip.code}/devices`, sub('old'));
  assert.equal(made.status, 201);
  const id = made.body.device.id;
  await call('PATCH', `/api/trips/${trip.code}/devices/${id}`, { mute: { until: null } });
  const put = await call('PUT', `/api/trips/${trip.code}/devices/${id}`, sub('new'));
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.device, { id, mute: { until: null } });
  const { trips } = await import('../server/store.js');
  assert.equal(trips[trip.code].devices.length, 1);
  assert.match(trips[trip.code].devices[0].endpoint, /\/new$/);
  assert.equal((await call('PUT', `/api/trips/${trip.code}/devices/nope`, sub('x'))).status, 404);
});

test('a phone registered on a new trip stops getting the old trip\'s alerts', async () => {
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ format: 'jwk' });
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]).toString('base64url');
  const sub = { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/same-phone', keys: { p256dh, auth: randomBytes(16).toString('base64url') } } };
  const oldTrip = await newTrip();
  const newer = await newTrip();
  assert.equal((await call('POST', `/api/trips/${oldTrip.code}/devices`, sub)).status, 201);
  assert.equal((await call('POST', `/api/trips/${newer.code}/devices`, sub)).status, 201);
  const { trips } = await import('../server/store.js');
  assert.equal(trips[oldTrip.code].devices.length, 0, 'gone from the old trip');
  assert.equal(trips[newer.code].devices.length, 1);
});

test('ntfy can be turned off for a trip, and says so', async () => {
  const trip = await newTrip();
  assert.equal((await call('GET', `/api/trips/${trip.code}`)).body.trip.ntfy, true, 'on by default');
  const off = await call('PATCH', `/api/trips/${trip.code}`, { ntfy: false });
  assert.equal(off.body.trip.ntfy, false);
  assert.equal((await call('PATCH', `/api/trips/${trip.code}`, { ntfy: 'no' })).status, 400);
});
