// Reopen estimates from past DOWN episodes. Pure functions.
//
// The estimate is a range, never a countdown. In six days of Magic Kingdom
// history the median time left barely moved as an outage dragged on (about
// 24 min at the start, 21 min after 30 min down, 48 min after an hour), so a
// single "back at 3:40" would be wrong most of the time.
import { isResolved, stayedDown, isLateOpening, CLUSTER_WINDOW_MS, CLUSTER_MIN_RIDES } from './episodes.js';

// Minutes from now at which the chance of reopening is read off the curve.
export const CHANCE_AT = [15, 30, 60];

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
  // The chance it's back within 15, 30 and 60 minutes from now: the same
  // curve read at fixed times instead of fixed shares.
  const chance = Object.fromEntries(CHANCE_AT.map((h) => [h, 0]));
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
    for (const h of CHANCE_AT) if (t - elapsedMin <= h) chance[h] = 1 - survival;
  }
  return {
    ...quantiles,
    chance,
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

// Which kind of outage is this live DOWN ride? The poller settles it the
// first poll the ride is seen down (ride.liveKind, see rememberHolds in
// poller.js) and it stays that way until the ride reopens: once the others
// come back, the last ones still down are the same storm, and a breakdown
// already announced as one keeps its advice. A snapshot without that falls
// back to the same rule the history classifier uses.
// Returns { kind, rides, incident } where rides is the hold size for a 'hold'.
export function classifyLive(rides, rideId) {
  const ride = rides[rideId];
  if (isLateOpening({ from: ride?.downFrom })) return { kind: 'opening' };
  if (ride?.liveKind === 'hold') return { kind: 'hold', rides: ride.holdSize, incident: ride.incident ?? null };
  if (ride?.liveKind === 'breakdown') return { kind: 'breakdown' };
  return clusterLive(rides, rideId);
}

// The hold test on this snapshot alone, ignoring any remembered kind.
export function clusterLive(rides, rideId) {
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

// Before any park has enough history (a new server, a new park), a built-in
// prior stands in, and says so: outage lengths shaped like Walt Disney
// World's (breakdowns a median of 14 min, holds 49, delayed openings 20),
// as 60 evenly spread outages, the longest few breakdowns closing for the
// day. [median minutes, spread, share closed for the day]
const PRIOR_SHAPE = { breakdown: [14, 0.9, 0.05], hold: [49, 0.5, 0], opening: [20, 0.6, 0] };
const PRIOR_N = 60;
const PRIOR = Object.fromEntries(Object.entries(PRIOR_SHAPE).map(([kind, [median, spread, closed]]) => {
  const eps = Array.from({ length: PRIOR_N }, (_, i) => {
    const q = (i + 0.5) / PRIOR_N;
    // A logistic stand-in for the normal quantile: close enough for a prior.
    const minutes = Math.round(median * Math.exp(spread * 0.5513 * Math.log(q / (1 - q))) * 10) / 10;
    const stayed = i >= PRIOR_N * (1 - closed);
    return { rideId: null, kind, minutes: stayed ? Math.max(minutes, 90) : minutes, endedAs: stayed ? 'CLOSED' : 'OPERATING' };
  });
  return [kind, eps.sort(byMinutes)];
}));

// Pick the most specific history that has enough data, and estimate from it.
//   history: { [parkId]: episode[] }, kind: 'breakdown' | 'opening' | 'hold'
// Breakdowns and late openings use the ride's own record when it has enough,
// else the park's. A hold is a park-wide event, so it pools the park. Rarer
// kinds fall back to every park when this one has not seen enough of them.
// With no history to go on at all, the built-in prior, labelled as such.
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
  if (sawHistory) return { longerThanUsual: true, kind };
  const prior = PRIOR[kind];
  if (!prior) return null;
  if (prior.length - firstAbove(prior, elapsedMin) < MIN_SAMPLES) return { longerThanUsual: true, kind };
  const r = remainingSorted(prior, elapsedMin);
  return r && r.p50 !== null ? { ...r, basis: 'prior', kind } : { longerThanUsual: true, kind };
}

// Weather outages are timed from when the weather cleared, not from when the
// ride went down: that is when Disney's clock starts, so the spread is far
// smaller than "how long do outages last".

// Disney's practice: outdoor rides reopen about 30 minutes after the last
// lightning nearby, give or take the time to restart. Used only until the
// archive has enough storms here to say how it really goes.
export const LIGHTNING_RULE = { p25: 30, p50: 35, p75: 45 };
// A ride's own storms count once it has this many; else the park's.
export const RIDE_WEATHER_MIN = 5;

// Time left, given the weather cleared `sinceClearMin` ago.
//   offsets: past { rideId, minutes, endedAs } from clearanceOffsets()
export function afterClearing(offsets, rideId, sinceClearMin, cause) {
  const own = offsets.filter((o) => o.rideId === rideId);
  for (const [basis, eps, min] of [['ride', own, RIDE_WEATHER_MIN], ['park', offsets, MIN_SAMPLES]]) {
    if (eps.filter((e) => e.minutes > sinceClearMin).length < min) continue;
    const r = remaining(eps, sinceClearMin);
    if (r && r.p50 !== null) return { ...r, basis, kind: 'weather' };
  }
  if (cause === 'lightning' && sinceClearMin < LIGHTNING_RULE.p75) {
    const left = (m) => Math.max(1, m - sinceClearMin);
    return { p25: left(LIGHTNING_RULE.p25), p50: left(LIGHTNING_RULE.p50), p75: left(LIGHTNING_RULE.p75), n: 0, stayedDownShare: 0, basis: 'rule', kind: 'weather' };
  }
  return null;
}

// Time left while the storm (or rain) is still going on: how much longer
// spells like this one last here, plus the time to reopen once it clears.
// Adding the quartiles overstates the spread a little, which is the honest
// direction to be wrong in.
//   spellEps: past spells as { minutes, endedAs }; ageMin: this one so far
export function duringWeather(spellEps, ageMin, offsets, rideId, cause) {
  const left = spellEps.filter((e) => e.minutes > ageMin).length >= MIN_SAMPLES ? remaining(spellEps, ageMin) : null;
  const after = afterClearing(offsets, rideId, 0, cause);
  if (!left || left.p50 === null || !after) return null;
  // A quartile the data can't reach falls back to that side's median.
  return {
    p25: (left.p25 ?? left.p50) + (after.p25 ?? after.p50),
    p50: left.p50 + after.p50,
    p75: (left.p75 ?? left.p50) + (after.p75 ?? after.p50),
    n: after.n,
    stayedDownShare: after.stayedDownShare,
    basis: after.basis,
    kind: 'weather',
  };
}

// Round so the range reads like a person said it: exact under 15 min, then to 5.
function roundMin(m) {
  const v = Math.max(1, Math.round(m));
  return v < 15 ? v : Math.round(v / 5) * 5;
}

// The range as guests read it, in minutes from now: the same rounding as the
// text, so the card's bar, the sheet's clock times and the scorecard all
// measure what the alert said, not the unrounded quartiles behind it.
export function shownWindow(est) {
  if (!est || est.longerThanUsual) return null;
  const lo = roundMin(est.p25 ?? est.p50);
  const hi = est.p75 === null || est.p75 === undefined ? null : roundMin(est.p75);
  return hi !== null && hi > lo ? { lo, hi } : { lo: roundMin(est.p50), hi: null };
}

// Minutes the way a person says them: "40 min", past an hour "1 hr 30 min".
function spoken(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

// One short line for a push notification or the dashboard, or null.
// The range is the middle half of past outages like it, so it says "often",
// not "usually" or "likely". From the 30-minute lightning rule rather than
// this park's history, it says so instead of claiming a record.
export const LONG_TEXT = 'Down longer than nearly every past outage like it';
export function describe(est) {
  if (!est) return null;
  if (est.longerThanUsual) return LONG_TEXT;
  const w = shownWindow(est);
  const span = w.hi !== null
    ? (w.hi < 60 ? `${w.lo} to ${w.hi} min` : `${spoken(w.lo)} to ${spoken(w.hi)}`)
    : `about ${spoken(w.lo)}`;
  let text = est.basis === 'rule' ? `By the 30-minute lightning rule, back in ${span}` : `Often back in ${span}`;
  const pct = closedPct(est);
  if (pct >= 10) text += `. About ${pct}% stay closed for the day`;
  return text;
}

// The share closed for the day, as the one rounded percentage every line uses.
const closedPct = (est) => Math.round((est.stayedDownShare || 0) * 100);
export const CLOSED_PCT = 30;

// A chance as people say it. Ten or twenty outages can't make anything
// certain, so the ends are words, never 0% or 100%.
//   "Nearly all outages like this", "62% of outages like this"
export function shareOf(p, what = 'outages like this') {
  if (p >= 0.955) return `Nearly all ${what}`;
  if (p < 0.045) return `Almost no ${what}`;
  return `${Math.round(p * 100)}% of ${what}`;
}

// Wait nearby, or go ride something else? The question a guest actually has
// at a down ride, answered from the same curve as the range. The rules, in
// order, each with the reason it wins:
//   1. Past nearly every outage like it: ride something else.
//   2. Often closed for the day (30% or more): that dominates.
//   3. The park closes before half of these reopen: say so.
//   4. The chance it's back soon decides:
//        6 in 10 or more within 15 min  -> worth waiting nearby
//        half or more within 30 min      -> check back soon
//        half or more within the hour    -> ride something nearby
//        otherwise                        -> ride something else
// A weather estimate from the 30-minute rule has no curve; its range stands in.
//   est: from estimate()/afterClearing(); minutesToClose: or null
export function advise(est, { minutesToClose = null } = {}) {
  if (!est) return null;
  if (est.longerThanUsual) {
    return { key: 'long', verdict: 'Ride something else', detail: 'Outages this long rarely end soon.' };
  }
  const closed = closedPct(est);
  if (closed >= CLOSED_PCT) {
    return { key: 'closed', verdict: 'Often closed for the day', detail: `${closed}% of outages like this didn't reopen that day.` };
  }
  const p50 = est.p50 ?? est.p25;
  if (minutesToClose != null && p50 != null && p50 > minutesToClose) {
    return { key: 'closing', verdict: 'May not reopen before close', detail: `The park closes in ${spoken(Math.max(1, Math.round(minutesToClose)))}, and half of these take longer.` };
  }
  const c = est.chance;
  // The same numbers the card's legend shows beneath, in the same words.
  if (c) {
    if (c[15] >= 0.6) return { key: 'wait', verdict: 'Worth waiting nearby', detail: `${shareOf(c[15])} are over within 15 min.` };
    if (c[30] >= 0.5) return { key: 'soon', verdict: 'Check back soon', detail: `${shareOf(c[30])} are over within 30 min.` };
    if (c[60] >= 0.5) return { key: 'nearby', verdict: 'Ride something nearby', detail: `${shareOf(c[60])} are over within the hour.` };
    return { key: 'go', verdict: 'Ride something else', detail: c[60] >= 0.045 ? `Only ${shareOf(c[60])} are over within the hour.` : 'These usually take over an hour.' };
  }
  if (p50 == null) return null;
  if (p50 <= 12) return { key: 'wait', verdict: 'Worth waiting nearby', detail: `Often back within ${spoken(Math.round(p50))}.` };
  if (p50 <= 30) return { key: 'soon', verdict: 'Check back soon', detail: `Often back within ${spoken(Math.round(p50))}.` };
  if (p50 <= 60) return { key: 'nearby', verdict: 'Ride something nearby', detail: `Often back within ${spoken(Math.round(p50))}.` };
  return { key: 'go', verdict: 'Ride something else', detail: 'These usually take over an hour.' };
}
