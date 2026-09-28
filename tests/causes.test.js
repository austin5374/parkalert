import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnTraits, causeOf, clearedAt, clearanceOffsets, spellDurations } from '../server/causes.js';
import { afterClearing, duringWeather, LIGHTNING_RULE } from '../server/predict.js';

const MIN = 60_000;
const H = 60 * MIN;
const day = (n) => Date.parse(`2026-09-${String(n).padStart(2, '0')}T00:00:00Z`);
const date = (n) => `2026-09-${String(n).padStart(2, '0')}`;

// Eight afternoon storms, 18:00 to 19:00 UTC, on the 1st to the 8th. Six
// outdoor rides close together at 17:55 (a hold) and reopen 30 to 40 min
// after each storm ends; the indoor ride breaks down once, mid-storm, for 12.
function stormArchive() {
  const thunder = [];
  const episodes = [];
  for (let d = 1; d <= 8; d++) {
    const s = day(d) + 18 * H;
    thunder.push({ start: s, end: s + H });
    for (let r = 0; r < 6; r++) {
      const start = s - 5 * MIN;
      const reopen = s + H + (30 + ((d * 3 + r * 2) % 11)) * MIN;
      episodes.push({ rideId: `out${r}`, rideName: `Outdoor ${r}`, start, minutes: (reopen - start) / MIN, endedAs: 'OPERATING', kind: 'hold', date: date(d) });
    }
  }
  episodes.push({ rideId: 'indoor', rideName: 'Indoor', start: day(3) + 18.5 * H, minutes: 12, endedAs: 'OPERATING', kind: 'breakdown', date: date(3) });
  return { episodes, tl: { thunder, rain: [], latest: day(9) } };
}

test('rides the storms shut on two or more days are learned as weather-exposed', () => {
  const { episodes, tl } = stormArchive();
  const traits = learnTraits(episodes, tl);
  assert.deepEqual([...traits.weather].sort(), ['out0', 'out1', 'out2', 'out3', 'out4', 'out5'], 'the indoor ride broke down in a storm only once');
  // One stormy day isn't enough to call a ride outdoor.
  assert.equal(learnTraits(episodes.filter((e) => e.date === date(1)), tl).weather.size, 0);
});

test('Test Track is rain-sensitive by name; others learn it from outages in rain alone', () => {
  const rain = [{ start: day(2) + 12 * H, end: day(2) + 13 * H }, { start: day(4) + 12 * H, end: day(4) + 13 * H }];
  const eps = [2, 4].map((d) => ({ rideId: 'x', rideName: 'Some Ride', start: day(d) + 12.2 * H, minutes: 50, endedAs: 'OPERATING', kind: 'breakdown', date: date(d) }));
  eps.push({ rideId: 'tt', rideName: 'Test Track presented by Chevrolet', start: day(5) + 9 * H, minutes: 10, endedAs: 'OPERATING', kind: 'breakdown' });
  const traits = learnTraits(eps, { thunder: [], rain, latest: day(9) });
  assert.deepEqual([...traits.rain].sort(), ['tt', 'x']);
});

test('the cause of an outage: lightning, rain, or not the weather', () => {
  const { episodes, tl } = stormArchive();
  const traits = learnTraits(episodes, tl);
  const storm = day(1) + 18.25 * H;
  assert.equal(causeOf({ rideId: 'out0', start: storm, kind: 'breakdown' }, traits, tl), 'lightning');
  assert.equal(causeOf({ rideId: 'new', start: storm, kind: 'hold' }, traits, tl), 'lightning', 'a hold in a storm');
  assert.equal(causeOf({ rideId: 'indoor', start: storm, kind: 'breakdown' }, traits, tl), null, 'indoor rides break down in storms too');
  assert.equal(causeOf({ rideId: 'out0', start: day(1) + 12 * H, kind: 'breakdown' }, traits, tl), null, 'no storm');
  assert.equal(causeOf({ rideId: 'out0', start: day(1) + 17.8 * H, kind: 'hold' }, traits, tl), 'lightning', 'closing as the storm arrives');
  const wet = { thunder: [], rain: [{ start: day(1), end: day(1) + H }], latest: day(2) };
  assert.equal(causeOf({ rideId: 'tt', rideName: 'Test Track', start: day(1) + 10 * MIN, kind: 'breakdown' }, { weather: new Set(), rain: new Set() }, wet), 'rain');
});

test('cleared: during a storm it is ongoing; after it, the end of the last storm since the ride went down', () => {
  const tl = { thunder: [{ start: 10 * H, end: 11 * H }, { start: 11.5 * H, end: 12 * H }], rain: [{ start: 10 * H, end: 12.5 * H }] };
  assert.deepEqual(clearedAt('lightning', 9.9 * H, 10.5 * H, tl), { state: 'ongoing', since: 10 * H, what: 'thunder' });
  assert.deepEqual(clearedAt('lightning', 9.9 * H, 13 * H, tl), { state: 'passed', end: 12 * H });
  // Rain-sensitive: waits for the rain too.
  assert.deepEqual(clearedAt('rain', 9.9 * H, 12.2 * H, tl).what, 'rain');
  assert.deepEqual(clearedAt('rain', 9.9 * H, 13 * H, tl), { state: 'passed', end: 12.5 * H });
});

test('offsets are measured from the all-clear, and they are tight when rides behave', () => {
  const { episodes, tl } = stormArchive();
  const traits = learnTraits(episodes, tl);
  const offsets = clearanceOffsets(episodes, traits, tl, 'lightning');
  assert.equal(offsets.length, 48);
  assert.ok(offsets.every((o) => o.minutes >= 30 && o.minutes <= 40));
  // Straight after the storm passes: a range about 10 minutes wide, not an hour.
  const est = afterClearing(offsets, 'out0', 0, 'lightning');
  assert.equal(est.basis, 'ride');
  assert.ok(est.p75 - est.p25 <= 15, `range ${est.p25}-${est.p75}`);
  assert.ok(est.p25 >= 30 && est.p75 <= 40);
  // 25 minutes after the all-clear, the range moves in.
  const later = afterClearing(offsets, 'out0', 25, 'lightning');
  assert.ok(later.p25 >= 5 && later.p75 <= 15, `later ${later.p25}-${later.p75}`);
});

test('with no storms in the archive yet, the 30-minute lightning rule stands in', () => {
  const est = afterClearing([], 'x', 0, 'lightning');
  assert.deepEqual([est.p25, est.p50, est.p75, est.basis], [LIGHTNING_RULE.p25, LIGHTNING_RULE.p50, LIGHTNING_RULE.p75, 'rule']);
  assert.equal(afterClearing([], 'x', 0, 'rain'), null, 'no rule of thumb for drying a track');
  assert.equal(afterClearing([], 'x', 60, 'lightning'), null, 'past the rule, nothing to say');
});

test('during a storm: how long storms here last, plus the time to reopen after', () => {
  const { episodes, tl } = stormArchive();
  const traits = learnTraits(episodes, tl);
  const offsets = clearanceOffsets(episodes, traits, tl, 'lightning');
  const est = duringWeather(spellDurations(tl.thunder), 20, offsets, 'out0', 'lightning');
  // Every storm lasted an hour, so 40 min are left, then 30 to 40 to reopen.
  assert.ok(est.p25 >= 65 && est.p75 <= 85, `${est.p25}-${est.p75}`);
  assert.equal(duringWeather([], 20, offsets, 'out0', 'lightning'), null, 'no storm history, no range');
});
