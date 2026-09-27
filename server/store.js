import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Data lives on an attached volume when one exists (Railway injects
// RAILWAY_VOLUME_MOUNT_PATH automatically), falling back to ./data locally.
const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TRIPS_FILE = path.join(DATA_DIR, 'trips.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveAtomic(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

// trips: { [code]: { code, topic, parkId, watched, mute, rideMutes, createdAt } }
//   watched: null = all rides, or array of ride ids
//   mute: null, or { until: epoch-ms | null } (null until = muted indefinitely)
//   rideMutes: { [rideId]: true }
export const trips = load(TRIPS_FILE, {});

// parkState: { [parkId]: { lastPoll, lastError, timezone, schedule, rides } }
//   rides: { [rideId]: { name, status, since, downSince, waitTime } }
export const parkState = load(STATE_FILE, {});

export function saveTrips() {
  saveAtomic(TRIPS_FILE, trips);
}

export function saveState() {
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

export function activeParkIds() {
  return [...new Set(Object.values(trips).map((t) => t.parkId))];
}
