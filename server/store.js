import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const TRIPS_FILE = path.join(DATA_DIR, 'trips.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WEATHER_FILE = path.join(DATA_DIR, 'weather.json');

// A missing file is a fresh start. A file that exists but won't parse is
// never silently replaced: it is moved aside (file.corrupt-<time>) for a
// person to recover, and the last daily backup is used if there is one.
// Otherwise the next save would write an empty object over every trip.
export function loadFile(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`[store] ${path.basename(file)} is unreadable; moved it to ${path.basename(aside)}`);
    try {
      const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      console.error(`[store] using ${path.basename(file)}.bak instead`);
      return backup;
    } catch {
      return fallback;
    }
  }
}
const load = loadFile;

// Write to a temp file, flush it to disk, then rename over the old one, so a
// crash leaves either the old file or the new one, never half of either.
// With keepBackup, the file being replaced is copied to file.bak once a day.
export function saveAtomic(file, obj, indent, { keepBackup = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, indent));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (keepBackup) {
    try {
      const bak = `${file}.bak`;
      const age = Date.now() - (fs.statSync(bak, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > 24 * 3600_000 && fs.existsSync(file)) fs.copyFileSync(file, bak);
    } catch (err) {
      console.error('[store] backup failed:', err.message);
    }
  }
  fs.renameSync(tmp, file);
}

// trips: { [code]: { code, topic, parkId, watched, watchedByPark, mute, rideMutes, createdAt, lastSeenAt, devices, ntfyConfirmedAt, idleWarnedFor } }
//   watched: null = all rides, or array of ride ids (for the current park)
//   watchedByPark: { [parkId]: watched } saved when hopping away from a park
//   mute: null, or { until: epoch-ms | null } (null until = muted indefinitely)
//   rideMutes: { [rideId]: true }
//   lastSeenAt: last dashboard load, written at most hourly (see touchTrip)
//   devices: phones on the app's own notifications ({ id, endpoint, keys, mute, createdAt, seenAt })
//   ntfyConfirmedAt: when a phone last said an ntfy test arrived
//   idleWarnedFor: the tripIdleAt its phones were last warned about
export const trips = load(TRIPS_FILE, {});

// parkState: { [parkId]: { lastPoll, lastError, timezone, schedule, rides, recent, waits, calls, scores } }
//   rides: { [rideId]: { name, status, waitTime, since, downSince, downFrom, missed? } }
//     downFrom: the status it went DOWN from; missed: polls it has been absent
//   recent: today's transitions, newest first (see recordRecent in poller.js)
//   waits: { [rideId]: [[epoch-ms, minutes | null], ...] } (see recordWaits)
//   calls, scores: reopen estimates and how they turned out (see scorecard.js)
export const parkState = load(STATE_FILE, {});

// history: { fetched: { [parkId]: [YYYY-MM-DD, ...] }, episodes: { [parkId]: episode[] } }
//   fetched: park-local days already pulled from the archive, so each is fetched once
//   episodes: see server/episodes.js
export const history = load(HISTORY_FILE, { fetched: {}, episodes: {} });

// weather: { obs: { [station]: observation[] }, fetched: { [station]: [UTC YYYY-MM-DD, ...] } }
//   obs: parsed airport reports, oldest first (see server/metar.js)
//   fetched: UTC days already pulled from the report archive
export const weather = load(WEATHER_FILE, { obs: {}, fetched: {} });

// The weather and outage archives grow to several MB over a year. Writing
// them synchronously held up polls and pushes for 100 ms or more, so they
// are written off the event loop, a moment after the last change; a write
// asked for while one is under way runs once more after it.
function laterWriter(file, get) {
  let timer = null;
  let writing = null;
  let again = false;
  const write = async () => {
    timer = null;
    if (writing) { again = true; return; }
    writing = (async () => {
      const tmp = `${file}.tmp`;
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(get()));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmp, file);
    })().catch((err) => console.error(`[store] writing ${path.basename(file)}:`, err.message))
      .finally(() => {
        writing = null;
        if (again) { again = false; write(); }
      });
  };
  return {
    save() {
      if (!timer) timer = setTimeout(write, 1000);
      timer.unref?.();
    },
    // Now, synchronously: on shutdown.
    flush() {
      if (!timer && !again) return;
      clearTimeout(timer);
      timer = null;
      again = false;
      saveAtomic(file, get());
    },
  };
}
const weatherWriter = laterWriter(WEATHER_FILE, () => weather);
const historyWriter = laterWriter(HISTORY_FILE, () => history);

export function saveWeather() {
  weatherWriter.save();
}

// State and history are large and only ever read by the app, so they are
// written compactly; trips.json stays readable for a person poking at it.
export function saveHistory() {
  historyWriter.save();
}

export function saveTrips() {
  saveAtomic(TRIPS_FILE, trips, 1, { keepBackup: true });
}

// Every park's poll lands within the same second or so, and each used to
// rewrite the whole file; now one write a moment later covers them all.
let stateTimer = null;
export function saveState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    saveAtomic(STATE_FILE, parkState);
  }, 1000);
  stateTimer.unref();
}

// Write anything pending now, e.g. on shutdown.
export function flushState() {
  weatherWriter.flush();
  historyWriter.flush();
  if (!stateTimer) return;
  clearTimeout(stateTimer);
  stateTimer = null;
  saveAtomic(STATE_FILE, parkState);
}

// Unambiguous alphabet (no 0/O/1/I) for shareable trip codes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

// watched: the rides it starts with alerts on (null: every ride).
export function createTrip(parkId, { watched = null } = {}) {
  let code;
  do {
    code = randomCode(6);
  } while (trips[code]);
  const trip = {
    code,
    // Random suffix keeps the public ntfy topic unguessable from the code alone.
    topic: `parkalert-${code.toLowerCase()}-${randomCode(8).toLowerCase()}`,
    parkId,
    watched,
    mute: null,
    rideMutes: {},
    createdAt: Date.now(),
  };
  trips[code] = trip;
  saveTrips();
  return trip;
}

export function getTrip(code) {
  return trips[String(code || '').toUpperCase()] || null;
}

// A trip nobody has opened in three weeks is a finished vacation. Its park is
// no longer polled, which is most of what this app costs to run. Opening the
// app again brings it straight back.
export const TRIP_IDLE_MS = 21 * 24 * 3600_000;
// Trips are made months ahead, then left in a pocket on the day waiting for
// pushes. One with a phone signed up for alerts (the app's own, or ntfy once
// a test arrived) keeps going for two months, and its phones hear the day
// before it stops (warnIdleTrips in poller.js).
export const ALERT_TRIP_IDLE_MS = 60 * 24 * 3600_000;

export const hasAlertPhones = (trip) => !!trip.devices?.length || !!trip.ntfyConfirmedAt;

// When the trip stops being polled unless someone opens it.
export function tripIdleAt(trip, now = Date.now()) {
  return (trip.lastSeenAt ?? trip.createdAt ?? now) + (hasAlertPhones(trip) ? ALERT_TRIP_IDLE_MS : TRIP_IDLE_MS);
}

export function isTripActive(trip, now = Date.now()) {
  return now < tripIdleAt(trip, now);
}

export function activeParkIds(now = Date.now()) {
  return [...new Set(Object.values(trips).filter((t) => isTripActive(t, now)).map((t) => t.parkId))];
}

// Called on every dashboard load; written at most hourly to spare the disk.
export function touchTrip(trip, now = Date.now()) {
  if (now - (trip.lastSeenAt ?? 0) < 3600_000) return;
  trip.lastSeenAt = now;
  saveTrips();
}
