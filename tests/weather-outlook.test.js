// A storm hold as the app and alerts see it: stored airport reports and
// outage archive in, the down ride's outlook out.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const MIN = 60_000;
const H = 60 * MIN;
let fakes, store, downOutlook;
const now = Date.now();
const storm = (at, thunder) => ({ at, thunder, rain: !!thunder, events: [] });

before(async () => {
  fakes = await startFakes();
  store = await import('../server/store.js');
  ({ downOutlook } = await import('../server/poller.js'));
});
after(() => fakes.close());

// Eight past storms, an hour each; six outdoor rides close as each arrives
// and reopen 30 to 40 min after it ends.
beforeEach(() => {
  const obs = [];
  const episodes = [];
  for (let d = 1; d <= 8; d++) {
    const s = now - d * 24 * H;
    obs.push(storm(s - H, null), storm(s, 'here'), storm(s + H, null));
    for (let r = 0; r < 6; r++) {
      const reopen = s + H + (30 + ((d * 3 + r * 2) % 11)) * MIN;
      episodes.push({ rideId: `out${r}`, rideName: `Outdoor ${r}`, start: s - 5 * MIN, minutes: (reopen - s + 5 * MIN) / MIN, endedAs: 'OPERATING', kind: 'hold', date: `d${d}` });
    }
  }
  store.weather.obs = { KISM: obs };
  store.history.episodes = { [MK]: episodes };
  const rides = {};
  for (let r = 0; r < 6; r++) rides[`out${r}`] = { name: `Outdoor ${r}`, status: 'DOWN', downSince: now - 75 * MIN, downFrom: 'OPERATING' };
  store.parkState[MK] = { rides, timezone: 'America/New_York', schedule: null, lastPoll: now };
});

test('after the storm passes, the range runs from the all-clear and is narrow', async () => {
  const { addObservations } = await import('../server/weather.js');
  // Today's storm: began 80 min ago, ended 10 min ago.
  addObservations('KISM', [storm(now - 80 * MIN, 'here'), storm(now - 10 * MIN, null)], now);
  const o = downOutlook(MK, 'out0', 75, now);
  assert.equal(o.cause, 'lightning');
  assert.equal(o.weather, 'passed');
  assert.match(o.text, /^Storm passed at \d{1,2}:\d{2}\s?[AP]M\. Often back in \d+ to \d+ min$/);
  assert.equal(o.basis.from, 'ride');
  assert.ok(o.window.hi - o.window.lo <= 15, `window ${o.window.lo}-${o.window.hi}`);
  assert.ok(o.window.lo >= 15 && o.window.hi <= 35, `window ${o.window.lo}-${o.window.hi}`);
});

test('while the storm goes on, it says so and allows for how long storms last', async () => {
  const { addObservations } = await import('../server/weather.js');
  addObservations('KISM', [storm(now - 80 * MIN, 'here'), storm(now - 5 * MIN, 'here')], now);
  const o = downOutlook(MK, 'out0', 75, now);
  assert.equal(o.weather, 'ongoing');
  assert.match(o.text, /^Lightning still nearby\./);
});

test('with no recent weather reports, the ordinary estimate stands', async () => {
  const { addObservations } = await import('../server/weather.js');
  addObservations('KISM', [storm(now - 5 * H, 'here')], now);
  const o = downOutlook(MK, 'out0', 75, now);
  assert.equal(o.cause, undefined);
  assert.doesNotMatch(o.text || '', /Storm|Lightning/);
});
