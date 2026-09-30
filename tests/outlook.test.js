// What the dashboard and alerts say about down rides, through the real
// outlook path with a small archive.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PARK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
let parkState, history, downOutlook;
before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-outlook-'));
  ({ parkState, history } = await import('../server/store.js'));
  ({ downOutlook } = await import('../server/poller.js'));
});

test('every ride in a hold gets the same outlook, timed from when the hold began', () => {
  const now = Date.now();
  history.episodes[PARK] = [35, 40, 45, 50, 55, 60, 65, 70, 80, 90].map((minutes, i) => ({
    rideId: `old${i}`, start: now - (i + 2) * 86_400_000, minutes, endedAs: 'OPERATING', kind: 'hold', date: `2026-09-0${i}`,
  }));
  const hold = (downSince) => ({ name: 'R', status: 'DOWN', downSince, downFrom: 'OPERATING', liveKind: 'hold', incident: 'hold-1', holdSize: 3 });
  parkState[PARK] = {
    timezone: 'America/New_York',
    schedule: null,
    rides: { a: hold(now - 20 * 60_000), b: hold(now - 18 * 60_000), c: hold(now - 17 * 60_000), x: { name: 'X', status: 'DOWN', downSince: now - 60_000, downFrom: 'OPERATING', liveKind: 'breakdown' } },
  };
  const [a, b, c] = ['a', 'b', 'c'].map((id) => downOutlook(PARK, id, (now - parkState[PARK].rides[id].downSince) / 60_000, now));
  assert.ok(a.text, 'there is an estimate');
  assert.deepEqual([b.text, b.advice, b.window], [a.text, a.advice, a.window]);
  assert.deepEqual([c.text, c.advice, c.window], [a.text, a.advice, a.window]);
  assert.equal(a.kind, 'hold');
  assert.equal(downOutlook(PARK, 'x', 1, now).kind, 'breakdown', 'a breakdown beside it keeps its own');
});
