import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTripMuted, currentSchedule, closingIsNews } from '../server/poller.js';

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

test('a down ride closing is news mid-day, not before opening or around closing', () => {
  const day = { date: '2026-09-27', openingTime: '2026-09-27T09:00:00-04:00', closingTime: '2026-09-27T18:00:00-04:00', lastCloseTime: '2026-09-28T00:00:00-04:00' };
  const at = (iso) => Date.parse(iso);
  assert.equal(closingIsNews(state(day), at('2026-09-27T15:00:00-04:00')), true);
  assert.equal(closingIsNews(state(day), at('2026-09-27T08:30:00-04:00')), false, 'before opening');
  assert.equal(closingIsNews(state(day), at('2026-09-27T17:50:00-04:00')), false, 'regular close');
  assert.equal(closingIsNews(state(day), at('2026-09-27T21:00:00-04:00')), true, 'during the party');
  assert.equal(closingIsNews(state(day), at('2026-09-27T23:45:00-04:00')), false, 'party ending');
  assert.equal(closingIsNews(state(null), at('2026-09-27T15:00:00-04:00')), true, 'unknown hours');
});

test("today's hours are checked again during the day, and more often near close", async () => {
  const { scheduleIsFresh } = await import('../server/poller.js');
  const now = Date.parse('2026-09-28T18:00:00Z'); // 2pm in Orlando
  const base = { date: '2026-09-28', closingTime: '2026-09-28T22:00:00-04:00', lastCloseTime: '2026-09-28T22:00:00-04:00' };
  const st = (extra) => ({ timezone: 'America/New_York', schedule: { ...base, ...extra } });
  assert.equal(scheduleIsFresh(st({ fetchedAt: now - 10 * 60_000 }), now), true);
  assert.equal(scheduleIsFresh(st({ fetchedAt: now - 61 * 60_000 }), now), false);
  assert.equal(scheduleIsFresh(st({}), now), false); // saved before fetchedAt existed
  const nearClose = Date.parse('2026-09-29T01:40:00Z'); // 9:40pm, 20 min before close
  assert.equal(scheduleIsFresh(st({ fetchedAt: nearClose - 20 * 60_000 }), nearClose), false);
  assert.equal(scheduleIsFresh(st({ fetchedAt: nearClose - 5 * 60_000 }), nearClose), true);
});

// Forty rides at 3pm with a 10pm close, running or closed as asked.
const withRides = (schedule, { operating = 0, closed = 0, down = 0 } = {}) => {
  const rides = {};
  let i = 0;
  for (const [status, n] of [['OPERATING', operating], ['CLOSED', closed], ['DOWN', down]]) for (let k = 0; k < n; k++) rides[`r${i++}`] = { name: 'R', status };
  return { timezone: NY, schedule, rides };
};

test('past the posted close, rides still running keep alerts on', async () => {
  const { parkStatus } = await import('../server/parkstatus.js');
  const late = Date.parse('2026-09-28T02:30:00Z'); // 10:30pm, half an hour past close
  const running = withRides(today, { operating: 30, closed: 10 });
  assert.equal(parkStatus(running, late), 'openLate');
  assert.equal(isTripMuted(trip(), 'a', running, late), false);
  const emptying = withRides(today, { operating: 5, closed: 35 });
  assert.equal(parkStatus(emptying, late), 'closed');
  assert.equal(isTripMuted(trip(), 'a', emptying, late), true);
});

test('within its hours, a park whose rides have nearly all closed is closed', async () => {
  const { parkStatus } = await import('../server/parkstatus.js');
  const day = { ...today, openingTime: '2026-09-27T09:00:00-04:00' };
  const shut = withRides(day, { operating: 1, closed: 39 });
  assert.equal(parkStatus(shut, now), 'closedEarly');
  assert.equal(isTripMuted(trip(), 'a', shut, now), true);
  assert.equal(closingIsNews(shut, now), false, 'every ride closing at once is not forty pushes');
  // A storm hold is not a closing: down rides are still in service.
  const storm = withRides(day, { operating: 2, down: 20, closed: 18 });
  assert.equal(parkStatus(storm, now), 'open');
  assert.equal(isTripMuted(trip(), 'a', storm, now), false);
});

test('while hours and rides disagree, the hours are read again every few minutes', async () => {
  const { scheduleIsFresh, SCHEDULE_TTL_DISAGREE_MS } = await import('../server/poller.js');
  const late = Date.parse('2026-09-28T02:30:00Z');
  const st = (fetchedAgo) => withRides({ ...today, fetchedAt: late - fetchedAgo }, { operating: 30, closed: 10 });
  assert.equal(scheduleIsFresh(st(SCHEDULE_TTL_DISAGREE_MS - 1000), late), true);
  assert.equal(scheduleIsFresh(st(SCHEDULE_TTL_DISAGREE_MS + 1000), late), false);
});
