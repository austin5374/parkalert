import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../server/themeparks.js';
import { groupMessage, recordRecent, GROUP_MIN } from '../server/poller.js';
import { isTripActive, TRIP_IDLE_MS } from '../server/store.js';

// Magic Kingdom on 2026-09-27 as the API returned it: early entry, a 6pm
// regular close, then Mickey's Not-So-Scary Halloween Party until midnight.
const PARTY_NIGHT = {
  timezone: 'America/New_York',
  schedule: [
    { date: '2026-09-27', type: 'TICKETED_EVENT', description: 'Early Entry', openingTime: '2026-09-27T08:30:00-04:00', closingTime: '2026-09-27T09:00:00-04:00' },
    { date: '2026-09-27', type: 'OPERATING', openingTime: '2026-09-27T09:00:00-04:00', closingTime: '2026-09-27T18:00:00-04:00' },
    { date: '2026-09-27', type: 'TICKETED_EVENT', description: 'Special Ticketed Event', openingTime: '2026-09-27T19:00:00-04:00', closingTime: '2026-09-28T00:00:00-04:00' },
    { date: '2026-09-28', type: 'OPERATING', openingTime: '2026-09-28T09:00:00-04:00', closingTime: '2026-09-28T22:00:00-04:00' },
  ],
};
const noonSept27 = Date.parse('2026-09-27T16:00:00Z');

test('a party night keeps alerts on until the party ends, not the 6pm close', () => {
  const s = parseSchedule(PARTY_NIGHT, noonSept27);
  assert.equal(s.closingTime, '2026-09-27T18:00:00-04:00');
  assert.equal(s.lastCloseTime, '2026-09-28T00:00:00-04:00');
  assert.deepEqual(s.lateEvent, { name: 'Special Ticketed Event', closingTime: '2026-09-28T00:00:00-04:00' });
});

test('an ordinary day has no late event, and early entry never extends the day', () => {
  const s = parseSchedule(PARTY_NIGHT, Date.parse('2026-09-28T16:00:00Z'));
  assert.equal(s.lastCloseTime, '2026-09-28T22:00:00-04:00');
  assert.equal(s.lateEvent, null);
});

test('a day with no schedule leaves every time null', () => {
  const s = parseSchedule({ timezone: 'America/New_York', schedule: [] }, noonSept27);
  assert.equal(s.closingTime, null);
  assert.equal(s.lastCloseTime, null);
});

test('many rides at once become one push that names them', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const down = groupMessage('DOWN', names, 'Magic Kingdom', { kind: 'hold', text: 'Usually back in 45 to 105 min' });
  assert.equal(down.title, '7 rides just went down');
  assert.equal(down.message, 'A, B, C, D, E and 2 more\nPark-wide hold at Magic Kingdom\nUsually back in 45 to 105 min');
  const up = groupMessage('UP', names.slice(0, GROUP_MIN), 'EPCOT', null);
  assert.equal(up.title, '3 rides are back up');
  assert.equal(up.message, 'A, B, C\nEPCOT');
});

test('recent transitions keep the newest first and drop anything older than a park day', () => {
  const t = 30 * 3600_000;
  const old = [{ type: 'DOWN', id: 'x', name: 'X', at: t - 19 * 3600_000 }];
  const ev = { type: 'UP', ride: { id: 'a', name: 'A' }, downtimeMs: 60_000 };
  const r = recordRecent(old, [ev], t);
  assert.deepEqual(r, [{ type: 'UP', id: 'a', name: 'A', at: t, downtimeMs: 60_000 }]);
});

test('a trip untouched for three weeks stops being polled until it is opened again', () => {
  const now = Date.now();
  assert.equal(isTripActive({ createdAt: now - TRIP_IDLE_MS - 1 }, now), false);
  assert.equal(isTripActive({ createdAt: now - TRIP_IDLE_MS - 1, lastSeenAt: now - 1000 }, now), true);
  assert.equal(isTripActive({ createdAt: now - 1000 }, now), true);
});

test('a day that is only a ticketed event reports the event, and alerts run until it ends', () => {
  const s = parseSchedule({
    timezone: 'America/New_York',
    schedule: [{ date: '2026-09-27', type: 'TICKETED_EVENT', description: 'After Hours', openingTime: '2026-09-27T19:00:00-04:00', closingTime: '2026-09-27T23:00:00-04:00' }],
  }, noonSept27);
  assert.equal(s.closingTime, null);
  assert.equal(s.lastCloseTime, '2026-09-27T23:00:00-04:00');
  assert.deepEqual(s.lateEvent, { name: 'After Hours', closingTime: '2026-09-27T23:00:00-04:00' });
});

test('several late openings at once are one "now open" push', () => {
  assert.equal(groupMessage('UP', ['A', 'B', 'C'], 'EPCOT', null, { late: true }).title, '3 rides are now open');
});
