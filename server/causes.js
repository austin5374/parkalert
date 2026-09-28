// Why a ride went down, as far as the weather can tell, and how long after
// the weather clears each ride reopens. Pure functions over the outage
// archive (server/episodes.js) and a park's storm and rain timelines
// (server/weather.js), so they can be tested alone.
//
// Lightning: Disney closes outdoor rides while lightning is nearby and waits
// about 30 minutes after the last strike before reopening them. The nearest
// stations' storm end is a stand-in for that last strike; how much later each
// ride actually reopens (the "offset") is learned from its own past storms.
// Rain: a few rides close for rain alone and reopen once the rain stops and
// the track dries. Test Track's outdoor loop is the known one; others are
// learned from outages that start in rain without lightning.

import { isResolved } from './episodes.js';

// Rides known to close for rain as well as lightning.
export const RAIN_RIDES = [/test track/i];

// An outage starting this soon before a storm or shower is logged still
// counts as caused by it: rides close as lightning approaches, before the
// station 10 miles away reports it.
export const LEAD_MS = 15 * 60_000;
// A ride needs this many days of weather outages to count as weather-exposed.
export const TRAIT_MIN_DAYS = 2;

// The spell (if any) in progress at time t, allowing for the lead above.
export function spellCovering(list, t, lead = LEAD_MS) {
  for (const s of list) {
    if (s.start - lead > t) break;
    if (s.end === null || s.end >= t) return s;
  }
  return null;
}

// Which rides the weather shuts, learned from the archive.
//   weather: went down in park-wide holds, or as storms arrived, on 2+ days
//   rain: went down in rain with no lightning around, on 2+ days (plus
//     the rides known to, by name)
export function learnTraits(episodes, tl) {
  const stormDays = new Map();
  const rainDays = new Map();
  const add = (m, id, day) => (m.get(id) || m.set(id, new Set()).get(id)).add(day);
  const rain = new Set();
  for (const ep of episodes) {
    if (ep.kind === 'blip') continue;
    const day = ep.date ?? new Date(ep.start).toISOString().slice(0, 10);
    const storm = spellCovering(tl.thunder, ep.start);
    if (ep.kind === 'hold' || storm) add(stormDays, ep.rideId, day);
    if (!storm && !spellCovering(tl.thunder, ep.start, 30 * 60_000) && spellCovering(tl.rain, ep.start)) add(rainDays, ep.rideId, day);
    if (RAIN_RIDES.some((re) => re.test(ep.rideName || ''))) rain.add(ep.rideId);
  }
  const weather = new Set([...stormDays].filter(([, d]) => d.size >= TRAIT_MIN_DAYS).map(([id]) => id));
  for (const [id, d] of rainDays) if (d.size >= TRAIT_MIN_DAYS) rain.add(id);
  return { weather, rain };
}

const isRainRide = (rideId, rideName, traits) => traits.rain.has(rideId) || RAIN_RIDES.some((re) => re.test(rideName || ''));

// Why this outage: 'rain', 'lightning', or null when the weather doesn't
// explain it. A rain-sensitive ride in rain is 'rain' even in a storm, since
// it waits for a dry track after the lightning clears too.
//   o: { rideId, rideName, start, kind }
export function causeOf(o, traits, tl) {
  const storm = spellCovering(tl.thunder, o.start);
  if (isRainRide(o.rideId, o.rideName, traits) && (spellCovering(tl.rain, o.start) || storm)) return 'rain';
  if (storm && (o.kind === 'hold' || traits.weather.has(o.rideId))) return 'lightning';
  return null;
}

// When the weather that shut the ride cleared, as seen at time t: the end
// of the last storm (and, for rain, the last shower) that began before t,
// since the ride went down. A ride closed through two storms reopens after
// the second. Returns { state: 'ongoing' } while it continues, or
// { state: 'passed', end }. `what` says whether the storm or the rain is
// what's still going on.
export function clearedAt(cause, since, t, tl) {
  const lists = cause === 'rain' ? [tl.thunder, tl.rain] : [tl.thunder];
  let end = -Infinity;
  for (const list of lists) {
    for (const s of list) {
      if (s.start > t) break;
      if (s.end !== null && s.end < since - LEAD_MS) continue;
      if (s.end === null || s.end > t) return { state: 'ongoing', since: s.start, what: list === tl.rain ? 'rain' : 'thunder' };
      end = Math.max(end, s.end);
    }
  }
  return end > -Infinity ? { state: 'passed', end } : null;
}

// How long after the weather cleared each past weather outage reopened, in
// the { minutes, endedAs } shape the Kaplan-Meier estimate takes. An outage
// that never reopened that day counts as "at least this long".
export function clearanceOffsets(episodes, traits, tl, cause) {
  const out = [];
  for (const ep of episodes) {
    if (ep.kind === 'blip' || causeOf(ep, traits, tl) !== cause) continue;
    const stop = ep.start + ep.minutes * 60_000;
    const c = clearedAt(cause, ep.start, stop, tl);
    if (c?.state !== 'passed') continue;
    out.push({ rideId: ep.rideId, minutes: Math.round((stop - c.end) / 6000) / 10, endedAs: isResolved(ep) ? 'OPERATING' : null });
  }
  return out;
}

// How long past storms (or showers) lasted here, for the same shape.
export function spellDurations(list) {
  return list.filter((s) => s.end !== null).map((s) => ({ minutes: (s.end - s.start) / 60_000, endedAs: 'OPERATING' }));
}
