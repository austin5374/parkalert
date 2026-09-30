import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../server/themeparks.js';
import { recordRecent, GROUP_MIN } from '../server/poller.js';
import { groupMessage, groupOutlook, incidentDownMessage, incidentUpMessage, upMessage, downMessage, goneMessage } from '../server/messages.js';
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

test('a hold is one push that leads with the hold, the range and what to do', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const at = Date.parse('2026-09-27T19:12:00Z');
  const outlook = { kind: 'hold', text: 'Often back in 45 to 105 min', advice: { verdict: 'Ride something else' } };
  const down = incidentDownMessage('hold', names, 'Magic Kingdom', outlook, at, 'America/New_York');
  assert.equal(down.title, '7 rides down together', 'not a storm unless the weather says so');
  assert.equal(down.message, 'Often back in 45 to 105 min · Ride something else\nA, B, C, D, E and 2 more\nMagic Kingdom · 3:12\u00a0PM');
  assert.equal(incidentDownMessage('hold', names, 'Magic Kingdom', { ...outlook, cause: 'lightning' }, at, 'America/New_York').title, '7 rides stopped, likely lightning');
  const wave = incidentDownMessage('group', ['A', 'B', 'C'], 'EPCOT', null, at, 'America/New_York');
  assert.equal(wave.title, '3 rides went down');
  const up = groupMessage('UP', names.slice(0, GROUP_MIN), 'EPCOT');
  assert.equal(up.title, '3 rides are open again');
  assert.equal(up.message, 'A, B, C\nEPCOT');
});

test('an incident coming back is counted, quietly until the last ride', () => {
  const mid = incidentUpMessage({ names: ['A', 'B'], back: 6, total: 18, downtimes: [40, 42].map((m) => m * 60_000), final: false, parkName: 'Magic Kingdom' });
  assert.deepEqual([mid.title, mid.quiet], ['6 of 18 rides are open again', true]);
  assert.equal(mid.message, 'A, B\nDown about 42 min · Magic Kingdom');
  const last = incidentUpMessage({ names: ['C'], back: 18, total: 18, final: true, parkName: 'Magic Kingdom' });
  assert.deepEqual([last.title, last.quiet], ['All 18 rides are open again', false]);
  const someClosed = incidentUpMessage({ names: ['C'], back: 16, total: 18, closed: ['X', 'Y'], final: true, parkName: 'Magic Kingdom' });
  assert.equal(someClosed.title, '16 of 18 rides are open again');
  assert.match(someClosed.message, /Closed for now: X, Y$/);
});

test('a ride back after an hour or more says so in the title', () => {
  const ev = { type: 'UP', ride: { name: "Peter Pan's Flight", downSince: Date.parse('2026-09-27T12:52:00Z') }, downtimeMs: 320 * 60_000 };
  const m = upMessage(ev, 'Magic Kingdom', 'America/New_York');
  assert.equal(m.title, "Peter Pan's Flight is open again after 5 hr 20 min");
  assert.equal(m.message, 'Down since 8:52\u00a0AM · Magic Kingdom');
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
  assert.equal(groupMessage('UP', ['A', 'B', 'C'], 'EPCOT', { late: true }).title, '3 rides are now open');
});

test('a grouped push speaks for the kind of outage most of its rides share', () => {
  const hold = { kind: 'hold', text: 'Often back in 45 to 105 min' };
  const breakdown = { kind: 'breakdown', text: 'Often back in 10 to 30 min' };
  assert.equal(groupOutlook([breakdown, hold, hold, hold]), hold);
  assert.equal(groupOutlook([hold, breakdown, breakdown]), breakdown);
  assert.equal(groupOutlook([hold, breakdown, { kind: 'opening' }]), null);
});

test('rides closing together are one push', () => {
  const m = groupMessage('CLOSED', ['A', 'B', 'C'], 'EPCOT');
  assert.equal(m.title, '3 rides have closed');
  assert.equal(m.message, 'A, B, C\nThey may not reopen today · EPCOT');
});

test('a grouped "back up" says how long the rides were down, like a single one', () => {
  const m = (ms, opts = {}) => groupMessage('UP', ['A', 'B', 'C'], 'EPCOT', { downtimes: ms, ...opts }).message;
  assert.equal(m([40, 42, 43].map((x) => x * 60_000)), 'A, B, C\nDown about 42 min · EPCOT');
  assert.equal(m([8, 30, 65].map((x) => x * 60_000)), 'A, B, C\nDown 8 min to 1 hr 5 min · EPCOT');
  assert.equal(m([null, null, null]), 'A, B, C\nEPCOT');
  // A late opening's time runs from when the ride was noticed down, not from
  // when it should have opened, so no "21 min late" is claimed.
  assert.equal(m([20, 21, 22].map((x) => x * 60_000), { late: true }), 'A, B, C\nEPCOT');
});

test('a push says what is known about when: exact, between two polls, or only "before"', () => {
  const tz = 'America/New_York';
  const at = Date.parse('2026-09-27T13:44:00Z');
  const ride = (extra) => ({ name: 'A', downSince: at, ...extra });
  assert.match(downMessage(ride({}), null, 'EPCOT', tz).message, /^Went down at 9:44\u00a0AM · EPCOT/);
  assert.match(downMessage(ride({ downExact: false, downAfter: at - 4 * 60_000 }), null, 'EPCOT', tz).message, /^Went down between 9:40\u00a0AM and 9:44\u00a0AM · EPCOT/);
  assert.match(downMessage(ride({ downExact: false }), null, 'EPCOT', tz).message, /^Down since before 9:44\u00a0AM · EPCOT/);
  const up = (downtimeRange) => upMessage({ type: 'UP', ride: ride({}), downtimeMs: 3 * 60_000, downtimeRange }, 'EPCOT', tz).message;
  assert.equal(up([60_000, 4 * 60_000]), 'Was down 1 min to 4 min · EPCOT');
  assert.equal(up([3 * 60_000, null]), 'Was down at least 3 min · EPCOT');
  assert.equal(goneMessage({ ride: ride({}) }, 'EPCOT', tz).title, 'A is no longer listed');
});
