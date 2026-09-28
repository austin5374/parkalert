import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEpisodes, classify, stayedDown } from '../server/episodes.js';

const DAY = '2026-09-21T04:00:00Z'; // park-local midnight, Orlando
const at = (hhmm) => `2026-09-21T${hhmm}:00Z`;

function ride(id, rows, openingStatus = 'CLOSED') {
  return {
    id,
    name: `Ride ${id}`,
    entityType: 'ATTRACTION',
    opening: { time: DAY, status: openingStatus },
    history: rows.map(([hhmm, status]) => ({ time: at(hhmm), changed: ['status'], status })),
  };
}

test('an outage that reopens becomes one resolved episode', () => {
  const eps = extractEpisodes({
    entities: [ride('a', [['12:00', 'OPERATING'], ['14:00', 'DOWN'], ['14:25', 'OPERATING']])],
  });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].minutes, 25);
  assert.equal(eps[0].endedAs, 'OPERATING');
  assert.equal(eps[0].kind, 'breakdown');
});

test('rows that repeat the same status are not transitions', () => {
  const eps = extractEpisodes({
    entities: [ride('a', [['12:00', 'OPERATING'], ['14:00', 'DOWN'], ['14:05', 'DOWN'], ['14:10', 'OPERATING']])],
  });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].minutes, 10);
});

test('a row without a status carries the previous status forward', () => {
  const rows = [['12:00', 'OPERATING'], ['14:00', 'DOWN'], ['14:05', undefined], ['14:10', 'OPERATING']];
  assert.equal(extractEpisodes({ entities: [ride('a', rows)] })[0].minutes, 10);
});

test('a ride already DOWN when the day opened is skipped, not guessed at', () => {
  const eps = extractEpisodes({ entities: [ride('a', [['13:00', 'OPERATING']], 'DOWN')] });
  assert.equal(eps.length, 0);
});

test('a ride still DOWN at day end is censored at the end of the day', () => {
  const eps = extractEpisodes({ entities: [ride('a', [['12:00', 'OPERATING'], ['23:00', 'DOWN']])] });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].end, null);
  assert.equal(eps[0].endedAs, null);
  assert.equal(eps[0].minutes, 5 * 60); // 23:00Z to 04:00Z next day
  assert.ok(stayedDown(eps[0]));
});

test('going DOWN straight from CLOSED is a late opening, not a breakdown', () => {
  const eps = extractEpisodes({ entities: [ride('a', [['12:00', 'DOWN'], ['12:40', 'OPERATING']])] });
  assert.equal(eps[0].minutes, 40);
  assert.equal(eps[0].from, 'CLOSED');
  assert.equal(eps[0].kind, 'opening');
});

test('a breakdown records that it went down from OPERATING', () => {
  const [ep] = extractEpisodes({ entities: [ride('a', [['12:00', 'OPERATING'], ['13:00', 'DOWN'], ['13:30', 'OPERATING']])] });
  assert.equal(ep.from, 'OPERATING');
});

test('non-attractions are ignored', () => {
  const show = { ...ride('s', [['12:00', 'OPERATING'], ['13:00', 'DOWN'], ['13:30', 'OPERATING']]), entityType: 'SHOW' };
  assert.equal(extractEpisodes({ entities: [show] }).length, 0);
});

test('under a minute back to OPERATING is a blip', () => {
  const [ep] = classify([{ rideId: 'a', start: 0, minutes: 0.5, endedAs: 'OPERATING' }]);
  assert.equal(ep.kind, 'blip');
});

const cluster = (n, gapMin, from = 'OPERATING') =>
  Array.from({ length: n }, (_, i) => ({
    rideId: `r${i}`,
    start: i * gapMin * 60_000,
    minutes: 45,
    from,
    endedAs: 'OPERATING',
  }));

test('five running rides down within ten minutes is a park-wide hold; four is not', () => {
  assert.ok(classify(cluster(5, 2)).every((ep) => ep.kind === 'hold'));
  assert.ok(classify(cluster(4, 2)).every((ep) => ep.kind === 'breakdown'));
  // Five rides, but spread over an hour: independent breakdowns.
  assert.ok(classify(cluster(5, 15)).every((ep) => ep.kind === 'breakdown'));
});

// Disneyland, 2026-09-21 and 22 at 8:01am: six or seven rides went CLOSED to
// DOWN together at rope drop. The first classifier called that weather.
test('several rides failing to open together at rope drop is not a hold', () => {
  assert.ok(classify(cluster(7, 1, 'CLOSED')).every((ep) => ep.kind === 'opening'));
  // Late openers do not count toward a hold for the running rides either.
  const mixed = classify([...cluster(4, 1), ...cluster(3, 1, 'CLOSED').map((ep) => ({ ...ep, rideId: `x${ep.rideId}` }))]);
  assert.ok(mixed.filter((ep) => ep.from === 'OPERATING').every((ep) => ep.kind === 'breakdown'));
});

test('one ride flapping five times is not a park-wide hold', () => {
  const eps = Array.from({ length: 5 }, (_, i) => ({ rideId: 'a', start: i * 60_000, minutes: 3, from: 'OPERATING', endedAs: 'OPERATING' }));
  assert.ok(classify(eps).every((ep) => ep.kind === 'breakdown'));
});

test('a short episode that ended in CLOSED is the park closing, not a ride staying down', () => {
  assert.equal(stayedDown({ endedAs: 'CLOSED', minutes: 20 }), false);
  assert.equal(stayedDown({ endedAs: 'CLOSED', minutes: 300 }), true);
  assert.equal(stayedDown({ endedAs: 'OPERATING', minutes: 300 }), false);
});
