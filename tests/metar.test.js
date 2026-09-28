import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetar, spells, mergeSpells } from '../server/metar.js';

const at = (iso) => Date.parse(iso);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

test('a thunderstorm at the station, with rain, and when it began', () => {
  const o = parseMetar('KISM 281853Z 27008KT 4SM -TSRA FEW025CB BKN100 29/23 A2995 RMK AO2 LTG DSNT ALQDS TSB35RAB45 SLP140 P0001 T02890233', at('2026-09-28T18:53Z'));
  assert.equal(o.thunder, 'here');
  assert.equal(o.rain, true);
  assert.deepEqual(o.events.map((e) => [e.kind, e.edge, hhmm(e.at)]), [['thunder', 'begin', '18:35'], ['rain', 'begin', '18:45']]);
});

test('the special report when a storm ends carries the exact minute', () => {
  const o = parseMetar('SPECI KISM 282017Z 30006KT 10SM FEW030 SCT060 27/24 A2997 RMK AO2 TSE10RAE15 P0012', at('2026-09-28T20:17Z'));
  assert.equal(o.thunder, null);
  assert.equal(o.rain, false);
  assert.deepEqual(o.events.map((e) => [e.kind, e.edge, hhmm(e.at)]), [['thunder', 'end', '20:10'], ['rain', 'end', '20:15']]);
});

test('lightning in the vicinity, or only in the remarks, counts as nearby', () => {
  assert.equal(parseMetar('KMCO 281953Z 25012KT 10SM VCTS SCT040CB 31/22 A2990 RMK AO2', 0).thunder, 'near');
  assert.equal(parseMetar('KMCO 281953Z 25012KT 10SM SCT040 31/22 A2990 RMK AO2 LTG DSNT W', 0).thunder, 'near');
  assert.equal(parseMetar('KMCO 281953Z 25012KT 10SM SCT040 31/22 A2990 RMK AO2 SLP127', 0).thunder, null);
});

test('clouds, visibility and codes that merely contain letters are not weather', () => {
  const o = parseMetar('KFUL 281953Z VRB03KT 10SM FEW025TCU BKN100 24/12 A2992 RMK AO2 SLP131 T02440122', 0);
  assert.deepEqual([o.thunder, o.rain, o.events], [null, false, []]);
  assert.equal(parseMetar('KSNA 281953Z 00000KT 2SM BR OVC004 18/17 A2990', 0).rain, false);
  assert.equal(parseMetar('KSNA 281953Z 00000KT 5SM -RA BR OVC010 18/17 A2990', 0).rain, true);
  assert.equal(parseMetar('KSNA 281953Z 00000KT 10SM VCSH OVC010 18/17 A2990', 0).rain, false);
});

test('an end time in the previous hour is placed in that hour', () => {
  // Reported at 20:05, ended at :50 -> 19:50, not 20:50.
  const o = parseMetar('SPECI KISM 282005Z 10SM FEW030 RMK AO2 TSE50', at('2026-09-28T20:05Z'));
  assert.equal(hhmm(o.events[0].at), '19:50');
  const four = parseMetar('KISM 282053Z 10SM FEW030 RMK AO2 TSB1935E2012', at('2026-09-28T20:53Z'));
  assert.deepEqual(four.events.map((e) => hhmm(e.at)), ['19:35', '20:12']);
});

test('a storm spell runs from its first report to the minute it ended', () => {
  const reports = [
    ['KISM 281753Z 10SM FEW040 RMK AO2', '17:53'],
    ['KISM 281853Z 4SM -TSRA BKN030CB RMK AO2 TSB35RAB45', '18:53'],
    ['SPECI KISM 281931Z 2SM +TSRA BKN020CB RMK AO2', '19:31'],
    ['SPECI KISM 282017Z 10SM FEW030 RMK AO2 TSE10RAE15', '20:17'],
    ['KISM 282053Z 10SM FEW030 RMK AO2', '20:53'],
  ].map(([raw, t]) => parseMetar(raw, at(`2026-09-28T${t}Z`)));
  const [storm] = spells(reports, 'thunder');
  assert.deepEqual([hhmm(storm.start), hhmm(storm.end)], ['18:35', '20:10']);
  const [rain] = spells(reports, 'rain');
  assert.deepEqual([hhmm(rain.start), hhmm(rain.end)], ['18:45', '20:15']);
});

test('a storm still going on has no end yet', () => {
  const reports = [parseMetar('KISM 281853Z 4SM TSRA RMK AO2 TSB40', at('2026-09-28T18:53Z'))];
  assert.equal(spells(reports, 'thunder')[0].end, null);
});

test('a storm that came and went between hourly reports is still caught', () => {
  const reports = [
    parseMetar('KISM 281753Z 10SM FEW040 RMK AO2', at('2026-09-28T17:53Z')),
    parseMetar('KISM 281853Z 10SM FEW040 RMK AO2 TSB05E32', at('2026-09-28T18:53Z')),
  ];
  const s = spells(reports, 'thunder');
  assert.deepEqual(s.map((x) => [hhmm(x.start), hhmm(x.end)]), [['18:05', '18:32']]);
});

test('two stations: the storm is over when both are clear', () => {
  const t = (h) => at(`2026-09-28T${h}Z`);
  const merged = mergeSpells([[{ start: t('18:30'), end: t('19:40') }], [{ start: t('18:50'), end: t('20:05') }, { start: t('22:00'), end: null }]]);
  assert.deepEqual(merged.map((s) => [hhmm(s.start), s.end && hhmm(s.end)]), [['18:30', '20:05'], ['22:00', null]]);
});
