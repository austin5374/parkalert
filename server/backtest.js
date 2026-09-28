// How good are the reopen ranges, measured on the archive itself. Each past
// outage is estimated as the app would have at the time, from earlier days
// only, and scored against when it really reopened. Pure, so the same code
// runs from `npm run backtest` and in the tests.
//
// A range is the middle half of comparable past outages, so about half of
// reopenings should land inside it: much more means ranges are wider than
// they need be, much less means they are overconfident. The other numbers
// are how wide the ranges are and how far off the middle guess was.

import { isResolved } from './episodes.js';
import { estimate, afterClearing } from './predict.js';
import { learnTraits, causeOf, clearedAt, clearanceOffsets } from './causes.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function score(rows) {
  if (!rows.length) return { n: 0 };
  const round = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    n: rows.length,
    inRange: round(rows.filter((r) => r.actual >= r.lo && r.actual <= r.hi).length / rows.length),
    width: round(median(rows.map((r) => r.hi - r.lo))),
    // Distances only for outages seen reopening; one that never did is
    // counted in the rates above but has no distance to measure.
    miss: round(median(rows.filter((r) => Number.isFinite(r.actual)).map((r) => Math.abs(r.actual - r.mid)))),
    within7: round(rows.filter((r) => Math.abs(r.actual - r.mid) <= 7.5).length / rows.length),
  };
}

// history: { [parkId]: episode[] }; tls: { [parkId]: { thunder, rain } }
// Returns { [group]: score } where groups compare the ordinary estimate with
// the weather-aware one on the same outages, at the same moment.
export function backtest(history, tls = {}) {
  const rows = {};
  const add = (group, r) => (rows[group] ??= []).push(r);
  for (const [parkId, all] of Object.entries(history)) {
    const tl = tls[parkId] || { thunder: [], rain: [] };
    const eps = all.filter((ep) => ep.kind !== 'blip' && ep.date).sort((a, b) => a.start - b.start);
    const days = [...new Set(eps.map((ep) => ep.date))].sort();
    for (const day of days) {
      const past = eps.filter((ep) => ep.date < day);
      if (!past.length) continue;
      const traits = learnTraits(past, tl);
      const offsets = { lightning: clearanceOffsets(past, traits, tl, 'lightning'), rain: clearanceOffsets(past, traits, tl, 'rain') };
      const withoutWeather = past.filter((ep) => !(ep.kind === 'breakdown' && causeOf(ep, traits, tl)));
      for (const ep of eps.filter((e) => e.date === day)) {
        // An outage that never reopened lasted at least ep.minutes. Once that
        // is past a range's top it is a known miss, and leaving such outages
        // out (as the live scorecard used to) flatters the method; before
        // the top it never got its answer and says nothing.
        const actual = isResolved(ep) ? ep.minutes : Infinity;
        const known = (est) => isResolved(ep) || ep.minutes > (est.p75 ?? est.p50);
        const cause = causeOf(ep, traits, tl);
        // At the moment it went down.
        const old = estimate({ [parkId]: past }, parkId, ep.rideId, 0, ep.kind);
        if (old?.p50 != null && known(old)) add(`${cause || ep.kind}: when it went down, old`, row(old, actual));
        if (!cause) {
          const cleaner = estimate({ [parkId]: withoutWeather }, parkId, ep.rideId, 0, ep.kind);
          if (cleaner?.p50 != null && known(cleaner)) add(`${ep.kind}: when it went down, weather outages left out`, row(cleaner, actual));
          continue;
        }
        if (!isResolved(ep)) continue; // the weather-cleared stage needs a reopening time
        // At the moment the weather cleared: what the app says then.
        const stop = ep.start + ep.minutes * 60_000;
        const c = clearedAt(cause, ep.start, stop, tl);
        if (c?.state !== 'passed' || c.end <= ep.start) continue;
        const elapsed = (c.end - ep.start) / 60_000;
        const afterClear = (stop - c.end) / 60_000;
        const oldThen = estimate({ [parkId]: past }, parkId, ep.rideId, elapsed, ep.kind);
        if (oldThen?.p50 != null) add(`${cause}: when the weather cleared, old`, row(oldThen, afterClear));
        const neu = afterClearing(offsets[cause], ep.rideId, 0, cause);
        if (neu?.p50 != null) add(`${cause}: when the weather cleared, new (${neu.basis === 'rule' ? '30-min rule' : 'learned'})`, row(neu, afterClear));
      }
    }
  }
  return Object.fromEntries(Object.entries(rows).sort().map(([k, v]) => [k, score(v)]));
}

function row(est, actual) {
  return { lo: est.p25 ?? est.p50, mid: est.p50, hi: est.p75 ?? est.p50, actual };
}
