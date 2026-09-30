// The facts and words the redesigned app leans on: each ride's land and
// short name, and pushes that say times the way the app does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rideFacts } from '../server/lands.js';
import { outlookLine, holdTitle, downMessage } from '../server/messages.js';
import { waitAlertMessage } from '../server/waitalerts.js';
import { parseWaitAlert } from '../server/validate.js';

test('rides know their land and a short name, matched on the feed name', () => {
  assert.deepEqual(rideFacts('Magic Kingdom', 'Buzz Lightyear’s Space Ranger Spin'), { land: 'Tomorrowland', short: 'Buzz Lightyear', coaster: false });
  assert.deepEqual(rideFacts('Magic Kingdom', 'Big Thunder Mountain Railroad'), { land: 'Frontierland', short: 'Big Thunder Mountain', coaster: true });
  assert.equal(rideFacts('Magic Kingdom', '"it\'s a small world"').land, 'Fantasyland');
  assert.equal(rideFacts('Disneyland (CA)', 'Jungle Cruise').land, 'Adventureland', 'the same name in another park');
  assert.equal(rideFacts('EPCOT', 'Guardians of the Galaxy: Cosmic Rewind').short, 'Cosmic Rewind');
  assert.deepEqual(rideFacts('Magic Kingdom', 'A Brand New Ride'), { land: null, short: null, coaster: false }, 'unknown rides just have no land');
  assert.deepEqual(rideFacts('Nowhere', 'Space Mountain'), { land: null, short: null, coaster: false });
});

test('pushes say when a ride is likely back as a clock time', () => {
  const now = Date.parse('2026-09-21T14:55:00Z'); // 10:55 AM in Orlando
  const tz = 'America/New_York';
  assert.equal(outlookLine({ window: { lo: 5, hi: 25 } }, tz, now), 'Back at about 11:10 AM');
  assert.equal(outlookLine({ window: { lo: 30, hi: null } }, tz, now), 'Back at about 11:25 AM');
  assert.equal(outlookLine({ cause: 'lightning', weather: 'passed', window: { lo: 25, hi: 40 } }, tz, now), 'Likely back 11:20 AM or later');
  assert.equal(outlookLine({ cause: 'lightning', weather: 'ongoing', window: { lo: 25, hi: 40 } }, tz, now), 'Waiting for the storm to pass', 'no time while it storms');
  assert.equal(outlookLine({ cause: 'rain', window: null }, tz, now), 'Waiting for the rain to stop');
  assert.equal(outlookLine({ window: { lo: 70, hi: 120 } }, tz, now), 'Back in over an hour');
  assert.equal(outlookLine({ advice: { key: 'long' }, window: null }, tz, now), 'Back in over an hour');
  assert.equal(outlookLine({ advice: { key: 'closed' } }, tz, now), 'Often closed for the rest of the day');
  assert.equal(outlookLine(null), null);
});

test('rides down together are never said to have broken, and weather is only likely', () => {
  assert.equal(holdTitle({ cause: 'lightning' }, 12), '12 rides closed, likely lightning');
  assert.equal(holdTitle({}, 8), '8 rides down together');
  const now = Date.parse('2026-09-21T14:55:00Z');
  const m = downMessage({ name: 'Space Mountain', downSince: now - 12 * 60_000 }, { kind: 'breakdown', window: { lo: 5, hi: 25 } }, 'Magic Kingdom', 'America/New_York', now);
  assert.equal(m.title, 'Space Mountain is down');
  assert.match(m.message, /^Back at about 11:10 AM\nWent down at 10:43/);
  assert.doesNotMatch(JSON.stringify(m), /broke/);
});

test('a wait alert can belong to one phone, and then it says "you"', () => {
  assert.deepEqual(parseWaitAlert({ max: 20, device: 'abc' }, 5, 240), { max: 20, device: 'abc' });
  assert.deepEqual(parseWaitAlert({ max: 20 }, 5, 240), { max: 20, device: null });
  assert.throws(() => parseWaitAlert({ max: 20, device: 7 }, 5, 240));
  const ride = { name: 'Haunted Mansion', waitTime: 10 };
  assert.match(waitAlertMessage(ride, { max: 10, device: 'abc' }, 'Magic Kingdom').message, /^You asked for 10 min/);
  assert.match(waitAlertMessage(ride, { max: 10 }, 'Magic Kingdom').message, /^Alert set for 10 min/);
});
