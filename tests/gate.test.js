import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateEvents, gateSnapshot, restoreGate, forgetPending, UP_CONFIRM_MS } from '../server/gate.js';
import { upgradeGate } from '../server/poller.js';

const MIN = 60_000;
const down = (id) => ({ type: 'DOWN', ride: { id, name: id, status: 'DOWN' } });
const up = (id, downtimeMs = MIN) => ({ type: 'UP', ride: { id, name: id, status: 'OPERATING' }, downtimeMs });
const closed = (id) => ({ type: 'CLOSED', ride: { id, name: id, status: 'CLOSED' } });
const state = (id, status) => ({ [id]: { name: id, status } });
const types = (r) => r.send.map((e) => e.type);

// Each test uses its own park id: the gate's memory is module state.

test('a ride going down is told at once', () => {
  assert.deepEqual(types(gateEvents('G1', [down('a')], state('a', 'DOWN'), 0)), ['DOWN']);
});

test('"back up" waits until the ride has stayed up for a minute, then goes once', () => {
  gateEvents('G2', [down('a')], state('a', 'DOWN'), 0);
  assert.deepEqual(types(gateEvents('G2', [up('a')], state('a', 'OPERATING'), 5 * MIN)), []);
  assert.deepEqual(types(gateEvents('G2', [], state('a', 'OPERATING'), 5 * MIN + UP_CONFIRM_MS - 1)), []);
  const out = gateEvents('G2', [], state('a', 'OPERATING'), 5 * MIN + UP_CONFIRM_MS);
  assert.deepEqual(types(out), ['UP']);
  assert.equal(out.send[0].reopenedAt, 5 * MIN, 'the push knows when it really reopened');
  assert.deepEqual(types(gateEvents('G2', [], state('a', 'OPERATING'), 20 * MIN)), [], 'only once');
});

test('a ride that comes back briefly and breaks again is never "back up", and "down" is not repeated', () => {
  gateEvents('G3', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('G3', [up('a')], state('a', 'OPERATING'), 5 * MIN);
  // Down again 20 seconds later: phones still (rightly) think it is down.
  assert.deepEqual(types(gateEvents('G3', [down('a')], state('a', 'DOWN'), 5 * MIN + 20_000)), []);
  assert.deepEqual(types(gateEvents('G3', [], state('a', 'DOWN'), 30 * MIN)), []);
});

test('after a real "back up", going down again is news at once, however soon', () => {
  gateEvents('G4', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('G4', [up('a')], state('a', 'OPERATING'), MIN);
  gateEvents('G4', [], state('a', 'OPERATING'), 2 * MIN); // "back up" goes out
  assert.deepEqual(types(gateEvents('G4', [down('a')], state('a', 'DOWN'), 2 * MIN + 10_000)), ['DOWN']);
});

test('a flapping ride costs one "down", then one "back up" once it settles', () => {
  let sent = [];
  for (let s = 0; s < 18; s++) {
    const ev = s % 2 ? up('a') : down('a');
    sent = sent.concat(types(gateEvents('G5', [ev], state('a', ev.ride.status), s * 20_000)));
  }
  // It settles running at 17 x 20 s and stays up.
  sent = sent.concat(types(gateEvents('G5', [], state('a', 'OPERATING'), 17 * 20_000 + UP_CONFIRM_MS)));
  assert.deepEqual(sent, ['DOWN', 'UP']);
});

test('a down ride closing is told once', () => {
  gateEvents('G6', [down('a')], state('a', 'DOWN'), 0);
  assert.deepEqual(types(gateEvents('G6', [closed('a')], state('a', 'CLOSED'), MIN)), ['CLOSED']);
  assert.deepEqual(types(gateEvents('G6', [closed('a')], state('a', 'CLOSED'), 2 * MIN)), []);
});

test('a "back up" waiting to be confirmed survives a restart through the saved gate', () => {
  gateEvents('G7', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('G7', [up('a')], state('a', 'OPERATING'), MIN);
  const snap = JSON.parse(JSON.stringify(gateSnapshot('G7'))); // as saved to state.json
  restoreGate('G8', snap); // a fresh process, same park under another name
  assert.deepEqual(types(gateEvents('G8', [], state('a', 'OPERATING'), MIN + UP_CONFIRM_MS)), ['UP']);
});

test('after a gap in polling, nothing half-confirmed is sent', () => {
  gateEvents('G9', [down('a')], state('a', 'DOWN'), 0);
  gateEvents('G9', [up('a')], state('a', 'OPERATING'), MIN);
  forgetPending('G9');
  assert.deepEqual(types(gateEvents('G9', [], state('a', 'OPERATING'), 30 * MIN)), []);
});

test('a gate saved before this version keeps only what phones were last told', () => {
  const old = { held: [['P:a', down('a')]], lastSent: { 'P:a': 'DOWN', 'Q:b': 'UP' }, lastNotified: { 'P:a:DOWN': 0 } };
  assert.deepEqual(upgradeGate('P', old), { lastSent: { a: 'DOWN' } });
  restoreGate('G10', upgradeGate('P', old));
  assert.deepEqual(types(gateEvents('G10', [down('a')], state('a', 'DOWN'), MIN)), [], 'phones already think it is down');
});

test("an incident's rides coming back are gathered, then told together", async () => {
  const { INCIDENT_FLUSH_MS } = await import('../server/gate.js');
  const inc = { I: { rides: ['a', 'b', 'c'] } };
  const all = (statuses) => Object.fromEntries(['a', 'b', 'c'].map((id, i) => [id, { name: id, status: statuses[i] }]));
  const upIn = (id) => ({ ...up(id), incident: 'I' });
  gateEvents('G11', ['a', 'b', 'c'].map(down), all(['DOWN', 'DOWN', 'DOWN']), 0, inc);
  // a reopens at 1 min, b at 2 min; c is still down.
  gateEvents('G11', [upIn('a')], all(['OPERATING', 'DOWN', 'DOWN']), MIN, inc);
  let r = gateEvents('G11', [upIn('b')], all(['OPERATING', 'OPERATING', 'DOWN']), 2 * MIN, inc);
  assert.deepEqual([r.send, r.updates], [[], []], 'a is confirmed but waits for company');
  r = gateEvents('G11', [], all(['OPERATING', 'OPERATING', 'DOWN']), 3 * MIN, inc);
  assert.deepEqual(r.updates, [], 'not yet: the first was confirmed at 2 min');
  r = gateEvents('G11', [], all(['OPERATING', 'OPERATING', 'DOWN']), 2 * MIN + INCIDENT_FLUSH_MS, inc);
  assert.deepEqual(r.updates.map((u) => [u.incident, u.ups.map((e) => e.ride.id), u.final]), [['I', ['a', 'b'], false]]);
  // c reopens: the last one, so it goes as soon as it is confirmed.
  gateEvents('G11', [upIn('c')], all(['OPERATING', 'OPERATING', 'OPERATING']), 10 * MIN, inc);
  r = gateEvents('G11', [], all(['OPERATING', 'OPERATING', 'OPERATING']), 11 * MIN, inc);
  assert.deepEqual(r.updates.map((u) => [u.ups.map((e) => e.ride.id), u.final]), [[['c'], true]]);
});
