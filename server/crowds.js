// How busy a park is, and when a ride's line is usually shortest. Pure
// functions over hourly wait profiles.
//
// A wait profile is one ride's posted standby wait for each park-local hour
// of one day: the time-weighted average while it was running and posting a
// wait, or null for an hour with too little of that to say.
//   profile: { [rideId]: (number | null)[24] }
//
// The crowd level is relative, never absolute: 45 minutes on the big rides
// is a quiet afternoon at one park and a busy one at another. It compares
// each headliner's posted wait now with that ride's own usual wait at this
// hour, so a ride that closes (in a storm, say) drops out of both sides
// instead of dragging the average down.

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

// Each ride's typical posted wait for each hour: the median across the
// archived days that have one.
//   profiles: { [date]: profile } -> { [rideId]: (number | null)[24] }
export function rideTypicals(profiles) {
  const days = new Map();
  for (const profile of Object.values(profiles)) {
    for (const [rideId, hours] of Object.entries(profile)) {
      if (!days.has(rideId)) days.set(rideId, []);
      days.get(rideId).push(hours);
    }
  }
  return Object.fromEntries([...days].map(([rideId, series]) => [rideId, typicalByHour(series)]));
}

// How many headliners must post a wait for the crowd to be read: half of
// them, and never fewer than three, or it is a few rides' mood.
export const minPosting = (n) => Math.max(3, Math.ceil(n / 2));

// The park's usual big-ride wait for each hour: the average of its
// headliners' typical waits, where enough of them have one.
export function usualIndex(ids, typicals) {
  return Array.from({ length: 24 }, (_, h) => {
    const vals = ids.map((id) => typicals[id]?.[h]).filter((v) => v != null);
    return vals.length >= minPosting(ids.length) ? Math.round(mean(vals)) : null;
  });
}

// The crowd ratio: the posted waits of the headliners posting one, against
// the same rides' typical waits at this hour. 1 is a usual day.
//   waits: { [rideId]: minutes | null }, typicals: from rideTypicals
export function crowdRatio(waits, ids, typicals, hour) {
  let live = 0;
  let usual = 0;
  let n = 0;
  for (const id of ids) {
    const w = waits[id];
    const u = typicals[id]?.[hour];
    if (w == null || !u) continue;
    live += w;
    usual += u;
    n++;
  }
  return n >= minPosting(ids.length) ? live / usual : null;
}

// What a ratio reads as. The bands are wide on purpose: posted waits wobble
// by 10% from minute to minute on an ordinary day.
export const BUSIER = 1.15;
const CROWD_WORDS = [
  [0.85, 'Quieter than usual'],
  [BUSIER, 'About usual'],
  [1.4, 'Busier than usual'],
  [Infinity, 'Much busier than usual'],
];
export const crowdLabel = (ratio) => CROWD_WORDS.find(([max]) => ratio < max)[1];

// The crowd over the 15 minutes up to t, from readings [t, ratio, usual]
// (usual: the park's usual big-ride wait at that reading's hour), oldest
// first. index: the big-ride average that ratio stands for, in minutes.
export const SMOOTH_MS = 15 * 60_000;
export function smoothedCrowd(samples, t) {
  const recent = samples.filter(([at]) => at <= t && at > t - SMOOTH_MS);
  if (!recent.length) return null;
  return {
    ratio: mean(recent.map((x) => x[1])),
    index: Math.round(mean(recent.map((x) => x[1] * x[2]))),
  };
}

// The label shown changes only once two readings in a row agree on a new
// one, so it doesn't flick between two words at a boundary.
//   shown: { label, next } from the reading before, or null
export function settleLabel(shown, label) {
  if (!shown?.label || shown.label === label || shown.next === label) return { label, next: null };
  return { label: shown.label, next: label };
}

// Lines building: the big rides running at least a fifth further over their
// usual than half an hour ago, at least 10 minutes longer, and busier than
// usual now. The ratio already allows for waits that rise every day at this
// time, so an ordinary morning never counts. Both readings are smoothed.
export const BUILD_WINDOW_MS = 30 * 60_000;
export function linesBuilding(samples, now) {
  const cur = smoothedCrowd(samples, now);
  const then = smoothedCrowd(samples, now - BUILD_WINDOW_MS);
  if (!cur || !then) return null;
  const built = cur.ratio >= BUSIER && cur.ratio - then.ratio >= 0.2 && cur.index - then.index >= 10;
  return built ? { from: then.index, to: cur.index, ratio: cur.ratio } : null;
}
