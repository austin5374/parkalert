// How busy a park is, and when a ride's line is usually shortest. Pure
// functions over hourly wait profiles.
//
// A wait profile is one ride's posted standby wait for each park-local hour
// of one day: the time-weighted average while it was running and posting a
// wait, or null for an hour with too little of that to say.
//   profile: { [rideId]: (number | null)[24] }
//
// The crowd level is relative, never absolute: 45 minutes on the big rides
// is a quiet afternoon at one park and a busy one at another. It ranks the
// park's headliner waits right now against the same hour on past days.

const HOUR_MS = 3600_000;
const MIN_MINUTES_IN_HOUR = 10;
export const HEADLINERS = 10;
export const MIN_BASELINE_DAYS = 3;

const toMs = (iso) => new Date(iso).getTime();
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Time-weighted hourly averages from a list of { t, running, wait } changes
// (each in effect until the next) over one park day starting at dayStart.
export function hourlyAverages(changes, dayStart, dayEnd = dayStart + 24 * HOUR_MS) {
  const sum = Array(24).fill(0);
  const minutes = Array(24).fill(0);
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c.running || c.wait == null) continue;
    let from = Math.max(c.t, dayStart);
    const to = Math.min(i + 1 < changes.length ? changes[i + 1].t : dayEnd, dayEnd);
    while (from < to) {
      const hour = Math.min(23, Math.floor((from - dayStart) / HOUR_MS));
      const edge = Math.min(to, dayStart + (hour + 1) * HOUR_MS);
      const m = (edge - from) / 60_000;
      sum[hour] += c.wait * m;
      minutes[hour] += m;
      from = edge === from ? to : edge;
    }
  }
  return sum.map((s, h) => (minutes[h] >= MIN_MINUTES_IN_HOUR ? Math.round(s / minutes[h]) : null));
}

// envelope: a day of park history (GET /v1/entity/{parkId}/history?date=D).
// Each row is the full live state at that instant, carried forward.
export function extractWaitProfile(envelope) {
  const profile = {};
  for (const entity of envelope.entities || []) {
    if (entity.entityType !== 'ATTRACTION' || !entity.opening?.time) continue;
    const dayStart = toMs(entity.opening.time);
    const stateOf = (s) => ({ running: s?.status === 'OPERATING', wait: s?.queue?.STANDBY?.waitTime ?? null });
    const changes = [{ t: dayStart, ...stateOf(entity.opening) }];
    for (const row of entity.history || []) changes.push({ t: toMs(row.time), ...stateOf(row) });
    const hours = hourlyAverages(changes, dayStart);
    if (hours.some((v) => v != null)) profile[entity.id] = hours;
  }
  return profile;
}

// The same from live wait samples ([t, wait|null] pairs, as the poller keeps
// them), for today so far.
export function profileFromSamples(series, dayStart, now) {
  const changes = series.map(([t, w]) => ({ t, running: w != null, wait: w }));
  // The last known wait holds until now, not until midnight.
  return hourlyAverages(changes, dayStart, Math.min(now, dayStart + 24 * HOUR_MS));
}

// A park's headliners: the rides with the longest typical waits over the
// archived days. Their waits move with the crowd; a carousel's don't.
//   profiles: { [date]: profile }
export function headliners(profiles, n = HEADLINERS) {
  const typical = new Map();
  for (const profile of Object.values(profiles)) {
    for (const [rideId, hours] of Object.entries(profile)) {
      const vals = hours.filter((v) => v != null);
      if (!vals.length) continue;
      if (!typical.has(rideId)) typical.set(rideId, []);
      typical.get(rideId).push(mean(vals));
    }
  }
  return [...typical.entries()]
    .filter(([, days]) => days.length >= Math.min(MIN_BASELINE_DAYS, Object.keys(profiles).length))
    .map(([rideId, days]) => [rideId, median(days)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([rideId]) => rideId);
}

// The crowd index: the average posted wait across the headliners that are
// posting one. Needs at least three of them, or it's one ride's mood.
export function crowdIndex(waits, ids) {
  const vals = ids.map((id) => waits[id]).filter((v) => v != null);
  return vals.length >= 3 ? Math.round(mean(vals)) : null;
}

// The index for each hour of one archived day.
export function hourlyIndex(profile, ids) {
  return Array.from({ length: 24 }, (_, h) => crowdIndex(Object.fromEntries(ids.map((id) => [id, profile[id]?.[h] ?? null])), ids));
}

const LEVEL_WORDS = [
  [3, 'Quieter than usual'],
  [6, 'About usual'],
  [8, 'Busier than usual'],
  [10, 'Much busier than usual'],
];

// 1 to 10: where `index` falls among the same hour's index on past days,
// with ties counted half. Null without MIN_BASELINE_DAYS days to compare.
export function crowdLevel(index, past) {
  if (index == null) return null;
  const vals = past.filter((v) => v != null);
  if (vals.length < MIN_BASELINE_DAYS) return null;
  const below = vals.filter((v) => v < index).length + vals.filter((v) => v === index).length / 2;
  const share = below / vals.length;
  const level = Math.max(1, Math.min(10, Math.round(1 + share * 9)));
  return {
    level,
    label: LEVEL_WORDS.find(([max]) => level <= max)[1],
    index,
    typical: Math.round(median(vals)),
    days: vals.length,
  };
}

// Typical wait for each hour across days (median), where at least
// MIN_BASELINE_DAYS days have a value.
export function typicalByHour(series) {
  return Array.from({ length: 24 }, (_, h) => {
    const vals = series.map((s) => s[h]).filter((v) => v != null);
    return vals.length >= MIN_BASELINE_DAYS ? Math.round(median(vals)) : null;
  });
}

// When a ride's line is usually shortest and longest, from its archived days.
export function bestTimes(profiles, rideId) {
  const days = Object.values(profiles).map((p) => p[rideId]).filter(Boolean);
  const typical = typicalByHour(days);
  const hours = typical.map((w, h) => [h, w]).filter(([, w]) => w != null);
  if (hours.length < 3) return null;
  const best = hours.reduce((a, b) => (b[1] < a[1] ? b : a));
  const worst = hours.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { typical, best: { hour: best[0], wait: best[1] }, worst: { hour: worst[0], wait: worst[1] }, days: days.length };
}

// Lines building: the index up by at least a third and 10 minutes over the
// last half hour, and busier than usual now.
//   samples: [t, index] pairs, oldest first
export const BUILD_WINDOW_MS = 30 * 60_000;
export function linesBuilding(samples, now, level) {
  if (!level || level.level < 7) return null;
  const last = samples[samples.length - 1];
  let then = null;
  for (const [t, v] of samples) {
    if (t > now - BUILD_WINDOW_MS) break;
    then = v;
  }
  if (!last || then == null || last[1] == null) return null;
  const rise = last[1] - then;
  return rise >= 10 && rise >= then / 3 ? { from: then, to: last[1] } : null;
}
