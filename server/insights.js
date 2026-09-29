// The numbers behind the ride and park detail sheets. Pure functions over the
// local outage archive and the live park state, so they can be tested alone.
import { isResolved } from './episodes.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const real = (ep) => ep.kind !== 'blip';

// Wait-time samples, recorded only when the value changes. null means the ride
// was not posting a wait (down, closed), which the chart draws as a gap.
// gapFrom: when polling had stopped, the time it stopped; the series gets a
// null there so the chart shows a gap instead of a stale wait.
export const WAIT_KEEP_MS = 18 * 3600_000;
export function recordWaits(waits = {}, rides, now = Date.now(), gapFrom = null) {
  const next = {};
  for (const [id, r] of Object.entries(rides)) {
    const value = r.status === 'OPERATING' ? r.waitTime ?? null : null;
    const series = (waits[id] || []).filter(([t]) => now - t < WAIT_KEEP_MS);
    if (gapFrom !== null && series.length && series[series.length - 1][1] !== null && gapFrom < now) {
      series.push([gapFrom, null]);
    }
    const last = series[series.length - 1];
    if (!last || last[1] !== value) series.push([now, value]);
    next[id] = series;
  }
  return next;
}

// Per-day outage totals for the most recent archived days, oldest first. Days
// the archive holds with no outage for this ride show as zero, not missing.
export function outageDays(episodes, rideId, fetchedDates, days = 7) {
  const dates = [...new Set(fetchedDates)].sort().slice(-days);
  return dates.map((date) => {
    const eps = episodes.filter((ep) => ep.rideId === rideId && ep.date === date && real(ep));
    return { date, outages: eps.length, minutes: Math.round(eps.reduce((n, ep) => n + ep.minutes, 0)) };
  });
}

// The ride's record over the same recent archive days the day chart shows,
// so "Last 7 days" never quotes a typical or longest outage from months ago.
export function rideHistory(episodes, rideId, fetchedDates, days = 7) {
  const recent = new Set([...new Set(fetchedDates)].sort().slice(-days));
  const mine = episodes.filter((ep) => ep.rideId === rideId && real(ep) && recent.has(ep.date));
  // Typical and longest are for breakdowns: a storm hold or a late opening
  // runs to a different clock, and mixing two hour-long holds with a
  // 16-minute breakdown read "Typical 1 hr 1 min".
  const resolved = mine.filter((ep) => ep.kind === 'breakdown' && isResolved(ep)).map((ep) => ep.minutes);
  return {
    days: outageDays(episodes, rideId, fetchedDates, days),
    archivedDays: new Set(fetchedDates).size,
    outages: mine.length,
    holds: mine.filter((ep) => ep.kind === 'hold').length,
    typicalMinutes: resolved.length ? Math.round(median(resolved)) : null,
    // Only outages seen reopening: one that never did is censored at the end
    // of the park day, so its "length" can be a night spent closed.
    longestMinutes: resolved.length ? Math.round(Math.max(...resolved)) : null,
    last: [...mine].sort((a, b) => b.start - a.start).slice(0, 6)
      .map(({ start, minutes, kind, endedAs }) => ({ start, minutes: Math.round(minutes), kind, reopened: endedAs === 'OPERATING' })),
  };
}

// Outages that began today (park-local): each one seen going down, plus
// rides down now whose outage began today but was never seen starting
// (already down at the first poll after a restart, or before the app
// looked). A ride seen going down during its current outage counts once.
export function outagesToday(recent = [], rides = {}, dayStart) {
  const downs = recent.filter((e) => e.type === 'DOWN' && e.at >= dayStart);
  let count = downs.length;
  const ids = new Set(downs.map((e) => e.id));
  for (const [id, r] of Object.entries(rides)) {
    if (r.status !== 'DOWN' || !(r.downSince >= dayStart)) continue;
    if (downs.some((e) => e.id === id && e.at >= r.downSince - 60_000)) continue;
    count++;
    ids.add(id);
  }
  return { downs: count, rides: ids.size };
}

// Today's transitions for one ride, oldest first.
export function rideToday(recent = [], rideId, dayStart) {
  return recent.filter((e) => e.id === rideId && e.at >= dayStart).sort((a, b) => a.at - b.at)
    .map(({ type, at, downtimeMs, late }) => ({ type, at, downtimeMs, ...(late ? { late } : {}) }));
}

// Park-wide summary: which rides have been least reliable lately, and how long
// a typical breakdown here lasts.
export function parkSummary(episodes, fetchedDates, names, days = 7) {
  const dates = new Set([...new Set(fetchedDates)].sort().slice(-days));
  const window = episodes.filter((ep) => dates.has(ep.date) && real(ep));
  const byRide = new Map();
  for (const ep of window) {
    const r = byRide.get(ep.rideId) || { id: ep.rideId, name: names[ep.rideId] || ep.rideName, outages: 0, minutes: 0 };
    r.outages++;
    r.minutes += ep.minutes;
    byRide.set(ep.rideId, r);
  }
  const breakdowns = window.filter((ep) => ep.kind === 'breakdown' && isResolved(ep)).map((ep) => ep.minutes);
  const holdDays = new Set(window.filter((ep) => ep.kind === 'hold').map((ep) => ep.date));
  return {
    days: dates.size,
    outages: window.length,
    typicalBreakdownMinutes: breakdowns.length ? Math.round(median(breakdowns)) : null,
    holdDays: holdDays.size,
    leastReliable: [...byRide.values()]
      .sort((a, b) => b.outages - a.outages || b.minutes - a.minutes)
      .slice(0, 5)
      .map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
  };
}

// Is the line growing or shrinking? The posted wait now against the one in
// effect half an hour ago. Posted waits step in fives and wobble a step
// either way all day, so a trend takes at least two steps (10 min), and a
// quarter of the wait: 110 to 120 is a long line wobbling, 20 to 30 is one
// growing by half. Less reads as steady (null). No trend without both
// readings, or while the ride isn't posting one.
export const TREND_WINDOW_MS = 30 * 60_000;
export const TREND_MIN_CHANGE = 10;
export const TREND_MIN_SHARE = 0.25;
export function waitTrend(series = [], now = Date.now()) {
  const last = series[series.length - 1];
  if (!last || last[1] == null) return null;
  let then = null;
  for (const [t, v] of series) {
    if (t > now - TREND_WINDOW_MS) break;
    then = v;
  }
  if (then == null) return null;
  const change = last[1] - then;
  if (Math.abs(change) < Math.max(TREND_MIN_CHANGE, then * TREND_MIN_SHARE)) return null;
  return { direction: change > 0 ? 'up' : 'down', change };
}
