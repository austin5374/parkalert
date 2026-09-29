import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordCalls, scoreCalls, scorecard } from '../server/scorecard.js';

const MIN = 60_000;
const T0 = Date.parse('2026-09-20T18:00:00Z');
const down = (id) => ({ type: 'DOWN', ride: { id } });
const up = (id, extra = {}) => ({ type: 'UP', ride: { id }, ...extra });

test('a breakdown is called when it goes down and scored when it reopens', () => {
  const rides = { a: { status: 'DOWN' } };
  const calls = recordCalls({}, [down('a')], rides, () => ({ kind: 'breakdown', window: { lo: 10, hi: 30 } }), T0);
  assert.equal(calls.a.length, 1);
  assert.equal(calls.a[0].stage, 'down');

  const r = scoreCalls(calls, [], [up('a')], T0 + 25 * MIN);
  assert.deepEqual(r.calls, {});
  assert.equal(r.scores.length, 1);
  assert.deepEqual({ ...r.scores[0], at: 0 }, { at: 0, stage: 'down', cause: null, hit: true, width: 20, miss: 5 });
});

test('a storm outage gets a second call once the weather clears, and only one', () => {
  let outlook = { kind: 'hold', cause: 'lightning', weather: 'ongoing', window: { lo: 50, hi: 60 } };
  const rides = { a: { status: 'DOWN' } };
  let calls = recordCalls({}, [down('a')], rides, () => outlook, T0);
  calls = recordCalls(calls, [], rides, () => outlook, T0 + 10 * MIN);
  assert.equal(calls.a.length, 1, 'no second call while the storm goes on');

  outlook = { ...outlook, weather: 'passed', window: { lo: 25, hi: 35 } };
  calls = recordCalls(calls, [], rides, () => outlook, T0 + 40 * MIN);
  calls = recordCalls(calls, [], rides, () => outlook, T0 + 41 * MIN);
  assert.deepEqual(calls.a.map((c) => c.stage), ['down', 'cleared']);

  // Reopens 30 min after clearing: inside the cleared range, not the first.
  const { scores } = scoreCalls(calls, [], [up('a')], T0 + 70 * MIN);
  const byStage = Object.fromEntries(scores.map((s) => [s.stage, s]));
  assert.equal(byStage.cleared.hit, true);
  assert.equal(byStage.cleared.miss, 0);
  assert.equal(byStage.down.hit, false);
  assert.equal(byStage.down.cause, 'lightning');
});

test('late openings, closings inside the range and calls without a range are not scored', () => {
  const rides = { a: { status: 'DOWN' }, b: { status: 'DOWN' }, c: { status: 'DOWN' } };
  const calls = recordCalls({}, [down('a'), down('b'), down('c')], rides,
    (id) => (id === 'c' ? { kind: 'breakdown', window: null } : { window: { lo: 5, hi: 15 } }), T0);
  assert.deepEqual(Object.keys(calls).sort(), ['a', 'b']);
  const r = scoreCalls(calls, [], [up('a', { late: true }), { type: 'CLOSED', ride: { id: 'b' } }], T0 + 10 * MIN);
  assert.deepEqual(r.scores, []);
  assert.deepEqual(r.calls, {});
});

test('calls whose ride never came back are forgotten, and old scores age out', () => {
  const rides = { a: { status: 'CLOSED' } };
  let calls = recordCalls({}, [down('a')], rides, () => ({ window: { lo: 5, hi: 15 } }), T0);
  calls = recordCalls(calls, [], rides, () => null, T0 + 13 * 3600_000);
  assert.deepEqual(calls, {});

  const old = [{ at: T0 - 15 * 24 * 3600_000, stage: 'down', cause: null, hit: true, width: 10, miss: 1 }];
  assert.deepEqual(scoreCalls({}, old, [], T0).scores, []);
});

test('the scorecard groups by kind of estimate', () => {
  const s = (stage, cause, hit, width, miss) => ({ at: T0, stage, cause, hit, width, miss });
  const card = scorecard([
    s('cleared', 'lightning', true, 10, 2),
    s('cleared', 'rain', false, 12, 9),
    s('down', 'lightning', false, 40, 20),
    s('down', null, true, 30, 6),
    s('down', null, false, 36, 18),
  ], T0);
  assert.equal(card.days, 14);
  // A share of one or two reopenings is noise: no "0% in range" after one.
  assert.deepEqual(card.groups.map((g) => [g.id, g.n, g.inRange, g.width, g.within15]), [
    ['cleared', 2, null, 11, 50],
    ['weather', 1, null, 40, 0],
    ['other', 2, null, 33, 50],
  ]);
  assert.deepEqual(scorecard([], T0).groups, []);
  const ten = scorecard(Array.from({ length: 10 }, (_, i) => s('down', null, i < 4, 30, 6)), T0);
  assert.equal(ten.groups[0].inRange, 40, 'ten reopenings are enough to say');
});

test('a ride that closes for the day after its range has passed counts as a miss', () => {
  const rides = { a: { status: 'DOWN' }, b: { status: 'DOWN' } };
  const calls = recordCalls({}, [down('a'), down('b')], rides, () => ({ window: { lo: 5, hi: 15 } }), T0);
  const r = scoreCalls(calls, [], [{ type: 'CLOSED', ride: { id: 'a' } }, up('b')], T0 + 40 * MIN);
  const a = r.scores.find((x) => x.closed);
  assert.equal(a.hit, false);
  assert.equal(a.miss, null);
  const card = scorecard(r.scores, T0 + 40 * MIN);
  assert.equal(card.groups[0].n, 2);
  assert.equal(card.groups[0].closed, 1);
});
