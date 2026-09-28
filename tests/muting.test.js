import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTripMuted, currentSchedule } from '../server/poller.js';

const NY = 'America/New_York';
const trip = (extra = {}) => ({ watched: null, mute: null, rideMutes: {}, ...extra });
// 2026-09-27, 3pm in Orlando; the park closes at 10pm.
const now = Date.parse('2026-09-27T19:00:00Z');
const today = { date: '2026-09-27', closingTime: '2026-09-27T22:00:00-04:00', lastCloseTime: '2026-09-27T22:00:00-04:00' };
const state = (schedule) => ({ timezone: NY, schedule });

test('a followed ride on an open park is not muted', () => {
  assert.equal(isTripMuted(trip(), 'a', state(today), now), false);
});

test('alerts stop after the last close of the day', () => {
  assert.equal(isTripMuted(trip(), 'a', state(today), Date.parse('2026-09-28T02:30:00Z')), true);
});

test("yesterday's hours never mute today's alerts", () => {
  // Today's schedule fetch failed, so only yesterday's is in state.
  const yesterday = { date: '2026-09-26', closingTime: '2026-09-26T22:00:00-04:00', lastCloseTime: '2026-09-26T22:00:00-04:00' };
  assert.equal(currentSchedule(state(yesterday), now), null);
  assert.equal(isTripMuted(trip(), 'a', state(yesterday), now), false);
});

test('no schedule at all means no auto-mute', () => {
  assert.equal(isTripMuted(trip(), 'a', state(null), now), false);
});

test('the park day is local: 11pm in California is still the same day there', () => {
  const la = { date: '2026-09-27', closingTime: '2026-09-28T00:00:00-07:00' };
  const at11pm = Date.parse('2026-09-28T06:00:00Z'); // already the 28th in UTC and in Orlando
  assert.deepEqual(currentSchedule({ timezone: 'America/Los_Angeles', schedule: la }, at11pm), la);
});

test('pause, per-ride mute and the follow list each mute', () => {
  assert.equal(isTripMuted(trip({ mute: { until: now + 60_000 } }), 'a', state(today), now), true);
  assert.equal(isTripMuted(trip({ mute: { until: now - 1 } }), 'a', state(today), now), false);
  assert.equal(isTripMuted(trip({ mute: { until: null } }), 'a', state(today), now), true);
  assert.equal(isTripMuted(trip({ rideMutes: { a: true } }), 'a', state(today), now), true);
  assert.equal(isTripMuted(trip({ watched: ['b'] }), 'a', state(today), now), true);
  assert.equal(isTripMuted(trip({ watched: ['a'] }), 'a', state(today), now), false);
});
