// public/time.js is a browser script; load it the way the page does, as
// plain globals, and test its helpers here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Object, Number, String, Math });
vm.runInContext(fs.readFileSync(new URL('../public/time.js', import.meta.url), 'utf8'), ctx);
const { nextLocalHour, localDay, extractTripCode } = ctx;
const NY = 'America/New_York';
const iso = (t) => new Date(t).toISOString();

test('pausing in the evening lasts until 7am the next morning, park time', () => {
  // 9pm in Orlando on Sep 27
  assert.equal(iso(nextLocalHour(Date.parse('2026-09-28T01:00:00Z'), NY, 7)), '2026-09-28T11:00:00.000Z');
});

test('pausing after midnight lasts until 7am that same morning, not the day after', () => {
  // 12:30am in Orlando on Sep 28: "tomorrow morning" is six and a half hours away
  assert.equal(iso(nextLocalHour(Date.parse('2026-09-28T04:30:00Z'), NY, 7)), '2026-09-28T11:00:00.000Z');
});

test('the park clock is used, not the phone clock', () => {
  // 11pm in Anaheim is 2am in Orlando; the Disneyland pause ends at 7am Pacific.
  const t = Date.parse('2026-09-28T06:00:00Z');
  assert.equal(iso(nextLocalHour(t, 'America/Los_Angeles', 7)), '2026-09-28T14:00:00.000Z');
});

test('the morning after the clocks go back is still 7am', () => {
  // US DST ends 2026-11-01 at 2am; 10pm on Oct 31 in Orlando is EDT, 7am Nov 1 is EST.
  assert.equal(iso(nextLocalHour(Date.parse('2026-11-01T02:00:00Z'), NY, 7)), '2026-11-01T12:00:00.000Z');
});

test('the calendar day is local to the zone', () => {
  assert.equal(localDay(Date.parse('2026-09-28T02:00:00Z'), NY), '2026-09-27');
  assert.equal(localDay(Date.parse('2026-09-28T12:00:00Z'), NY), '2026-09-28');
});

test('durations read the same in the app as in pushes', async () => {
  const { formatDuration } = await import('../server/notify.js');
  const cases = [[10_000, '<1 min'], [60_000, '1 min'], [47 * 60_000, '47 min'], [60 * 60_000, '1 hr'], [65 * 60_000, '1 hr 5 min'], [-5, '<1 min']];
  for (const [ms, text] of cases) {
    assert.equal(ctx.fmtDuration(ms), text, `app ${ms}`);
    assert.equal(formatDuration(ms), text, `push ${ms}`);
  }
});

test('ride search ignores accents, apostrophes, "the" and word order', () => {
  const { matchesSearch } = ctx;
  const cases = [
    ['Rémy’s Ratatouille Adventure', ['remy', 'remys', 'rémy', 'ratatouille remy']],
    ["Peter Pan's Flight", ['peter pans', 'peterpan', 'pans flight', 'PETER']],
    ["it's a small world", ['its a small', 'small world', "it's"]],
    ['Space Mountain', ['mountain space', 'space mtn'.slice(0, 5), 'the space']],
    ['Casey Jr. Splash ’N’ Soak Station', ['splash n soak', 'casey jr', 'soak']],
    ['Haunted Mansion', ['the haunted', 'haunted the'.split(' ')[0]]],
  ];
  for (const [name, queries] of cases) for (const q of queries) assert.ok(matchesSearch(name, q), `${q} -> ${name}`);
  assert.ok(!matchesSearch('Space Mountain', 'thunder'));
  assert.ok(!matchesSearch('Haunted Mansion', 'haunted pirates'));
  assert.ok(matchesSearch('Anything', '   '));
});

test('the join field finds the code in whatever was pasted', () => {
  assert.equal(extractTripCode(' MKLABS'), 'MKLABS');
  assert.equal(extractTripCode('mklabs '), 'MKLABS');
  assert.equal(extractTripCode('Join my ParkAlert trip at Magic Kingdom. Code MS3ETN\nhttps://parkalert.app/?join=MS3ETN'), 'MS3ETN');
  assert.equal(extractTripCode('https://parkalert.app/?join=tmmdt5'), 'TMMDT5');
  assert.equal(extractTripCode('Code: MS3ETN'), 'MS3ETN');
  // Typing is left alone until a code is there.
  assert.equal(extractTripCode('MKL'), null);
  assert.equal(extractTripCode('Join m'), null);
});
