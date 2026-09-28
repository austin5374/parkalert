// The nightly archive backfill against a fake ThemeParks.wiki history API.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

let fakes, history, syncHistory, PARKS;
// Noon in Orlando on 2026-09-28: the 21st to the 27th are settled days.
const NOW = Date.parse('2026-09-28T16:00:00Z');
const DAY = 24 * 3600_000;

before(async () => {
  fakes = await startFakes();
  ({ history } = await import('../server/store.js'));
  ({ syncHistory } = await import('../server/history.js'));
  ({ PARKS } = await import('../server/parks.js'));
});
after(() => fakes.close());
beforeEach(() => {
  history.fetched = {};
  history.episodes = {};
  fakes.upstream.historyCalls.length = 0;
});

// One ride, one 20-minute breakdown that afternoon.
const dayWithOutage = (date) => ({
  status: 200,
  body: {
    entities: [{
      id: 'r1', name: 'Ride 1', entityType: 'ATTRACTION',
      opening: { time: `${date}T04:00:00Z`, status: 'CLOSED' },
      history: [
        { time: `${date}T13:00:00Z`, status: 'OPERATING' },
        { time: `${date}T18:00:00Z`, status: 'DOWN' },
        { time: `${date}T18:20:00Z`, status: 'OPERATING' },
      ],
    }],
  },
});

test('backfills each park’s settled days once, and never refetches them', async () => {
  fakes.upstream.history = (_park, date) => dayWithOutage(date);
  await syncHistory(NOW);
  for (const park of PARKS) {
    assert.equal(history.fetched[park.id].length, 7, park.name);
    assert.equal(history.episodes[park.id].length, 7);
    assert.equal(history.episodes[park.id][0].minutes, 20);
  }
  const calls = fakes.upstream.historyCalls.length;
  await syncHistory(NOW);
  assert.equal(fakes.upstream.historyCalls.length, calls, 'nothing new to fetch');
});

test('a spent hourly budget stops the sync at once, and nothing is marked fetched', async () => {
  fakes.upstream.history = () => ({ status: 429, body: {} });
  await syncHistory(NOW);
  assert.equal(fakes.upstream.historyCalls.length, 1);
  assert.deepEqual(Object.values(history.fetched).flat(), []);
});

test('stops before the budget runs dry, leaving some for anyone sharing the IP', async () => {
  let left = 5;
  fakes.upstream.history = (_park, date) => ({ ...dayWithOutage(date), remaining: --left });
  await syncHistory(NOW);
  assert.equal(fakes.upstream.historyCalls.length, 3); // remaining 4, 3, then 2: stop
});

test('days older than the key allows end that park’s backfill; other parks go on', async () => {
  const oldest = '2026-09-25';
  fakes.upstream.history = (_park, date) =>
    date < oldest
      ? { status: 400, body: { error: { type: 'HISTORY_WINDOW_EXCEEDED', message: 'too old' } } }
      : dayWithOutage(date);
  await syncHistory(NOW);
  for (const park of PARKS) assert.deepEqual(history.fetched[park.id], ['2026-09-27', '2026-09-26', '2026-09-25']);
  assert.equal(fakes.upstream.historyCalls.length, PARKS.length * 4); // three days, then one refusal
});

test('a day that fails for another reason is retried on the next sync', async () => {
  fakes.upstream.history = (_park, date) => (date === '2026-09-26' ? { status: 500, body: {} } : dayWithOutage(date));
  await syncHistory(NOW);
  assert.ok(!history.fetched[PARKS[0].id].includes('2026-09-26'));
  fakes.upstream.history = (_park, date) => dayWithOutage(date);
  fakes.upstream.historyCalls.length = 0;
  await syncHistory(NOW);
  assert.deepEqual(fakes.upstream.historyCalls.map((c) => c.date), Array(PARKS.length).fill('2026-09-26'));
});

test('outages older than a year are pruned', async () => {
  const park = PARKS[0].id;
  history.episodes[park] = [{ rideId: 'old', start: NOW - 400 * DAY, minutes: 10, kind: 'breakdown', endedAs: 'OPERATING' }];
  history.fetched[park] = ['2025-08-01'];
  fakes.upstream.history = (_p, date) => dayWithOutage(date);
  await syncHistory(NOW);
  assert.ok(!history.episodes[park].some((ep) => ep.rideId === 'old'));
  assert.ok(!history.fetched[park].includes('2025-08-01'));
});
