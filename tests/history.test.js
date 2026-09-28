import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysToFetch } from '../server/history.js';
import { localDate } from '../server/time.js';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

test('yesterday is not fetched until 6am park time, so a late close is included', () => {
  // 2026-09-28 05:30 in Orlando (09:30Z): the 27th may still be settling.
  assert.deepEqual(daysToFetch(NY, Date.parse('2026-09-28T09:30:00Z'), 2), ['2026-09-26', '2026-09-25']);
  // 06:30 in Orlando: the 27th is done.
  assert.deepEqual(daysToFetch(NY, Date.parse('2026-09-28T10:30:00Z'), 2), ['2026-09-27', '2026-09-26']);
});

test('days are park-local: the same instant can be a different day in California', () => {
  const t = Date.parse('2026-09-28T11:00:00Z'); // 7am Orlando, 4am Anaheim
  assert.equal(daysToFetch(NY, t, 1)[0], '2026-09-27');
  assert.equal(daysToFetch(LA, t, 1)[0], '2026-09-26');
  assert.equal(localDate(t, LA), '2026-09-28');
});

test('days already fetched are skipped, newest first otherwise', () => {
  const t = Date.parse('2026-09-28T12:00:00Z');
  assert.deepEqual(daysToFetch(NY, t, 4, ['2026-09-26']), ['2026-09-27', '2026-09-25', '2026-09-24']);
});

test('crosses month boundaries', () => {
  assert.deepEqual(daysToFetch(NY, Date.parse('2026-10-02T12:00:00Z'), 3), ['2026-10-01', '2026-09-30', '2026-09-29']);
});
