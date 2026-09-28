// Lightning and rain near each park, from the nearest airport weather
// stations (see server/metar.js for what the reports say and why they are the
// right signal). Two feeds, both free and keyless:
//   live:    NOAA's Aviation Weather Center, every 5 minutes, for the parks
//            someone is watching
//   archive: Iowa State's ASOS archive, for the same days as the outage
//            archive, so estimates can learn how long after a storm each
//            ride really reopens
// Reports are kept for a year, like the outage archive.
import { PARKS, getPark } from './parks.js';
import { WEATHER_BASE, WEATHER_ARCHIVE } from './config.js';
import { weather, saveWeather, history, activeParkIds } from './store.js';
import { parseMetar, spells, mergeSpells } from './metar.js';

const USER_AGENT = 'ParkAlert/1.0 (personal ride-status notifier)';
const LIVE_INTERVAL_MS = 5 * 60_000;
const ARCHIVE_INTERVAL_MS = 60 * 60_000;
const KEEP_MS = 365 * 24 * 3600_000;
// Days pulled from the archive per sync; the backfill catches up over a few hours.
const ARCHIVE_DAYS_PER_SYNC = 40;
// A station whose newest report is older than this has nothing current to say.
// Routine reports come hourly, and a special one the moment a storm starts or ends.
export const STALE_MS = 75 * 60_000;
const DAY_MS = 24 * 3600_000;

const stationsFor = (parkId) => getPark(parkId)?.weather || [];

// Merge parsed reports into a station's list: one per observation time,
// oldest first, nothing older than a year.
export function addObservations(station, list, now = Date.now()) {
  const byTime = new Map((weather.obs[station] || []).map((o) => [o.at, o]));
  for (const o of list) if (Number.isFinite(o.at)) byTime.set(o.at, o);
  weather.obs[station] = [...byTime.values()].filter((o) => now - o.at < KEEP_MS).sort((a, b) => a.at - b.at);
  timelineCache.clear();
}

async function get(url, timeout = 20_000) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} -> HTTP ${res.status}`);
  return res;
}

// The last few hours of reports for these stations.
export async function fetchLive(stations) {
  const res = await get(`${WEATHER_BASE}/metar?ids=${stations.join(',')}&format=json&hours=3`);
  const rows = await res.json();
  const byStation = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.icaoId || !r.rawOb || !Number.isFinite(r.obsTime)) continue;
    (byStation[r.icaoId] ??= []).push(parseMetar(r.rawOb, r.obsTime * 1000));
  }
  return byStation;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// Every report (routine and special) for one station on one UTC day.
// The archive names US stations without the leading K.
export async function fetchArchiveDay(station, utcDate) {
  const [y1, m1, d1] = utcDate.split('-').map(Number);
  const [y2, m2, d2] = addDays(utcDate, 1).split('-').map(Number);
  const id = station.replace(/^K/, '');
  const url = `${WEATHER_ARCHIVE}?station=${id}&data=metar&year1=${y1}&month1=${m1}&day1=${d1}` +
    `&year2=${y2}&month2=${m2}&day2=${d2}&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty` +
    '&report_type=3&report_type=4';
  const text = await (await get(url, 60_000)).text();
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    // station,valid,metar  e.g.  ISM,2026-09-20 18:53,KISM 201853Z ...
    const m = line.match(/^[^,]+,(\d{4}-\d{2}-\d{2} \d{2}:\d{2}),(.+)$/);
    if (!m) continue;
    const at = Date.parse(`${m[1].replace(' ', 'T')}:00Z`);
    if (Number.isFinite(at) && at < Date.parse(`${utcDate}T00:00:00Z`) + DAY_MS) out.push(parseMetar(m[2].trim(), at));
  }
  return out;
}

let liveRunning = false;
export async function syncLiveWeather(now = Date.now()) {
  if (liveRunning) return;
  liveRunning = true;
  try {
    const stations = [...new Set(activeParkIds(now).flatMap(stationsFor))];
    if (!stations.length) return;
    const byStation = await fetchLive(stations);
    for (const [station, list] of Object.entries(byStation)) addObservations(station, list, now);
    saveWeather();
  } catch (err) {
    console.error('[weather] live reports:', err.message);
  } finally {
    liveRunning = false;
  }
}

// UTC days of reports each station needs: the outage archive's park days,
// and the UTC day after each (an evening in Florida is the next UTC day).
export function archiveDaysNeeded(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const need = {};
  for (const park of PARKS) {
    for (const date of history.fetched[park.id] || []) {
      for (const day of [date, addDays(date, 1)]) {
        if (day >= today) continue;
        for (const s of park.weather || []) (need[s] ??= new Set()).add(day);
      }
    }
  }
  const out = [];
  for (const [station, days] of Object.entries(need)) {
    const done = new Set(weather.fetched[station] || []);
    for (const day of [...days].sort().reverse()) if (!done.has(day)) out.push({ station, day });
  }
  return out;
}

let archiveRunning = false;
export async function syncWeatherArchive(now = Date.now()) {
  if (archiveRunning) return;
  archiveRunning = true;
  let days = 0;
  try {
    for (const { station, day } of archiveDaysNeeded(now).slice(0, ARCHIVE_DAYS_PER_SYNC)) {
      try {
        addObservations(station, await fetchArchiveDay(station, day), now);
        (weather.fetched[station] ??= []).push(day);
        days++;
      } catch (err) {
        console.error(`[weather] archive ${station} ${day}:`, err.message);
        break; // the archive is unhappy; try again next sync
      }
    }
  } finally {
    if (days) {
      const cutoff = new Date(now - KEEP_MS).toISOString().slice(0, 10);
      for (const s of Object.keys(weather.fetched)) weather.fetched[s] = weather.fetched[s].filter((d) => d >= cutoff);
      saveWeather();
      console.log(`[weather] archived ${days} station-day(s) of reports`);
    }
    archiveRunning = false;
  }
}

// A park's storm and rain spells, every station merged, oldest first.
// Cached until new reports arrive.
const timelineCache = new Map();
export function timelines(parkId) {
  const key = parkId;
  if (timelineCache.has(key)) return timelineCache.get(key);
  const stations = stationsFor(parkId);
  const obs = stations.map((s) => weather.obs[s] || []);
  const t = {
    thunder: mergeSpells(obs.map((o) => spells(o, 'thunder'))),
    rain: mergeSpells(obs.map((o) => spells(o, 'rain'))),
    // Newest report from any station, to tell a quiet sky from no data.
    latest: Math.max(-Infinity, ...obs.map((o) => (o.length ? o[o.length - 1].at : -Infinity))),
  };
  timelineCache.set(key, t);
  return t;
}

// What a spell list says at time t: the spell in progress (if any), and the
// end of the last one to finish before t.
export function spellAt(list, t) {
  let current = null;
  let lastEnd = null;
  for (const s of list) {
    if (s.start > t) break;
    if (s.end === null || s.end > t) current = s;
    else lastEnd = s.end;
  }
  return { current, lastEnd };
}

export function startWeatherSync() {
  const total = Object.values(weather.obs).reduce((n, o) => n + o.length, 0);
  console.log(`[weather] ${total} report(s) loaded`);
  syncLiveWeather();
  syncWeatherArchive();
  setInterval(syncLiveWeather, LIVE_INTERVAL_MS).unref();
  setInterval(syncWeatherArchive, ARCHIVE_INTERVAL_MS).unref();
}
