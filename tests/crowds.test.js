import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hourlyAverages, extractWaitProfile, profileFromSamples, headliners, typicalByHour, bestTimes, linesBuilding,
  rideTypicals, usualIndex, crowdRatio, crowdLabel, smoothedCrowd, settleLabel, minPosting,
} from '../server/crowds.js';

const H = 3600_000, M = 60_000;
const day0 = Date.parse('2026-09-21T04:00:00Z'); // park-local midnight in Orlando

test('hourly averages are time-weighted and skip hours with under 10 minutes of data', () => {
  const hours = hourlyAverages([
    { t: day0 + 9 * H, running: true, wait: 10 },
    { t: day0 + 9 * H + 30 * M, running: true, wait: 30 },
    { t: day0 + 10 * H + 55 * M, running: false, wait: null },
    { t: day0 + 11 * H, running: true, wait: 40 },
    { t: day0 + 11 * H + 5 * M, running: false, wait: null },
  ], day0);
  assert.equal(hours[9], 20); // half an hour at 10, half at 30
  assert.equal(hours[10], 30); // 55 minutes at 30, then down
  assert.equal(hours[11], null); // only 5 minutes posting
  assert.equal(hours[8], null);
});

test('a day of history becomes a profile per ride, carrying each row forward', () => {
  const at = (h, m = 0) => new Date(day0 + h * H + m * M).toISOString();
  const envelope = {
    entities: [{
      id: 'sm', entityType: 'ATTRACTION', opening: { time: new Date(day0).toISOString(), status: 'CLOSED' },
      history: [
        { time: at(9), status: 'OPERATING', queue: { STANDBY: { waitTime: 20 } } },
        { time: at(10), status: 'OPERATING', queue: { STANDBY: { waitTime: 60 } } },
        { time: at(11), status: 'CLOSED', queue: { STANDBY: { waitTime: null } } },
      ],
    }, { id: 'show', entityType: 'SHOW', opening: { time: new Date(day0).toISOString() }, history: [] }],
  };
  const p = extractWaitProfile(envelope);
  assert.deepEqual(Object.keys(p), ['sm']);
  assert.equal(p.sm[9], 20);
  assert.equal(p.sm[10], 60);
  assert.equal(p.sm[11], null);
});

test("today's live samples hold only until now, not until midnight", () => {
  const hours = profileFromSamples([[day0 + 9 * H, 30]], day0, day0 + 9 * H + 30 * M);
  assert.equal(hours[9], 30);
  assert.equal(hours[10], null);
});

const flat = (v) => Array(24).fill(null).map((_, h) => (h >= 9 && h <= 21 ? v : null));

test('headliners are the rides with the longest typical waits', () => {
  const day = { big: flat(60), mid: flat(30), small: flat(5), other: flat(45) };
  const ids = headliners({ d1: day, d2: day, d3: day }, 2);
  assert.deepEqual(ids, ['big', 'other']);
});

test("each headliner is read against its own usual, so closed rides don't read as quiet", () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const day = { a: flat(90), b: flat(60), c: flat(60), d: flat(40), e: flat(30), f: flat(20) };
  const typicals = rideTypicals({ d1: day, d2: day, d3: day });
  assert.equal(typicals.a[12], 90);
  assert.equal(usualIndex(ids, typicals)[12], 50);
  const usual = { a: 90, b: 60, c: 60, d: 40, e: 30, f: 20 };
  assert.equal(crowdRatio(usual, ids, typicals, 12), 1);
  // The two biggest rides close in a storm: the rest are still at their usual.
  assert.equal(crowdRatio({ ...usual, a: null, b: null }, ids, typicals, 12), 1);
  // Everything at 1.5 times its usual.
  assert.equal(crowdRatio(Object.fromEntries(ids.map((id) => [id, usual[id] * 1.5])), ids, typicals, 12), 1.5);
  // Half of the headliners, at least three, must be posting.
  assert.equal(minPosting(10), 5);
  assert.equal(minPosting(4), 3);
  assert.equal(crowdRatio({ a: 90, b: 60 }, ids, typicals, 12), null);
  assert.equal(crowdRatio(usual, ids, typicals, 3), null, 'an hour with no usual');
});

test('the words come from how far over or under usual the waits are', () => {
  assert.equal(crowdLabel(0.7), 'Quieter than usual');
  assert.equal(crowdLabel(1), 'About usual');
  assert.equal(crowdLabel(1.14), 'About usual');
  assert.equal(crowdLabel(1.2), 'Busier than usual');
  assert.equal(crowdLabel(1.6), 'Much busier than usual');
});

test('readings are averaged over 15 minutes, and the label moves only when two agree', () => {
  const now = 100 * M;
  const samples = [[80 * M, 2, 50], [90 * M, 1, 50], [95 * M, 1.2, 50], [100 * M, 1.1, 50]];
  const c = smoothedCrowd(samples, now);
  assert.ok(Math.abs(c.ratio - 1.1) < 1e-9, 'the reading from 20 minutes ago is out');
  assert.equal(c.index, 55);
  assert.equal(smoothedCrowd(samples, 60 * M), null);
  let shown = settleLabel(null, 'About usual');
  assert.deepEqual(shown, { label: 'About usual', next: null });
  shown = settleLabel(shown, 'Busier than usual');
  assert.equal(shown.label, 'About usual', 'one reading is not enough');
  shown = settleLabel(shown, 'About usual');
  assert.deepEqual(shown, { label: 'About usual', next: null });
  shown = settleLabel(settleLabel(shown, 'Busier than usual'), 'Busier than usual');
  assert.equal(shown.label, 'Busier than usual');
});

test('best times come from the median wait for each hour across days', () => {
  const d = (morning, afternoon) => ({ r: Array(24).fill(null).map((_, h) => (h < 9 ? null : h < 12 ? morning : afternoon)) });
  const bt = bestTimes({ a: d(15, 60), b: d(20, 70), c: d(10, 50) }, 'r');
  assert.equal(bt.best.wait, 15);
  assert.equal(bt.best.hour, 9);
  assert.equal(bt.worst.wait, 60);
  assert.equal(bt.days, 3);
  assert.equal(bestTimes({ a: d(15, 60) }, 'r'), null, 'one day is not a pattern');
  assert.deepEqual(typicalByHour([[1], [2]]).slice(0, 1), [null]);
});

test('lines are building only when waits outpace a usual day, and only when busier than usual', () => {
  const now = 100 * M;
  const at = (min, ratio, usual = 50) => [min * M, ratio, usual];
  // From usual to 1.4 times usual in half an hour.
  const rising = [at(60, 1), at(65, 1), at(70, 1), at(85, 1.3), at(95, 1.4), at(100, 1.4)];
  // The reading at 85 is just outside the 15 minutes up to now.
  assert.deepEqual(linesBuilding(rising, now), { from: 50, to: 70, ratio: 1.4 });
  // Waits rising the way they do every morning: the ratio stays put.
  const morning = [at(60, 1, 30), at(70, 1, 35), at(95, 1, 55), at(100, 1, 60)];
  assert.equal(linesBuilding(morning, now), null, 'an ordinary ramp');
  assert.equal(linesBuilding([at(60, 0.6), at(100, 0.95)], now), null, 'not busier than usual');
  assert.equal(linesBuilding([at(60, 1.2, 20), at(100, 1.45, 20)], now), null, 'under 10 minutes more');
  assert.equal(linesBuilding([at(90, 1), at(100, 1.6)], now), null, 'no reading from half an hour ago');
});
