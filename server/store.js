import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const TRIPS_FILE = path.join(DATA_DIR, 'trips.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const WEATHER_FILE = path.join(DATA_DIR, 'weather.json');

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveAtomic(file, obj, indent) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent));
  fs.renameSync(tmp, file);
}

// trips: { [code]: { code, topic, parkId, watched, watchedByPark, mute, rideMutes, createdAt, lastSeenAt } }
//   watched: null = all rides, or array of ride ids (for the current park)
//   watchedByPark: { [parkId]: watched } saved when hopping away from a park
//   mute: null, or { until: epoch-ms | null } (null until = muted indefinitely)
//   rideMutes: { [rideId]: true }
//   lastSeenAt: last dashboard load, written at most hourly (see touchTrip)
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

export function saveWeather() {
  saveAtomic(WEATHER_FILE, weather);
}

// State and history are large and only ever read by the app, so they are
// written compactly; trips.json stays readable for a person poking at it.
export function saveHistory() {
  saveAtomic(HISTORY_FILE, history);
}

export function saveTrips() {
  saveAtomic(TRIPS_FILE, trips, 1);
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

// Write any pending state now, e.g. on shutdown.
export function flushState() {
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

export function createTrip(parkId) {
  let code;
  do {
    code = randomCode(6);
  } while (trips[code]);
  const trip = {
    code,
    // Random suffix keeps the public ntfy topic unguessable from the code alone.
    topic: `parkalert-${code.toLowerCase()}-${randomCode(8).toLowerCase()}`,
    parkId,
    watched: null,
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

export function isTripActive(trip, now = Date.now()) {
  return now - (trip.lastSeenAt ?? trip.createdAt ?? now) < TRIP_IDLE_MS;
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
