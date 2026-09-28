import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateEvents, NOTIFY_COOLDOWN_MS } from '../server/poller.js';

const MIN = 60_000;
const down = (id) => ({ type: 'DOWN', ride: { id, name: id, status: 'DOWN' } });
const up = (id) => ({ type: 'UP', ride: { id, name: id, status: 'OPERATING' }, downtimeMs: MIN });
const state = (id, status, downSince = null) => ({ [id]: { name: id, status, downSince } });
const types = (evs) => evs.map((e) => e.type);

// Each test uses its own park id: the gate's memory is module state.

test('the first alert in each direction goes straight out', () => {
  assert.deepEqual(types(gateEvents('P1', [down('a')], state('a', 'DOWN'), 0)), ['DOWN']);
  assert.deepEqual(types(gateEvents('P1', [up('a')], state('a', 'OPERATING'), 2 * MIN)), ['UP']);
});

test('down again inside the cooldown is held, then sent once the cooldown passes', () => {
  gateEvents('P2', [down('a')], state('a', 'DOWN', 0), 0);
  gateEvents('P2', [up('a')], state('a', 'OPERATING'), 2 * MIN);
  // Down again a minute later: too soon to repeat "is down".
  assert.deepEqual(gateEvents('P2', [down('a')], state('a', 'DOWN', 3 * MIN), 3 * MIN), []);
  assert.deepEqual(gateEvents('P2', [], state('a', 'DOWN', 3 * MIN), 4 * MIN), [], 'still cooling down');
  // Five minutes after the first "down", it is still down, and phones last heard "back up".
  const out = gateEvents('P2', [], state('a', 'DOWN', 3 * MIN), NOTIFY_COOLDOWN_MS + 1);
  assert.deepEqual(types(out), ['DOWN']);
  assert.equal(out[0].ride.downSince, 3 * MIN, 'the late alert carries the real down time');
});

test('a held alert that is no longer true is dropped', () => {
  gateEvents('P3', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('P3', [up('a')], state('a', 'OPERATING'), MIN);
  gateEvents('P3', [down('a')], state('a', 'DOWN'), 2 * MIN); // held
  // Back up again before the cooldown ends: that UP is itself held (last UP was at 1 min)
  assert.deepEqual(gateEvents('P3', [up('a')], state('a', 'OPERATING'), 3 * MIN), []);
  // ...and when it passes, phones already last heard "back up", so nothing is sent.
  assert.deepEqual(gateEvents('P3', [], state('a', 'OPERATING'), MIN + NOTIFY_COOLDOWN_MS + 1), []);
  assert.deepEqual(gateEvents('P3', [], state('a', 'OPERATING'), 20 * MIN), []);
});

test('a flapping ride still cannot spam', () => {
  let sent = 0;
  for (let m = 0; m < 5; m++) {
    const ev = m % 2 ? up('a') : down('a');
    sent += gateEvents('P4', [ev], state('a', ev.ride.status), m * MIN).length;
  }
  assert.equal(sent, 2, 'one down and one up in five minutes of flapping');
});

test('held alerts are per park', () => {
  gateEvents('P5', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('P5', [up('a')], state('a', 'OPERATING'), MIN);
  gateEvents('P5', [down('a')], state('a', 'DOWN'), 2 * MIN); // held at P5
  assert.deepEqual(gateEvents('P6', [], {}, 10 * MIN), []);
  assert.deepEqual(types(gateEvents('P5', [], state('a', 'DOWN'), 10 * MIN)), ['DOWN']);
});

test('a held alert survives a restart through the saved gate', async () => {
  const { gateSnapshot, restoreGate } = await import('../server/poller.js');
  gateEvents('P9', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('P9', [up('a')], state('a', 'OPERATING'), MIN);
  gateEvents('P9', [down('a')], state('a', 'DOWN'), 2 * MIN); // held
  const snap = JSON.parse(JSON.stringify(gateSnapshot('P9'))); // as saved to state.json
  assert.equal(snap.held.length, 1);
  // A fresh process: nothing in memory for P10, which gets P9's saved gate under a new name.
  const renamed = JSON.parse(JSON.stringify(snap).replaceAll('P9:', 'P10:'));
  restoreGate('P10', renamed);
  assert.deepEqual(types(gateEvents('P10', [], state('a', 'DOWN'), 10 * MIN)), ['DOWN']);
});
