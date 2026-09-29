// Weather-aware reopen estimates for live outages: ties the outage archive,
// the weather timelines and the pure rules in causes.js and predict.js to
// what the dashboard and alerts ask about a down ride.
import { history } from './store.js';
import { timelines, STALE_MS } from './weather.js';
import { learnTraits, causeOf, clearedAt, clearanceOffsets, spellDurations, spellCovering, RAIN_RIDES } from './causes.js';
import { afterClearing, duringWeather } from './predict.js';

// What each park's archive says about weather, rebuilt only when the archive
// or the reports change (both are replaced or grow when they do).
const models = new Map(); // parkId -> { eps, len, tl, traits, offsets, durations, withoutWeather }
function model(parkId) {
  const eps = history.episodes[parkId] || [];
  const tl = timelines(parkId);
  const m = models.get(parkId);
  if (m && m.eps === eps && m.len === eps.length && m.tl === tl) return m;
  const traits = learnTraits(eps, tl);
  const next = {
    eps,
    len: eps.length,
    tl,
    traits,
    offsets: { lightning: clearanceOffsets(eps, traits, tl, 'lightning'), rain: clearanceOffsets(eps, traits, tl, 'rain') },
    durations: { thunder: spellDurations(tl.thunder), rain: spellDurations(tl.rain) },
    // Breakdown estimates should come from breakdowns: a ride shut by a storm
    // is out for as long as the storm, which would stretch every range.
    withoutWeather: eps.filter((ep) => !(ep.kind === 'breakdown' && causeOf(ep, traits, tl))),
  };
  models.set(parkId, next);
  return next;
}

// The outage archive with weather outages taken out of the breakdowns, for
// the ordinary estimates.
export function modelHistory() {
  const out = {};
  for (const parkId of Object.keys(history.episodes)) out[parkId] = model(parkId).withoutWeather;
  return out;
}

// Is the weather why this ride is down, and if so what does that say?
//   ride: { name, downSince }, kind: the live outage kind
// Returns null when the weather doesn't explain it, or when there are no
// recent reports to say (the ordinary estimate then stands). Otherwise
//   { cause: 'lightning' | 'rain', weather: 'ongoing' | 'passed',
//     clearedAt?, since?, est }  (est may be null)
//   shared: estimate for a whole hold, from the park's storms rather than
//     this ride's own, so every ride in the hold says the same thing
export function weatherOutlook(parkId, rideId, ride, kind, now = Date.now(), { shared = false } = {}) {
  if (!ride?.downSince) return null;
  const m = model(parkId);
  if (!(now - m.tl.latest < STALE_MS)) return null;
  const cause = causeOf({ rideId, rideName: ride.name, start: ride.downSince, kind }, m.traits, m.tl);
  if (!cause) return null;
  const c = clearedAt(cause, ride.downSince, now, m.tl);
  if (!c) return null;
  if (c.state === 'passed') {
    return { cause, weather: 'passed', clearedAt: c.end, est: afterClearing(m.offsets[cause], shared ? null : rideId, (now - c.end) / 60_000, cause) };
  }
  const durations = c.what === 'rain' ? m.durations.rain : m.durations.thunder;
  return {
    cause,
    weather: 'ongoing',
    what: c.what,
    since: c.since,
    est: duringWeather(durations, (now - c.since) / 60_000, m.offsets[cause], shared ? null : rideId, cause),
  };
}

// Which rides this park's archive shows the weather shutting, for the app.
export function parkTraits(parkId) {
  const { traits } = model(parkId);
  return { weather: [...traits.weather], rain: [...traits.rain] };
}

// Did the stations report lightning near the park at time t (allowing for
// the lead, see causes.js)? Only with current reports; without them, no.
export function stormAt(parkId, t, now = Date.now()) {
  const tl = timelines(parkId);
  if (!(now - tl.latest < STALE_MS)) return false;
  return !!spellCovering(tl.thunder, t);
}

// Rides that wait for a dry track as well as for the lightning to pass.
export function rainSensitive(parkId, rideId, rideName) {
  const { traits } = model(parkId);
  return traits.rain.has(rideId) || RAIN_RIDES.some((re) => re.test(rideName || ''));
}
