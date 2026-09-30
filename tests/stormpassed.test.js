// "Storm passed": when the lightning behind a hold clears, trips following
// its rides hear it once, with when rides usually reopen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const MIN = 60_000;
const H = 60 * MIN;
let fakes, store, notifyStormPassed, addObservations;
const now = Date.now();
const storm = (at, thunder) => ({ at, thunder, rain: !!thunder, events: [] });

before(async () => {
  fakes = await startFakes();
  store = await import('../server/store.js');
  ({ notifyStormPassed } = await import('../server/poller.js'));
  ({ addObservations } = await import('../server/weather.js'));
  // Eight past storms, an hour each; six outdoor rides close as each arrives
  // and reopen 30 to 40 min after it ends.
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
});
after(() => fakes.close());

function hold(thunderNow) {
  // The latest report: clear 10 minutes ago, or lightning 9 minutes ago.
  addObservations('KISM', [storm(now - 80 * MIN, 'here'), thunderNow ? storm(now - 9 * MIN, 'here') : storm(now - 10 * MIN, null)], now);
  const rides = {};
  for (let r = 0; r < 6; r++) {
    rides[`out${r}`] = { name: `Outdoor ${r}`, status: 'DOWN', downSince: now - 75 * MIN, downFrom: 'OPERATING', liveKind: 'hold', incident: 'hold-1', holdSize: 6 };
  }
  store.parkState[MK] = {
    rides, timezone: 'America/New_York', schedule: null, lastPoll: now,
    incidents: { 'hold-1': { id: 'hold-1', kind: 'hold', rides: Object.keys(rides), start: now - 75 * MIN } },
  };
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.trips.FOLLOW = { code: 'FOLLOW', topic: 'follow', parkId: MK, watched: null, rideMutes: {}, createdAt: now };
  store.trips.OTHERS = { code: 'OTHERS', topic: 'others', parkId: MK, watched: ['elsewhere'], rideMutes: {}, createdAt: now };
}

test('when the storm behind a hold passes, trips following its rides hear it once', async () => {
  hold(false);
  fakes.pushes.length = 0;
  assert.equal(await notifyStormPassed(MK, now), 1);
  assert.deepEqual(fakes.pushes.map((p) => p.topic), ['follow']);
  const [p] = fakes.pushes;
  assert.match(p.title, /^The storm seems to have passed at \d{1,2}:\d{2}\s[AP]M$/);
  assert.match(p.message, /^Outdoor rides likely back \d{1,2}:\d{2}\s[AP]M or later, after testing\n6 rides still closed: Outdoor 0, /);
  // Once for this all-clear.
  assert.equal(await notifyStormPassed(MK, now + MIN), 0);
});

test('nothing while the lightning is still around', async () => {
  hold(true);
  fakes.pushes.length = 0;
  // Past the few seconds a hold's outlook is kept for.
  assert.equal(await notifyStormPassed(MK, now + 20_000), 0);
  assert.equal(fakes.pushes.length, 0);
});
