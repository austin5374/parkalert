// The crowd numbers for live parks: the pure maths in crowds.js applied to
// the wait profiles in the archive and the waits the poller sees now.
import { history, parkState } from './store.js';
import { parkDayStart } from './time.js';
import { getPark } from './parks.js';
import {
  headliners, crowdIndex, hourlyIndex, crowdLevel, typicalByHour, profileFromSamples, bestTimes,
} from './crowds.js';

const zone = (parkId) => parkState[parkId]?.timezone || getPark(parkId)?.timezone || 'America/New_York';
const localHour = (now, tz) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date(now)));

// Headliners and each archived day's hourly index, rebuilt only when the
// archive's days change.
const cache = new Map(); // parkId -> { key, ids, days, typical }
function baseline(parkId) {
  const profiles = history.waits?.[parkId] || {};
  const key = Object.keys(profiles).sort().join(',');
  const hit = cache.get(parkId);
  if (hit?.key === key) return hit;
  const ids = headliners(profiles);
  const days = Object.values(profiles).map((p) => hourlyIndex(p, ids));
  const entry = { key, ids, days, typical: typicalByHour(days) };
  cache.set(parkId, entry);
  return entry;
}

const liveWaits = (parkId) => Object.fromEntries(Object.entries(parkState[parkId]?.rides || {})
  .map(([id, r]) => [id, r.status === 'OPERATING' ? r.waitTime ?? null : null]));

// Now: { level, label, index, typical, days, hour }, or null when the park
// isn't open, the headliners aren't posting, or the archive is too young.
export function parkCrowd(parkId, now = Date.now()) {
  const b = baseline(parkId);
  if (!b.ids.length) return null;
  const hour = localHour(now, zone(parkId));
  const level = crowdLevel(crowdIndex(liveWaits(parkId), b.ids), b.days.map((d) => d[hour]));
  return level && { ...level, hour };
}

// The index now, for the poller's building-lines check (no baseline needed
// beyond knowing the headliners).
export function liveIndex(parkId) {
  const b = baseline(parkId);
  return b.ids.length ? crowdIndex(liveWaits(parkId), b.ids) : null;
}

// Today hour by hour against a typical day, for the park page's chart.
export function crowdToday(parkId, now = Date.now()) {
  const b = baseline(parkId);
  if (!b.ids.length) return null;
  const dayStart = parkDayStart(zone(parkId), now);
  const waits = parkState[parkId]?.waits || {};
  const today = Object.fromEntries(b.ids.map((id) => [id, profileFromSamples((waits[id] || []).filter(([t]) => t >= dayStart - 3600_000), dayStart, now)]));
  const hour = localHour(now, zone(parkId));
  const curve = hourlyIndex(today, b.ids);
  // The hour under way may not have enough samples of its own yet; the live
  // index fills it, so the chart and the level above it never disagree.
  const live = liveIndex(parkId);
  if (curve[hour] == null && live != null) curve[hour] = live;
  return {
    today: curve,
    typical: b.typical,
    days: b.days.length,
    now: parkCrowd(parkId, now),
    hour,
  };
}

export function rideBestTimes(parkId, rideId) {
  return bestTimes(history.waits?.[parkId] || {}, rideId);
}
