import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordWaits, outageDays, rideHistory, rideToday, parkSummary, outagesToday, WAIT_KEEP_MS } from '../server/insights.js';
import { parkDayStart } from '../server/time.js';

test('wait samples are recorded only when the value changes, and down means no wait', () => {
  let w = recordWaits({}, { a: { status: 'OPERATING', waitTime: 30 } }, 1000);
  w = recordWaits(w, { a: { status: 'OPERATING', waitTime: 30 } }, 2000);
  w = recordWaits(w, { a: { status: 'DOWN', waitTime: 30 } }, 3000);
  w = recordWaits(w, { a: { status: 'OPERATING', waitTime: 45 } }, 4000);
  assert.deepEqual(w.a, [[1000, 30], [3000, null], [4000, 45]]);
});

test('old wait samples age out', () => {
  const w = recordWaits({ a: [[0, 10]] }, { a: { status: 'OPERATING', waitTime: 20 } }, WAIT_KEEP_MS + 1);
  assert.deepEqual(w.a, [[WAIT_KEEP_MS + 1, 20]]);
});

const ep = (date, minutes, extra = {}) => ({ rideId: 'a', date, minutes, kind: 'breakdown', endedAs: 'OPERATING', start: Date.parse(`${date}T15:00:00Z`), ...extra });

