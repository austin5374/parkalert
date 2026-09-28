// The weather feeds against fake live and archive servers.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakes } from './fakes.js';

const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const at = (iso) => Date.parse(iso);
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
let fakes, store, w;

before(async () => {
  fakes = await startFakes();
  store = await import('../server/store.js');
  w = await import('../server/weather.js');
});
after(() => fakes.close());
beforeEach(() => {
  store.weather.obs = {};
  store.weather.fetched = {};
  for (const k of Object.keys(store.trips)) delete store.trips[k];
  store.history.fetched = {};
  fakes.upstream.archiveCalls.length = 0;
  fakes.upstream.archiveStatus = 200;
});

test('live reports come in for the stations of parks someone is watching', async () => {
  store.trips.AAAAAA = { code: 'AAAAAA', topic: 't', parkId: MK, createdAt: Date.now() };
  const t = Math.floor(Date.now() / 1000) - 600;
  fakes.upstream.metars = [
    { icaoId: 'KISM', obsTime: t, rawOb: 'KISM 281853Z 4SM -TSRA BKN030CB RMK AO2 TSB35' },
    { icaoId: 'KMCO', obsTime: t, rawOb: 'KMCO 281853Z 10SM FEW040 RMK AO2' },
    { icaoId: 'KFUL', obsTime: t, rawOb: 'KFUL 281853Z 10SM CLR' },
  ];
  await w.syncLiveWeather();
  assert.deepEqual(Object.keys(store.weather.obs).sort(), ['KISM', 'KMCO'], 'only Walt Disney World stations');
  assert.equal(store.weather.obs.KISM[0].thunder, 'here');
  const { current } = w.spellAt(w.timelines(MK).thunder, Date.now());
  assert.ok(current && current.end === null, 'storm in progress');
});

test('the archive is read for each outage-archive day and the UTC day after', async () => {
  store.history.fetched[MK] = ['2026-09-20'];
  fakes.upstream.archive['ISM:2026-09-20'] = [
    'ISM,2026-09-20 18:53,KISM 201853Z 4SM -TSRA BKN030CB RMK AO2 TSB35',
    'ISM,2026-09-20 20:17,SPECI KISM 202017Z 10SM FEW030 RMK AO2 TSE10',
  ].join('\n');
  await w.syncWeatherArchive(at('2026-09-28T12:00Z'), { gapMs: 0 });
  assert.deepEqual(fakes.upstream.archiveCalls.sort(), ['ISM:2026-09-20..2026-09-21', 'MCO:2026-09-20..2026-09-21']);
  assert.deepEqual(store.weather.fetched.KISM.sort(), ['2026-09-20', '2026-09-21']);
  const storm = w.timelines(MK).thunder[0];
  assert.deepEqual([hhmm(storm.start), hhmm(storm.end)], ['18:35', '20:10']);
  // Nothing left to fetch.
  fakes.upstream.archiveCalls.length = 0;
  await w.syncWeatherArchive(at('2026-09-28T12:00Z'), { gapMs: 0 });
  assert.deepEqual(fakes.upstream.archiveCalls, []);
});

test('a week of days is one request per station, and a gap starts another', () => {
  const needed = [];
  for (const day of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-10', '2026-09-11']) {
    for (const station of ['KISM', 'KMCO']) needed.push({ station, day });
  }
  assert.deepEqual(w.archiveRuns(needed).map((r) => `${r.station} ${r.from}..${r.to}`), [
    'KISM 2026-09-10..2026-09-11', 'KMCO 2026-09-10..2026-09-11',
    'KISM 2026-09-01..2026-09-03', 'KMCO 2026-09-01..2026-09-03',
  ]);
  const long = Array.from({ length: 40 }, (_, i) => ({ station: 'KISM', day: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10) }));
  assert.deepEqual(w.archiveRuns(long).map((r) => r.days.length), [31, 9], 'at most a month per request');
});

test('a busy archive (429) stops the sync, and the next one picks up where it left off', async () => {
  store.history.fetched[MK] = ['2026-09-20'];
  fakes.upstream.archiveStatus = 429;
  await w.syncWeatherArchive(at('2026-09-28T12:00Z'), { gapMs: 0 });
  assert.equal(fakes.upstream.archiveCalls.length, 1, 'no hammering after a 429');
  assert.deepEqual(store.weather.fetched, {});
  fakes.upstream.archiveStatus = 200;
  await w.syncWeatherArchive(at('2026-09-28T12:00Z'), { gapMs: 0 });
  assert.deepEqual(Object.keys(store.weather.fetched).sort(), ['KISM', 'KMCO']);
});

test('days not over yet in UTC are left for later', () => {
  store.history.fetched[MK] = ['2026-09-27'];
  const needed = w.archiveDaysNeeded(at('2026-09-28T02:00Z')).map((n) => n.day);
  assert.ok(needed.includes('2026-09-27'));
  assert.ok(!needed.includes('2026-09-28'));
});

test('spellAt tells a storm in progress from one that has passed', () => {
  const list = [{ start: at('2026-09-28T18:35Z'), end: at('2026-09-28T20:10Z') }, { start: at('2026-09-28T22:00Z'), end: null }];
  assert.equal(w.spellAt(list, at('2026-09-28T19:00Z')).current, list[0]);
  assert.deepEqual(w.spellAt(list, at('2026-09-28T21:00Z')), { current: null, lastEnd: list[0].end });
  assert.equal(w.spellAt(list, at('2026-09-28T23:00Z')).current, list[1]);
});
