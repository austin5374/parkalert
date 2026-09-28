import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordWaits, outageDays, rideHistory, rideToday, parkSummary, WAIT_KEEP_MS } from '../server/insights.js';
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
  assert.equal(h.longestMinutes, 90);
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
