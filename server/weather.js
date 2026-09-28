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
// The archive is asked for a whole run of days per station in one request,
// a few seconds apart: it throttles rapid requests (HTTP 429), and a host
// like Railway shares its outgoing address with other customers.
const ARCHIVE_MAX_RUN_DAYS = 31;
const ARCHIVE_REQUESTS_PER_SYNC = 8;
const ARCHIVE_GAP_MS = 5000;
// A station whose newest report is older than this has nothing current to say.
// Routine reports come hourly, and a special one the moment a storm starts or ends.
export const STALE_MS = 75 * 60_000;
const DAY_MS = 24 * 3600_000;

const stationsFor = (parkId) => getPark(parkId)?.weather || [];

// Merge parsed reports into a station's list: one per observation time,
// oldest first, nothing older than a year.
// Merge parsed reports into a station's list: one per observation time,
// oldest first, nothing older than a year. Returns how many were new.
export function addObservations(station, list, now = Date.now()) {
  const byTime = new Map((weather.obs[station] || []).map((o) => [o.at, o]));
  let added = 0;
  for (const o of list) {
    if (!Number.isFinite(o.at)) continue;
    if (!byTime.has(o.at)) added++;
    byTime.set(o.at, o);
  }
  weather.obs[station] = [...byTime.values()].filter((o) => now - o.at < KEEP_MS).sort((a, b) => a.at - b.at);
  if (added) timelineCache.clear();
  return added;
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

// Every report (routine and special) for one station over UTC days
// from..to, both included. The archive names US stations without the K.
export async function fetchArchiveRange(station, from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = addDays(to, 1).split('-').map(Number);
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
    if (Number.isFinite(at) && at < Date.parse(`${to}T00:00:00Z`) + DAY_MS) out.push(parseMetar(m[2].trim(), at));
  }
  return out;
}

// Called on every poll of a park: fetches its stations' latest reports at
// most every 5 minutes, so a park gets weather the moment someone starts
// watching it, and none once nobody does.
const lastLive = new Map(); // station list -> epoch ms of the last fetch
export async function refreshWeather(parkId, now = Date.now()) {
  const stations = stationsFor(parkId);
  const key = stations.join(',');
  if (!stations.length || now - (lastLive.get(key) ?? -Infinity) < LIVE_INTERVAL_MS) return;
  lastLive.set(key, now);
  try {
    const byStation = await fetchLive(stations);
    let added = 0;
    for (const [station, list] of Object.entries(byStation)) added += addObservations(station, list, now);
    // Each fetch repeats the last three hours; only new reports need a write.
    if (added) saveWeather();
  } catch (err) {
    console.error('[weather] live reports:', err.message);
  }
}

// Every watched park's stations, now (tests, and the first poll's warm-up).
export async function syncLiveWeather(now = Date.now()) {
  lastLive.clear();
  await Promise.all(activeParkIds(now).map((id) => refreshWeather(id, now)));
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

// The needed days as requests: one per station per run of consecutive
// days, newest first, at most ARCHIVE_MAX_RUN_DAYS each.
export function archiveRuns(needed) {
  const byStation = new Map();
  for (const { station, day } of needed) (byStation.get(station) || byStation.set(station, []).get(station)).push(day);
  const runs = [];
  for (const [station, days] of byStation) {
    let run = null;
    for (const day of [...new Set(days)].sort().reverse()) {
      if (run && run.from === addDays(day, 1) && run.days.length < ARCHIVE_MAX_RUN_DAYS) {
        run.from = day;
        run.days.push(day);
      } else runs.push((run = { station, from: day, to: day, days: [day] }));
    }
  }
  return runs.sort((a, b) => (a.to < b.to) - (a.to > b.to) || a.station.localeCompare(b.station));
}

let archiveRunning = false;
export async function syncWeatherArchive(now = Date.now(), { gapMs = ARCHIVE_GAP_MS } = {}) {
  if (archiveRunning) return;
  archiveRunning = true;
  let days = 0;
  try {
    const runs = archiveRuns(archiveDaysNeeded(now)).slice(0, ARCHIVE_REQUESTS_PER_SYNC);
    for (const [i, { station, from, to, days: runDays }] of runs.entries()) {
      if (i && gapMs) await new Promise((r) => setTimeout(r, gapMs));
      try {
        addObservations(station, await fetchArchiveRange(station, from, to), now);
        (weather.fetched[station] ??= []).push(...runDays);
        days += runDays.length;
      } catch (err) {
        console.error(`[weather] archive ${station} ${from}..${to}:`, err.message);
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
  syncWeatherArchive();
  setInterval(syncWeatherArchive, ARCHIVE_INTERVAL_MS).unref();
}
