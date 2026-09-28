// The numbers behind the ride and park detail sheets. Pure functions over the
// local outage archive and the live park state, so they can be tested alone.
import { isResolved } from './episodes.js';

const DAY_MS = 24 * 3600_000;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const real = (ep) => ep.kind !== 'blip';

// Wait-time samples, recorded only when the value changes. null means the ride
// was not posting a wait (down, closed), which the chart draws as a gap.
export const WAIT_KEEP_MS = 18 * 3600_000;
export function recordWaits(waits = {}, rides, now = Date.now()) {
  const next = {};
  for (const [id, r] of Object.entries(rides)) {
    const value = r.status === 'OPERATING' ? r.waitTime ?? null : null;
    const series = (waits[id] || []).filter(([t]) => now - t < WAIT_KEEP_MS);
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

export function rideHistory(episodes, rideId, fetchedDates) {
  const mine = episodes.filter((ep) => ep.rideId === rideId && real(ep));
  const resolved = mine.filter(isResolved).map((ep) => ep.minutes);
  return {
    days: outageDays(episodes, rideId, fetchedDates),
    archivedDays: new Set(fetchedDates).size,
    outages: mine.length,
    typicalMinutes: resolved.length ? Math.round(median(resolved)) : null,
    longestMinutes: mine.length ? Math.round(Math.max(...mine.map((ep) => ep.minutes))) : null,
    last: [...mine].sort((a, b) => b.start - a.start).slice(0, 6)
      .map(({ start, minutes, kind, endedAs }) => ({ start, minutes: Math.round(minutes), kind, reopened: endedAs === 'OPERATING' })),
  };
}

// Today's transitions for one ride, oldest first.
export function rideToday(recent = [], rideId, dayStart) {
  return recent.filter((e) => e.id === rideId && e.at >= dayStart).sort((a, b) => a.at - b.at)
    .map(({ type, at, downtimeMs }) => ({ type, at, downtimeMs }));
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

// Midnight in the park's zone, as epoch ms, for "today" filters.
export function parkDayStart(timezone, now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)])
  );
  const sinceMidnight = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
  return now - sinceMidnight - (now % 1000);
}

export { DAY_MS };
