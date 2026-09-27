// Reopen estimates from past DOWN episodes. Pure functions.
//
// The estimate is a range, never a countdown. In six days of Magic Kingdom
// history the median time left barely moved as an outage dragged on (about
// 24 min at the start, 21 min after 30 min down, 48 min after an hour), so a
// single "back at 3:40" would be wrong most of the time.
import { isResolved, stayedDown, CLUSTER_WINDOW_MS, CLUSTER_MIN_RIDES } from './episodes.js';

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

  const eventTimes = [...new Set(atRisk.filter(isResolved).map((ep) => ep.minutes))].sort((a, b) => a - b);
  const quantiles = { p25: null, p50: null, p75: null };
  const targets = [['p25', 0.25], ['p50', 0.5], ['p75', 0.75]];
  let survival = 1;
  for (const t of eventTimes) {
    const n = atRisk.filter((ep) => ep.minutes >= t).length;
    const d = atRisk.filter((ep) => isResolved(ep) && ep.minutes === t).length;
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

// Is this DOWN ride part of a weather hold right now? Same rule the history
// classifier uses: at least CLUSTER_MIN_RIDES rides (this one included) went
// down within CLUSTER_WINDOW_MS of each other.
export function weatherHold(rides, rideId) {
  const ride = rides[rideId];
  if (ride?.status !== 'DOWN' || !ride.downSince) return null;
  const together = Object.values(rides).filter(
    (r) => r.status === 'DOWN' && r.downSince && Math.abs(r.downSince - ride.downSince) <= CLUSTER_WINDOW_MS
  );
  return together.length >= CLUSTER_MIN_RIDES ? { rides: together.length } : null;
}

// Pick the most specific history that has enough data, and estimate from it.
//   history: { [parkId]: episode[] }
// Breakdowns use the ride's own record when it has enough, else the park's.
// Weather holds are a park-wide event, so they always pool the park, and fall
// back to every park when this one has not had enough storms yet.
export function estimate(history, parkId, rideId, elapsedMin, weather) {
  const kind = weather ? 'weather' : 'breakdown';
  const park = (history[parkId] || []).filter((ep) => ep.kind === kind);
  const pools = weather
    ? [['park', park], ['all parks', Object.values(history).flat().filter((ep) => ep.kind === kind)]]
    : [['ride', park.filter((ep) => ep.rideId === rideId), RIDE_MIN_SAMPLES], ['park', park]];

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
