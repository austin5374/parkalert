import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtest } from '../server/backtest.js';

const MIN = 60_000;
const H = 60 * MIN;

// Twelve storm days. Storms last anywhere from 30 min to 2 hours, but rides
// reopen 30 to 40 min after each ends, which is what the new estimate uses.
function archive() {
  const thunder = [];
  const eps = [];
  for (let d = 1; d <= 12; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const s = Date.parse(`${date}T18:00:00Z`);
    const len = (30 + ((d * 37) % 91)) * MIN;
    thunder.push({ start: s, end: s + len });
    for (let r = 0; r < 6; r++) {
      const reopen = s + len + (30 + ((d * 3 + r * 2) % 11)) * MIN;
      eps.push({ rideId: `out${r}`, start: s - 5 * MIN, minutes: (reopen - s + 5 * MIN) / MIN, endedAs: 'OPERATING', kind: 'hold', date });
    }
  }
  return { history: { P: eps }, tls: { P: { thunder, rain: [] } } };
}

test('on storm days, timing from the all-clear beats timing from the outage', () => {
  const { history, tls } = archive();
  const r = backtest(history, tls);
  const old = r['lightning: when the weather cleared, old'];
  const neu = r['lightning: when the weather cleared, new (learned)'];
  assert.ok(neu.n > 20, JSON.stringify(r));
  assert.ok(neu.width <= 15, `new ranges ${neu.width} min wide`);
  assert.ok(neu.miss < old.miss, `new misses by ${neu.miss}, old by ${old.miss}`);
  assert.ok(neu.within7 >= 0.8, `within 7.5 min: ${neu.within7}`);
});

test('an archive with no weather still scores the ordinary estimates', () => {
  const eps = [];
  for (let d = 1; d <= 6; d++) {
    for (let i = 0; i < 8; i++) {
      eps.push({ rideId: 'a', start: Date.parse(`2026-09-0${d}T15:00:00Z`) + i * H, minutes: 10 + ((d + i) % 5) * 5, endedAs: 'OPERATING', kind: 'breakdown', date: `2026-09-0${d}` });
    }
  }
  const r = backtest({ P: eps });
  assert.ok(r['breakdown: when it went down, old'].n > 0);
  assert.ok(r['breakdown: when it went down, old'].inRange > 0);
});

test('an outage that never reopened counts as a miss once it outlasts the range', () => {
  const eps = [];
  for (let d = 1; d <= 6; d++) {
    for (let i = 0; i < 8; i++) {
      eps.push({ rideId: 'a', start: Date.parse(`2026-09-0${d}T15:00:00Z`) + i * H, minutes: 10 + (i % 3) * 5, endedAs: 'OPERATING', kind: 'breakdown', date: `2026-09-0${d}` });
    }
  }
  const base = backtest({ P: eps })['breakdown: when it went down, old'];
  // Day 7: one ordinary reopening, and one that stayed down for 5 hours.
  eps.push({ rideId: 'a', start: Date.parse('2026-09-07T15:00:00Z'), minutes: 15, endedAs: 'OPERATING', kind: 'breakdown', date: '2026-09-07' });
  eps.push({ rideId: 'a', start: Date.parse('2026-09-07T17:00:00Z'), minutes: 300, endedAs: 'CLOSED', kind: 'breakdown', date: '2026-09-07' });
  const withClose = backtest({ P: eps })['breakdown: when it went down, old'];
  assert.equal(withClose.n, base.n + 2);
  assert.ok(withClose.inRange < base.inRange + 0.001, 'the stayed-down outage is a miss, not ignored');
});
