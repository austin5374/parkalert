import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, clientKey } from '../server/ratelimit.js';

test('a bucket allows its burst, then refills at its hourly rate', () => {
  const l = createLimiter({ burst: 3, perHour: 60 }); // one a minute
  for (let i = 0; i < 3; i++) assert.equal(l.take('a', 0), 0);
  const wait = l.take('a', 0);
  assert.ok(wait > 59_000 && wait <= 60_000, `wait ${wait}`);
  assert.equal(l.take('a', 60_000), 0, 'a minute later there is one more');
  assert.ok(l.take('a', 60_000) > 0);
  assert.equal(l.take('b', 0), 0, 'clients have separate buckets');
});

test('wait checks without spending', () => {
  const l = createLimiter({ burst: 1, perHour: 60 });
  assert.equal(l.wait('a', 0), 0);
  assert.equal(l.wait('a', 0), 0);
  assert.equal(l.take('a', 0), 0);
  assert.ok(l.wait('a', 0) > 0);
});

test("the client is the proxy's last X-Forwarded-For entry, which it cannot forge", () => {
  const req = (xff, remote = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } });
  assert.equal(clientKey(req('1.2.3.4')), '1.2.3.4');
  assert.equal(clientKey(req('6.6.6.6, 1.2.3.4')), '1.2.3.4');
  assert.equal(clientKey(req(null)), '10.0.0.1');
});
