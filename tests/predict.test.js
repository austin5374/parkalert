import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remaining, estimate, describe, weatherHold, MIN_SAMPLES } from '../server/predict.js';

const ep = (minutes, extra = {}) => ({ rideId: 'a', minutes, endedAs: 'OPERATING', kind: 'breakdown', ...extra });
const eps = (list, extra) => list.map((m) => ep(m, extra));

test('with no censoring, quantiles are the plain order statistics', () => {
  const r = remaining(eps([10, 20, 30, 40, 50]), 0);
  assert.deepEqual([r.p25, r.p50, r.p75], [20, 30, 40]);
  assert.equal(r.n, 5);
});

test('too few comparable outages gives no estimate', () => {
  const few = Array.from({ length: MIN_SAMPLES - 1 }, (_, i) => 10 * (i + 1));
  assert.equal(remaining(eps(few), 0), null);
});

test('the estimate is conditional on time already down', () => {
  const r = remaining(eps([5, 5, 5, 5, 5, 60, 70, 80, 90, 100]), 30);
  // Only the five long outages are still in play; 30 min is already spent.
  assert.deepEqual([r.p25, r.p50, r.p75], [40, 50, 60]);
  assert.equal(r.n, 5);
});

test('censored outages lengthen the estimate instead of counting as reopenings', () => {
  const resolved = eps([10, 20, 30, 40, 50, 60]);
  const withCensored = [...resolved, ...eps([15, 15, 15], { endedAs: 'CLOSED' })];
  const naive = remaining([...resolved, ...eps([15, 15, 15])], 0);
  const km = remaining(withCensored, 0);
  assert.ok(km.p50 > naive.p50, `KM median ${km.p50} should exceed naive ${naive.p50}`);
});

test('stayedDownShare counts long outages that never reopened', () => {
  const r = remaining([...eps([10, 20, 30, 40]), ep(300, { endedAs: 'CLOSED' })], 0);
  assert.equal(r.stayedDownShare, 0.2);
});

test('a ride with enough of its own history uses it; otherwise the park pool', () => {
  const own = eps([100, 100, 100, 100, 100, 100, 100, 100]);
  const others = eps([5, 5, 5, 5, 5, 5], { rideId: 'b' });
  assert.equal(estimate({ P: [...own, ...others] }, 'P', 'a', 0, false).basis, 'ride');
  const est = estimate({ P: [...own.slice(0, 3), ...others] }, 'P', 'a', 0, false);
  assert.equal(est.basis, 'park');
});

test('weather holds pool weather episodes only, falling back to every park', () => {
  const storms = eps([40, 45, 50, 60, 110], { kind: 'weather' });
  const breakdowns = eps([5, 5, 5, 5, 5, 5]);
  const here = estimate({ P: [...storms, ...breakdowns] }, 'P', 'a', 0, true);
  assert.equal(here.basis, 'park');
  assert.equal(here.kind, 'weather');
  assert.ok(here.p50 >= 40);
  const elsewhere = estimate({ P: breakdowns, Q: storms }, 'P', 'a', 0, true);
  assert.equal(elsewhere.basis, 'all parks');
});

test('down longer than nearly all history says so instead of inventing a number', () => {
  const est = estimate({ P: eps([5, 6, 7, 8, 9, 10]) }, 'P', 'a', 120, false);
  assert.deepEqual(est, { longerThanUsual: true, kind: 'breakdown' });
  assert.equal(describe(est), 'Down longer than most outages here');
});

test('no history at all gives no estimate', () => {
  assert.equal(estimate({}, 'P', 'a', 0, false), null);
  assert.equal(describe(null), null);
});

test('describe reads like a person said it', () => {
  assert.equal(describe({ p25: 4.2, p50: 12, p75: 38, stayedDownShare: 0 }), 'Usually back in 4 to 40 min');
  assert.equal(describe({ p25: 20, p50: 30, p75: null, stayedDownShare: 0 }), 'Usually back in about 30 min');
  assert.equal(
    describe({ p25: 30, p50: 60, p75: 120, stayedDownShare: 0.14 }),
    'Usually back in 30 to 120 min. About 14% stay closed for the day'
  );
});

test('weatherHold needs five rides down within ten minutes of this one', () => {
  const t = 1_000_000_000;
  const rides = {};
  for (let i = 0; i < 5; i++) rides[`r${i}`] = { status: 'DOWN', downSince: t + i * 60_000 };
  rides.late = { status: 'DOWN', downSince: t + 60 * 60_000 };
  rides.open = { status: 'OPERATING', downSince: null };
  assert.deepEqual(weatherHold(rides, 'r0'), { rides: 5 });
  assert.equal(weatherHold(rides, 'late'), null);
  assert.equal(weatherHold(rides, 'open'), null);
  delete rides.r4;
  assert.equal(weatherHold(rides, 'r0'), null);
});
