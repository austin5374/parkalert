// Reopen estimates from past DOWN episodes. Pure functions.
//
// The estimate is a range, never a countdown. In six days of Magic Kingdom
// history the median time left barely moved as an outage dragged on (about
// 24 min at the start, 21 min after 30 min down, 48 min after an hour), so a
// single "back at 3:40" would be wrong most of the time.
import { isResolved, stayedDown, isLateOpening, CLUSTER_WINDOW_MS, CLUSTER_MIN_RIDES } from './episodes.js';

// Below this many comparable past outages we say nothing rather than guess.
export const MIN_SAMPLES = 5;
// A ride needs this many of its own outages before its history is trusted over
// the park-wide pool. Most rides only break a handful of times a week.
export const RIDE_MIN_SAMPLES = 8;

// Kaplan-Meier estimate of the time remaining, given the ride has already been
// down `elapsedMin`. Censored episodes (never seen reopening) count as "at
// least this long" instead of being dropped, which would bias estimates short,
// or counted as reopenings, which would bias them shorter still.
// Returns null when fewer than MIN_SAMPLES outages lasted this long.
export function remaining(episodes, elapsedMin) {
  return remainingSorted([...episodes].sort(byMinutes), elapsedMin);
}

const byMinutes = (a, b) => a.minutes - b.minutes;

// Index of the first episode that lasted longer than `min`, in a list sorted
// by minutes: everything from there on is still "at risk" at `min`.
function firstAbove(sorted, min) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].minutes > min) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// remaining() over a list already sorted by minutes. One sweep, no sorting:
// a year of park-wide history is thousands of outages and this runs for every
// down ride on every dashboard refresh.
function remainingSorted(all, elapsedMin) {
  const sorted = all.slice(firstAbove(all, elapsedMin));
  if (sorted.length < MIN_SAMPLES) return null;
  const quantiles = { p25: null, p50: null, p75: null };
  const targets = [['p25', 0.25], ['p50', 0.5], ['p75', 0.75]];
  let survival = 1;
  for (let i = 0; i < sorted.length; ) {
    const t = sorted[i].minutes;
    const n = sorted.length - i; // still down at t
    let d = 0;
    for (; i < sorted.length && sorted[i].minutes === t; i++) if (isResolved(sorted[i])) d++;
    if (!d) continue;
    survival *= 1 - d / n;
    for (const [key, q] of targets) {
      if (quantiles[key] === null && 1 - survival >= q) quantiles[key] = t - elapsedMin;
    }
  }
  return {
    ...quantiles,
    n: sorted.length,
    stayedDownShare: sorted.filter(stayedDown).length / sorted.length,
  };
}

// Each park's archive grouped by kind, then by ride, every list sorted by
// minutes. Built once per archive change (a new day appends, a prune
// replaces the array) instead of filtering and sorting on every estimate.
const EMPTY = { all: [], byRide: new Map() };
const indexes = new WeakMap(); // episodes array -> { length, kinds: Map(kind -> { all, byRide }) }
function byKind(episodes, kind) {
  let idx = indexes.get(episodes);
  if (!idx || idx.length !== episodes.length) {
    idx = { length: episodes.length, kinds: new Map() };
    for (const ep of [...episodes].sort(byMinutes)) {
      let k = idx.kinds.get(ep.kind);
      if (!k) idx.kinds.set(ep.kind, (k = { all: [], byRide: new Map() }));
      k.all.push(ep);
      let r = k.byRide.get(ep.rideId);
      if (!r) k.byRide.set(ep.rideId, (r = []));
      r.push(ep);
    }
    indexes.set(episodes, idx);
  }
  return idx.kinds.get(kind) || EMPTY;
}

// Every park's episodes of one kind, sorted; reused until any park's changes.
const pooled = new WeakMap(); // history -> { [kind]: { parts, list } }
function everywhere(history, kind) {
  const parts = Object.values(history).map((eps) => byKind(eps, kind).all);
  const cached = pooled.get(history)?.[kind];
  if (cached && cached.parts.length === parts.length && cached.parts.every((p, i) => p === parts[i])) return cached.list;
  const list = parts.flat().sort(byMinutes);
  pooled.set(history, { ...pooled.get(history), [kind]: { parts, list } });
  return list;
}

// Which kind of outage is this live DOWN ride? Same rules the history
// classifier uses, applied to current park state (rides: parkState[p].rides).
// Returns { kind, rides } where rides is the hold size for a 'hold'.
export function classifyLive(rides, rideId) {
  const ride = rides[rideId];
  if (isLateOpening({ from: ride?.downFrom })) return { kind: 'opening' };
  if (ride?.status === 'DOWN' && ride.downSince) {
    const together = Object.values(rides).filter(
      (r) =>
        r.status === 'DOWN' &&
        r.downSince &&
        !isLateOpening({ from: r.downFrom }) &&
        Math.abs(r.downSince - ride.downSince) <= CLUSTER_WINDOW_MS
    );
    if (together.length >= CLUSTER_MIN_RIDES) return { kind: 'hold', rides: together.length };
  }
  return { kind: 'breakdown' };
}

// Pick the most specific history that has enough data, and estimate from it.
//   history: { [parkId]: episode[] }, kind: 'breakdown' | 'opening' | 'hold'
// Breakdowns and late openings use the ride's own record when it has enough,
// else the park's. A hold is a park-wide event, so it pools the park. Rarer
// kinds fall back to every park when this one has not seen enough of them.
export function estimate(history, parkId, rideId, elapsedMin, kind) {
  const park = byKind(history[parkId] || [], kind);
  // Pools are built only if reached: most estimates stop at the ride or park.
  const ride = ['ride', () => park.byRide.get(rideId) || [], RIDE_MIN_SAMPLES];
  const all = ['all parks', () => everywhere(history, kind)];
  const pools = {
    breakdown: [ride, ['park', () => park.all]],
    opening: [ride, ['park', () => park.all], all],
    hold: [['park', () => park.all], all],
  }[kind];

  let sawHistory = false;
  for (const [basis, get, min = MIN_SAMPLES] of pools) {
    const eps = get();
    if (eps.length >= min) sawHistory = true;
    if (eps.length - firstAbove(eps, elapsedMin) < min) continue;
    const r = remainingSorted(eps, elapsedMin);
    if (r && r.p50 !== null) return { ...r, basis, kind };
  }
  // Enough history exists, but almost nothing in it ran this long.
  return sawHistory ? { longerThanUsual: true, kind } : null;
}

// Round so the range reads like a person said it: exact under 15 min, then to 5.
function roundMin(m) {
  const v = Math.max(1, Math.round(m));
  return v < 15 ? v : Math.round(v / 5) * 5;
}

// One short line for a push notification or the dashboard, or null.
export function describe(est) {
  if (!est) return null;
  if (est.longerThanUsual) return 'Down longer than most outages here';
  const lo = roundMin(est.p25 ?? est.p50);
  const hi = est.p75 === null ? null : roundMin(est.p75);
  let text = hi !== null && hi > lo
    ? `Usually back in ${lo} to ${hi} min`
    : `Usually back in about ${roundMin(est.p50)} min`;
  const pct = Math.round(est.stayedDownShare * 100);
  if (pct >= 10) text += `. About ${pct}% stay closed for the day`;
  return text;
}
