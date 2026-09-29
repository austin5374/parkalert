// public/time.js is a browser script; load it the way the page does, as
// plain globals, and test its helpers here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ Intl, Date, Object, Number, String, Math });
vm.runInContext(fs.readFileSync(new URL('../public/time.js', import.meta.url), 'utf8'), ctx);
const { nextLocalHour, localDay, extractTripCode, matchesSearch, localClock } = ctx;
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

test('search understands digits, short forms, plurals and ride acronyms', () => {
  const sdmt = 'Seven Dwarfs Mine Train';
  const btmr = 'Big Thunder Mountain Railroad';
  assert.equal(matchesSearch(sdmt, '7 dwarfs'), true);
  assert.equal(matchesSearch(sdmt, 'seven dwarves'), true);
  assert.equal(matchesSearch(sdmt, '7DMT'), true);
  assert.equal(matchesSearch(btmr, 'big thunder mtn'), true);
  assert.equal(matchesSearch(btmr, 'BTMRR'), true);
  assert.equal(matchesSearch('Pirates of the Caribbean', 'potc'), true);
  assert.equal(matchesSearch("Rock 'n' Roller Coaster Starring Aerosmith", 'rnrc'), true);
  assert.equal(matchesSearch("Rémy's Ratatouille Adventure", 'remys'), true);
  assert.equal(matchesSearch('Space Mountain', 'mountain space'), true);
  // Still selective.
  assert.equal(matchesSearch(sdmt, 'thunder'), false);
  assert.equal(matchesSearch('Haunted Mansion', 'hmx'), false);
  assert.equal(matchesSearch('Haunted Mansion', 'h'), true, 'a single letter starts a word');
});

test("a push's park-clock times are shown in the phone's own format", () => {
  const nb = '\u00a0';
  assert.match(localClock(`Went down at 9:44${nb}AM · EPCOT`, 'en-GB'), /^Went down at 0?9:44 · EPCOT$/);
  assert.equal(localClock(`Rides reopen about 30 min after the last lightning: 7:47 to 8:02${nb}PM`, 'en-GB'), 'Rides reopen about 30 min after the last lightning: 19:47 to 20:02');
  assert.equal(localClock(`Usually 89 at 4${nb}PM.`, 'de-DE'), 'Usually 89 at 16 Uhr.');
  assert.match(localClock(`Storm passed at 12:05${nb}AM`, 'en-GB'), /^Storm passed at 0?0:05$/);
  // A US phone gets the push exactly as sent.
  const us = `Often back 8:05 to 8:27${nb}AM, usually 50 at 2${nb}PM`;
  assert.equal(localClock(us, 'en-US'), us);
});
