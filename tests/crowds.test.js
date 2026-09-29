import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hourlyAverages, extractWaitProfile, profileFromSamples, headliners, crowdIndex, hourlyIndex,
  crowdLevel, typicalByHour, bestTimes, linesBuilding,
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

test('the crowd index needs at least three headliners posting', () => {
  assert.equal(crowdIndex({ a: 30, b: 40, c: 50, d: null }, ['a', 'b', 'c', 'd']), 40);
  assert.equal(crowdIndex({ a: 30, b: 40 }, ['a', 'b', 'c']), null);
  const idx = hourlyIndex({ a: flat(30), b: flat(40), c: flat(50) }, ['a', 'b', 'c']);
  assert.equal(idx[12], 40);
  assert.equal(idx[3], null);
});

test('the crowd level ranks now against the same hour on past days', () => {
  const past = [20, 30, 40, 50, 60];
  assert.equal(crowdLevel(65, past).level, 10);
  assert.equal(crowdLevel(15, past).level, 1);
  const mid = crowdLevel(40, past);
  assert.equal(mid.level, 6); // the middle of 1 to 10
  assert.equal(mid.label, 'About usual');
  assert.equal(mid.typical, 40);
  assert.equal(crowdLevel(40, [30, 50]), null, 'too few days to compare');
  assert.equal(crowdLevel(null, past), null);
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

test('lines are building only on a real rise, and only when busier than usual', () => {
  const now = 100 * M;
  const rising = [[60 * M, 30], [80 * M, 38], [100 * M, 45]];
  assert.deepEqual(linesBuilding(rising, now, { level: 8 }), { from: 30, to: 45 });
  assert.equal(linesBuilding(rising, now, { level: 5 }), null, 'not busy');
  assert.equal(linesBuilding([[60 * M, 40], [100 * M, 48]], now, { level: 9 }), null, 'rise too small');
  assert.equal(linesBuilding([[90 * M, 20], [100 * M, 60]], now, { level: 9 }), null, 'no reading from half an hour ago');
});
