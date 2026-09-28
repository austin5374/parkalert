// Keeps a local archive of past DOWN episodes, pulled from the ThemeParks.wiki
// history API once per park per day. Estimates only ever read this local copy,
// so a slow or unavailable archive never delays an alert.
import { PARKS } from './parks.js';
import { fetchParkHistory } from './themeparks.js';
import { extractEpisodes } from './episodes.js';
import { history, saveHistory } from './store.js';
import { HISTORY_DAYS as WINDOW_DAYS } from './config.js';

const SYNC_INTERVAL_MS = 60 * 60_000;
// Episodes older than this are dropped. Ride reliability drifts with
// refurbishments, so a year is plenty.
const KEEP_DAYS = 365;
// A day is fetched once, so it must be over: wait until 6am park time the next
// morning, well after any late close or extended evening hours.
const DAY_SETTLE_HOURS = 6;
// Leave a little of the hourly budget for anyone else sharing the IP.
const BUDGET_FLOOR = 2;

const DAY_MS = 24 * 3600_000;

export function localDate(ts, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(ts));
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

// Park-local days that are finished and not yet fetched, newest first.
export function daysToFetch(timezone, now, windowDays, fetched = []) {
  const done = new Set(fetched);
  const latest = addDays(localDate(now - DAY_SETTLE_HOURS * 3600_000, timezone), -1);
  const days = [];
  for (let i = 0; i < windowDays; i++) {
    const d = addDays(latest, -i);
    if (!done.has(d)) days.push(d);
  }
  return days;
}

function prune(now) {
  const cutoff = now - KEEP_DAYS * DAY_MS;
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  for (const parkId of Object.keys(history.episodes)) {
    history.episodes[parkId] = history.episodes[parkId].filter((ep) => ep.start >= cutoff);
  }
  for (const parkId of Object.keys(history.fetched)) {
    history.fetched[parkId] = history.fetched[parkId].filter((d) => d >= cutoffDate);
  }
}

let running = false;

export async function syncHistory(now = Date.now()) {
  if (running) return;
  running = true;
  let added = 0;
  let days = 0;
  try {
    for (const park of PARKS) {
      const fetched = (history.fetched[park.id] ??= []);
      for (const date of daysToFetch(park.timezone, now, WINDOW_DAYS, fetched)) {
        let result;
        try {
          result = await fetchParkHistory(park.id, date);
        } catch (err) {
          if (err.code === 'BUDGET') {
            console.log('[history] hourly budget spent, resuming next sync');
            return;
          }
          // Older days are outside what this key may read; try again tomorrow.
          if (err.code === 'WINDOW') break;
          console.error(`[history] ${park.name} ${date}:`, err.message);
          continue;
        }
        const episodes = extractEpisodes(result.envelope).map((ep) => ({ ...ep, date }));
        (history.episodes[park.id] ??= []).push(...episodes);
        fetched.push(date);
        added += episodes.length;
        days++;
        saveHistory(); // per day, so a crash mid-backfill never refetches
        if (result.remaining !== null && result.remaining <= BUDGET_FLOOR) {
          console.log('[history] hourly budget nearly spent, resuming next sync');
          return;
        }
      }
    }
  } finally {
    if (days) {
      prune(now);
      saveHistory();
      console.log(`[history] fetched ${days} park-day(s), ${added} episode(s)`);
    }
    running = false;
  }
}

export function startHistorySync() {
  const total = Object.values(history.episodes).reduce((n, eps) => n + eps.length, 0);
  console.log(`[history] ${total} past episode(s) loaded`);
  syncHistory();
  setInterval(syncHistory, SYNC_INTERVAL_MS);
}