test('archived days with no outage show as zero rather than disappearing', () => {
  const days = outageDays([ep('2026-09-21', 10), ep('2026-09-21', 5.4), ep('2026-09-23', 30)], 'a', ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.deepEqual(days, [
    { date: '2026-09-21', outages: 2, minutes: 15 },
    { date: '2026-09-22', outages: 0, minutes: 0 },
    { date: '2026-09-23', outages: 1, minutes: 30 },
  ]);
});

test('ride history ignores blips and other rides, and reports typical and longest', () => {
  const eps = [
    ep('2026-09-21', 10), ep('2026-09-22', 20), ep('2026-09-23', 90, { endedAs: 'CLOSED' }),
    ep('2026-09-23', 0.5, { kind: 'blip' }), ep('2026-09-23', 99, { rideId: 'b' }),
  ];
  const h = rideHistory(eps, 'a', ['2026-09-21', '2026-09-22', '2026-09-23']);
  assert.equal(h.outages, 3);
  assert.equal(h.typicalMinutes, 15); // median of the two that reopened
  assert.equal(h.longestMinutes, 20); // the 90 never reopened: not a length
  assert.equal(h.last[0].reopened, false);
  assert.equal(h.archivedDays, 3);
});

test("today's list keeps only this ride since the park's midnight, oldest first", () => {
  const recent = [
    { type: 'UP', id: 'a', at: 300, downtimeMs: 100 },
    { type: 'DOWN', id: 'b', at: 250 },
    { type: 'DOWN', id: 'a', at: 200 },
    { type: 'DOWN', id: 'a', at: 50 },
  ];
  assert.deepEqual(rideToday(recent, 'a', 100).map((e) => e.at), [200, 300]);
});

test('park summary ranks the least reliable rides over the last week of archive', () => {
  const eps = [ep('2026-09-22', 10), ep('2026-09-22', 10), ep('2026-09-22', 40, { rideId: 'b' }), ep('2026-09-22', 60, { rideId: 'c', kind: 'hold' })];
  const s = parkSummary(eps, ['2026-09-22'], { a: 'Ride A' });
  assert.deepEqual(s.leastReliable.map((r) => r.id), ['a', 'c', 'b']);
  assert.equal(s.leastReliable[0].name, 'Ride A');
  assert.equal(s.typicalBreakdownMinutes, 10);
  assert.equal(s.holdDays, 1);
});

test("the park's day starts at local midnight", () => {
  const now = Date.parse('2026-09-27T19:30:15.500Z'); // 3:30:15 PM in Orlando
  assert.equal(new Date(parkDayStart('America/New_York', now)).toISOString(), '2026-09-27T04:00:00.000Z');
  assert.equal(new Date(parkDayStart('America/Los_Angeles', now)).toISOString(), '2026-09-27T07:00:00.000Z');
});

test('after a gap in polling, the wait chart breaks instead of holding the old wait', () => {
  const w = recordWaits({ a: [[1000, 30]] }, { a: { status: 'OPERATING', waitTime: 30 } }, 9000, 2000);
  assert.deepEqual(w.a, [[1000, 30], [2000, null], [9000, 30]]);
});

test("on daylight-saving days the park's day still starts at midnight", () => {
  // Nov 1 2026: clocks go back at 2am. 3pm EST is 16 hours after midnight EDT.
  assert.equal(new Date(parkDayStart('America/New_York', Date.parse('2026-11-01T20:00:00Z'))).toISOString(), '2026-11-01T04:00:00.000Z');
  // Mar 8 2026: clocks go forward at 2am. 3pm EDT is 14 hours after midnight EST.
  assert.equal(new Date(parkDayStart('America/New_York', Date.parse('2026-03-08T19:00:00Z'))).toISOString(), '2026-03-08T05:00:00.000Z');
});

test('"last 7 days" figures come from those 7 days only', () => {
  const dates = ['2026-08-01', ...Array.from({ length: 7 }, (_, i) => `2026-09-2${i}`)];
  const h = rideHistory([ep('2026-08-01', 180), ep('2026-09-21', 10), ep('2026-09-24', 20)], 'a', dates);
  assert.equal(h.outages, 2);
  assert.equal(h.longestMinutes, 20);
  assert.equal(h.typicalMinutes, 15);
  assert.equal(h.archivedDays, 8);
});

test('a wait trend compares now with half an hour ago and ignores small moves', async () => {
  const { waitTrend } = await import('../server/insights.js');
  const m = 60_000, now = 100 * m;
  assert.deepEqual(waitTrend([[40 * m, 20], [65 * m, 30], [90 * m, 45]], now), { direction: 'up', change: 15 });
  assert.deepEqual(waitTrend([[40 * m, 60], [90 * m, 40]], now), { direction: 'down', change: -20 });
  assert.equal(waitTrend([[40 * m, 30], [90 * m, 35]], now), null, 'one 5-minute step is steady');
  assert.equal(waitTrend([[80 * m, 20], [90 * m, 45]], now), null, 'no reading from 30 min ago');
  assert.equal(waitTrend([[40 * m, 20], [90 * m, null]], now), null, 'not posting a wait now');
  assert.equal(waitTrend([[40 * m, null], [90 * m, 30]], now), null, 'was down 30 min ago');
  // Relative as well: a long line wobbling isn't a trend; a short one growing by half is.
  assert.equal(waitTrend([[40 * m, 110], [90 * m, 120]], now), null, '110 to 120 is a wobble');
  assert.deepEqual(waitTrend([[40 * m, 20], [90 * m, 30]], now), { direction: 'up', change: 10 });
  assert.deepEqual(waitTrend([[40 * m, 120], [90 * m, 150]], now), { direction: 'up', change: 30 });
});

test('typical and longest on the ride page are breakdowns, not storm holds', () => {
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23'];
  const h = rideHistory([ep('2026-09-21', 16), ep('2026-09-22', 70, { kind: 'hold' }), ep('2026-09-23', 75, { kind: 'hold' })], 'a', dates);
  assert.equal(h.outages, 3);
  assert.equal(h.holds, 2);
  assert.equal(h.typicalMinutes, 16);
  assert.equal(h.longestMinutes, 16);
});

test("outages today include rides down since before ParkAlert saw them go down", () => {
  const dayStart = Date.parse('2026-09-29T04:00:00Z');
  const at = (h) => dayStart + h * 3600_000;
  const recent = [
    { type: 'DOWN', id: 'a', at: at(10) },
    { type: 'UP', id: 'a', at: at(10.5) },
    { type: 'DOWN', id: 'b', at: at(11) },
    { type: 'DOWN', id: 'old', at: dayStart - 3600_000 },
  ];
  const rides = {
    b: { status: 'DOWN', downSince: at(11) }, // seen going down: counted once
    p: { status: 'DOWN', downSince: at(2.9) }, // down since 2:53 AM, never seen starting
    y: { status: 'DOWN', downSince: dayStart - 5 * 3600_000 }, // began yesterday
    c: { status: 'OPERATING' },
  };
  assert.deepEqual(outagesToday(recent, rides, dayStart), { downs: 3, rides: 3 });
});
