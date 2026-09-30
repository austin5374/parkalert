// The crowd numbers for live parks: the pure maths in crowds.js applied to
// the wait profiles in the archive and the waits the poller sees now.
import { history, parkState } from './store.js';
import { parkDayStart } from './time.js';
import { getPark } from './parks.js';
import {
  headliners, rideTypicals, usualIndex, crowdRatio, crowdLabel, smoothedCrowd, settleLabel,
  profileFromSamples, bestTimes, SMOOTH_MS, MIN_BASELINE_DAYS,
} from './crowds.js';

const zone = (parkId) => parkState[parkId]?.timezone || getPark(parkId)?.timezone || 'America/New_York';
const localHour = (now, tz) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(now)));

// Headliners, each ride's typical wait by hour, and the park's usual
// big-ride wait by hour, rebuilt only when the archive's days change.
const cache = new Map(); // parkId -> { key, ids, typicals, usual, days, posted }
function baseline(parkId) {
  const profiles = history.waits?.[parkId] || {};
  const key = Object.keys(profiles).sort().join(',');
  const hit = cache.get(parkId);
  if (hit?.key === key) return hit;
  const ids = headliners(profiles);
  const typicals = rideTypicals(profiles);
  const days = Object.keys(profiles).length;
  // Rides that posted a wait on some archived day; unknown while it is young.
  const posted = days >= MIN_BASELINE_DAYS ? new Set(Object.values(profiles).flatMap((p) => Object.keys(p))) : null;
  const entry = { key, ids, typicals, usual: usualIndex(ids, typicals), days, posted };
  cache.set(parkId, entry);
  return entry;
}

// An attraction that never posts a wait (a castle, a gallery, a play area,
// a railroad station): listed, but never alerted about. Never a ride posting
// a wait right now, and nothing is while the archive is too young to know.
export function isOtherAttraction(parkId, rideId, ride = parkState[parkId]?.rides?.[rideId]) {
  const { posted } = baseline(parkId);
  return !!posted && !posted.has(rideId) && ride?.waitTime == null;
}

// What a new trip, or a trip arriving at a park, has alerts on for: the
// park's headliners, or every ride (null) until the archive knows them.
export function defaultFollows(parkId) {
  const { ids } = baseline(parkId);
  return ids.length ? [...ids] : null;
}

const liveWaits = (parkId) => Object.fromEntries(Object.entries(parkState[parkId]?.rides || {})
  .map(([id, r]) => [id, r.status === 'OPERATING' ? r.waitTime ?? null : null]));

// Each ride's usual posted wait at this hour, where the archive knows one.
export function usualWaits(parkId, now = Date.now()) {
  const b = baseline(parkId);
  const hour = localHour(now, zone(parkId));
  const out = {};
  for (const [id, hours] of Object.entries(b.typicals)) if (hours[hour] != null) out[id] = hours[hour];
  return out;
}

// Rides reopening after a hold post waits that say more about the hold than
// the crowd, so the level pauses while one is on and for half an hour after.
export const HOLD_SETTLE_MS = 30 * 60_000;
export function holdPause(state, now = Date.now()) {
  return Object.values(state?.incidents || {}).some((i) => i.kind === 'hold' && (!i.endedAt || now - i.endedAt < HOLD_SETTLE_MS));
}

// One reading a poll, kept three hours: [t, ratio, usual]. While a hold
// pauses the level, the readings so far are dropped, so nothing from before
// it is ever compared with after (which is what "lines building" does).
const CROWD_KEEP_MS = 3 * 3600_000;
export function recordCrowd(parkId, now = Date.now()) {
  const state = parkState[parkId];
  if (!state) return;
  // Readings from before the ratio (two numbers) mean something else.
  state.crowd = (state.crowd || []).filter((x) => x.length >= 3 && now - x[0] < CROWD_KEEP_MS);
  if (holdPause(state, now)) {
    state.crowd = [];
    state.crowdShown = null;
    return;
  }
  const b = baseline(parkId);
  const hour = localHour(now, zone(parkId));
  const ratio = b.ids.length ? crowdRatio(liveWaits(parkId), b.ids, b.typicals, hour) : null;
  if (ratio == null || b.usual[hour] == null) return;
  state.crowd.push([now, Math.round(ratio * 1000) / 1000, b.usual[hour]]);
  state.crowdShown = settleLabel(state.crowdShown, crowdLabel(smoothedCrowd(state.crowd, now).ratio));
}

// Now, for the crowd row: { label, ratio, index, typical, hour, paused }, or
// null with nothing to say (no archive yet, an hour the park is usually
// closed, or no fresh readings). index and typical are minutes: the big-ride
// average the reading stands for, and the usual at this hour. paused: 'hold'
// during a hold and just after, 'few' while too few big rides are posting.
export function parkCrowd(parkId, now = Date.now()) {
  const state = parkState[parkId];
  const b = baseline(parkId);
  if (!state || !b.ids.length) return null;
  const hour = localHour(now, zone(parkId));
  const typical = b.usual[hour];
  if (typical == null || !state.lastPoll || now - state.lastPoll > SMOOTH_MS) return null;
  if (holdPause(state, now)) return { paused: 'hold', typical, hour };
  const cur = smoothedCrowd(state.crowd || [], now);
  if (!cur) {
    const open = Object.values(state.rides || {}).some((r) => r.status === 'OPERATING');
    return open ? { paused: 'few', typical, hour } : null;
  }
  return {
    label: state.crowdShown?.label || crowdLabel(cur.ratio),
    ratio: Math.round(cur.ratio * 100) / 100,
    index: cur.index,
    typical,
    hour,
    paused: null,
  };
}

// Today hour by hour against a usual day, for the park page's chart. Each
// hour is read the way the live level is: the headliners that posted,
// against their own usual, so a storm's closures never draw a quiet hour.
export function crowdToday(parkId, now = Date.now()) {
  const b = baseline(parkId);
  if (!b.ids.length) return null;
  const tz = zone(parkId);
  const dayStart = parkDayStart(tz, now);
  const waits = parkState[parkId]?.waits || {};
  const today = Object.fromEntries(b.ids.map((id) => [id, profileFromSamples((waits[id] || []).filter(([t]) => t >= dayStart - 3600_000), dayStart, now)]));
  const hour = localHour(now, tz);
  const curve = Array.from({ length: 24 }, (_, h) => {
    const ratio = crowdRatio(Object.fromEntries(b.ids.map((id) => [id, today[id][h]])), b.ids, b.typicals, h);
    return ratio != null && b.usual[h] != null ? Math.round(ratio * b.usual[h]) : null;
  });
  // The hour under way shows the live reading, so the chart and the row
  // above it never disagree.
  const live = parkCrowd(parkId, now);
  if (live?.index != null) curve[hour] = live.index;
  return { today: curve, typical: b.usual, days: b.days, now: live, hour };
}

export function rideBestTimes(parkId, rideId) {
  return bestTimes(history.waits?.[parkId] || {}, rideId);
}
