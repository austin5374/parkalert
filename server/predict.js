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
  const atRisk = episodes.filter((ep) => ep.minutes > elapsedMin);
  if (atRisk.length < MIN_SAMPLES) return null;

  // One sorted sweep: a year of park-wide history is thousands of outages and
  // this runs on every dashboard refresh.
  const sorted = [...atRisk].sort((a, b) => a.minutes - b.minutes);
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
    n: atRisk.length,
    stayedDownShare: atRisk.filter(stayedDown).length / atRisk.length,
  };
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
  const park = (history[parkId] || []).filter((ep) => ep.kind === kind);
  const everywhere = () => Object.values(history).flat().filter((ep) => ep.kind === kind);
  const ride = ['ride', park.filter((ep) => ep.rideId === rideId), RIDE_MIN_SAMPLES];
  const pools = {
    breakdown: [ride, ['park', park]],
    opening: [ride, ['park', park], ['all parks', everywhere()]],
    hold: [['park', park], ['all parks', everywhere()]],
  }[kind];

  let sawHistory = false;
  for (const [basis, eps, min = MIN_SAMPLES] of pools) {
    if (eps.length >= min) sawHistory = true;
    if (eps.filter((ep) => ep.minutes > elapsedMin).length < min) continue;
    const r = remaining(eps, elapsedMin);
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
