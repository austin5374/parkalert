// Weather-aware reopen estimates for live outages: ties the outage archive,
// the weather timelines and the pure rules in causes.js and predict.js to
// what the dashboard and alerts ask about a down ride.
import { history } from './store.js';
import { timelines, STALE_MS, onNewReports } from './weather.js';
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

// New reports change the weather timelines of the parks they come from.
// Their models are rebuilt straight after, off any request: with a year of
// archive that is tens of milliseconds a park, which the next dashboard (or
// a push) used to pay for every park at once.
// One park a turn, so requests can run in between.
onNewReports((parkIds) => {
  for (const id of parkIds) setImmediate(() => { if (history.episodes[id]) model(id); });
});

// The outage archive with weather outages taken out of the breakdowns, for
// the ordinary estimates. The same object while nothing under it changes,
// so the estimates' own caches (keyed by it) hold; each park's part is
// worked out only when read, since most estimates read their own park only.
let memo = null; // { key: [[parkId, eps, len, tl]], out }
export function modelHistory() {
  const key = Object.keys(history.episodes).map((id) => [id, history.episodes[id], history.episodes[id].length, timelines(id)]);
  const same = memo && memo.key.length === key.length
    && memo.key.every((k, i) => k.every((v, j) => v === key[i][j]));
  if (same) return memo.out;
  const out = {};
  for (const [parkId] of key) {
    Object.defineProperty(out, parkId, { enumerable: true, get: () => model(parkId).withoutWeather });
  }
  memo = { key, out };
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
