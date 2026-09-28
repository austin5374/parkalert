import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueWaitAlerts, pruneWaitAlerts, currentWaitAlerts, waitAlertMessage } from '../server/waitalerts.js';

const today = '2026-09-28';
const running = (waitTime) => ({ name: 'Seven Dwarfs Mine Train', status: 'OPERATING', waitTime });

test('an alert is due once the posted wait is at or under the limit', () => {
  const trip = { waitAlerts: { a: { max: 30, day: today } } };
  assert.deepEqual(dueWaitAlerts(trip, { a: running(45) }, today), []);
  assert.equal(dueWaitAlerts(trip, { a: running(30) }, today).length, 1);
  assert.equal(dueWaitAlerts(trip, { a: running(10) }, today).length, 1);
});

test('a ride that is down or has no posted wait never triggers it', () => {
  const trip = { waitAlerts: { a: { max: 30, day: today } } };
  assert.deepEqual(dueWaitAlerts(trip, { a: { status: 'DOWN', waitTime: 5 } }, today), []);
  assert.deepEqual(dueWaitAlerts(trip, { a: running(null) }, today), []);
  assert.deepEqual(dueWaitAlerts(trip, {}, today), []);
});

test('an alert fires once', () => {
  const trip = { waitAlerts: { a: { max: 30, day: today, sentAt: 1, sentWait: 25 } } };
  assert.deepEqual(dueWaitAlerts(trip, { a: running(20) }, today), []);
});

test("yesterday's alerts are gone, so rope drop doesn't set them all off", () => {
  const trip = { waitAlerts: { a: { max: 30, day: '2026-09-27' }, b: { max: 20, day: today } } };
  assert.deepEqual(Object.keys(currentWaitAlerts(trip, today)), ['b']);
  assert.deepEqual(dueWaitAlerts(trip, { a: running(5) }, today), []);
  assert.equal(pruneWaitAlerts(trip, today), true);
  assert.deepEqual(Object.keys(trip.waitAlerts), ['b']);
  assert.equal(pruneWaitAlerts(trip, today), false);
});

test('the push says the wait and the limit asked for', () => {
  const m = waitAlertMessage(running(20), { max: 30 }, 'Magic Kingdom');
  assert.equal(m.title, 'Seven Dwarfs Mine Train: 20 min wait');
  assert.equal(m.message, 'You asked for 30 min or less · Magic Kingdom');
});
