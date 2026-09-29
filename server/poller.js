import { fetchLiveAttractions, fetchSchedule } from './themeparks.js';
import { deliver } from './deliver.js';
import { APP_URL } from './config.js';
import { trips, parkState, saveState, saveTrips, activeParkIds, isTripActive } from './store.js';
import { dueWaitAlerts, pruneWaitAlerts, waitAlertMessage } from './waitalerts.js';
import { getPark } from './parks.js';
import { estimate, describe, shownWindow, classifyLive, advise } from './predict.js';
import { weatherOutlook, modelHistory, stormAt, rainSensitive } from './weatheroutlook.js';
import { refreshWeather } from './weather.js';
import { isLateOpening, CLUSTER_WINDOW_MS, CLUSTER_MIN_RIDES } from './episodes.js';
import { recordWaits } from './insights.js';
import { liveIndex, parkCrowd } from './crowdstate.js';
import { linesBuilding } from './crowds.js';
import { recordCalls, scoreCalls } from './scorecard.js';
import { gateEvents, gateSnapshot, restoreGate, forgetPending, pendingUpFor } from './gate.js';
import {
  localTime, downMessage, upMessage, closedMessage, groupMessage, groupOutlook,
  incidentDownMessage, incidentGrewMessage, incidentUpMessage, goneMessage, LONG_OUTAGE_MS,
} from './messages.js';
import { localDate } from './time.js';
import { currentSchedule, isParkClosed, hoursDisagree } from './parkstatus.js';

// POLL_MS exists for the stress lab (npm run lab); real use keeps 60s.
const POLL_INTERVAL_MS = Number(process.env.POLL_MS) || 60_000;
// A ride missing from a response keeps its last state this many polls before
// it is dropped, so one patchy response can't restart its outage clock.
export const MISSING_POLLS = 5;
// A ride that is down when it leaves the feed is kept this long, so its
// return is still "back up"; past it, phones are told it is no longer listed
// rather than left believing "is down" for the rest of the day.
export const MISSING_DOWN_MS = 30 * 60_000;
// A poll this many intervals after the last good one is a gap: changes seen
// on it happened sometime in between, and pushes say so.
const GAP_POLLS = 2.5;
// A ride that closes while down is still on the same outage if it reopens
// within this long: "back up" then says how long it was really out. Past
// it (reopening next morning, say) it had simply closed for the day.
export const CLOSED_OUTAGE_MS = 8 * 3600_000;

// Pure transition detection so it can be tested without the network.
// Returns { rides, events } where events = [{ type: 'DOWN'|'UP'|'CLOSED', ride, downtimeMs }].
//   stormAt(t): whether the weather reported lightning nearby at t, which
//     lets rides already settled as breakdowns join a hold (see rememberHolds)
//   prevPoll: when the last good poll was; after a gap, a change is only
//     known to have happened since then
export function applyLiveData(prevRides, liveAttractions, now = Date.now(), { stormAt = null, prevPoll = null, pollMs = POLL_INTERVAL_MS } = {}) {
  const rides = {};
  const changes = []; // [type, id, extra], turned into events once kinds are settled
  const gap = prevPoll != null && now - prevPoll > GAP_POLLS * pollMs;
  for (const att of liveAttractions) {
    const prev = prevRides?.[att.id];
    const ride = {
      name: att.name,
      status: att.status,
      waitTime: att.waitTime,
      ...(att.singleRider ? { singleRider: true } : {}),
      ...(att.lightningLane ? { lightningLane: att.lightningLane } : {}),
      since: prev && prev.status === att.status ? prev.since : now,
      downSince: null,
      downFrom: null, // status it went DOWN from; CLOSED means it never opened
    };
    // Still on an outage that began earlier: down, or closed while down.
    const outage = prev && (prev.status === 'DOWN' || (prev.closedWhileDown && now - prev.downSince < CLOSED_OUTAGE_MS))
      ? prev
      : null;
    if (att.status === 'DOWN') {
      ride.downSince = outage ? outage.downSince : now;
      ride.downFrom = outage ? outage.downFrom ?? null : prev?.status ?? null;
      // When it went down is exact only if the change was seen between two
      // polls in a row: not on a first sight, nor after a gap.
      if (outage ? outage.downExact === false : !prev || gap) {
        ride.downExact = false;
        const after = outage ? outage.downAfter ?? null : prev && gap ? prevPoll : null;
        if (after != null) ride.downAfter = after;
      }
      if (outage?.liveKind) {
        ride.liveKind = outage.liveKind;
        if (outage.holdSize) ride.holdSize = outage.holdSize;
        if (outage.incident) ride.incident = outage.incident;
      }
    }
    if (att.status === 'CLOSED' && outage) {
      ride.downSince = outage.downSince;
      ride.downFrom = outage.downFrom ?? null;
      ride.closedWhileDown = true;
      if (outage.incident) ride.incident = outage.incident;
    }
    if (prev && prev.status !== att.status) {
      if (prev.status === 'OPERATING' && att.status === 'DOWN') {
        changes.push(['DOWN', att.id, gap ? { after: prevPoll } : {}]);
      } else if (outage && att.status === 'OPERATING') {
        // After a gap, or when the start was never seen, the length is a range.
        const uncertain = gap || outage.downExact === false;
        const lo = outage.downSince ? (gap ? prevPoll : now) - outage.downSince : null;
        const from = outage.downExact === false ? outage.downAfter ?? null : outage.downSince;
        changes.push(['UP', att.id, {
          downtimeMs: outage.downSince ? now - outage.downSince : null,
          ...(uncertain && lo != null ? { downtimeRange: [Math.max(0, lo), from != null ? now - from : null] } : {}),
          // It never opened on time, so it is opening late, not coming back.
          late: isLateOpening({ from: outage.downFrom }),
          // What the outage was, for grouping its "back up" with the others.
          kind: outage.liveKind ?? null,
          incident: outage.incident ?? null,
        }]);
      } else if (prev.status === 'DOWN' && att.status === 'CLOSED') {
        changes.push(['CLOSED', att.id, { downtimeMs: prev.downSince ? now - prev.downSince : null, incident: prev.incident ?? null }]);
      }
    }
    rides[att.id] = ride;
  }
  const gone = [];
  for (const [id, prev] of Object.entries(prevRides || {})) {
    if (rides[id]) continue;
    const missed = (prev.missed || 0) + 1;
    const missingSince = prev.missingSince ?? now;
    const downish = prev.status === 'DOWN' || prev.closedWhileDown;
    if (downish ? now - missingSince < MISSING_DOWN_MS : missed <= MISSING_POLLS) {
      rides[id] = { ...prev, missed, missingSince };
    } else if (prev.status === 'DOWN') {
      gone.push({ type: 'GONE', ride: { id, ...prev }, downtimeMs: prev.downSince ? now - prev.downSince : null, incident: prev.incident ?? null });
    }
  }
  rememberHolds(rides, { stormAt });
  // GROUP_MIN or more rides starting an outage in one poll, outside a hold,
  // are one incident too (a wave, or several late openings at rope drop).
  // Never on a first poll, when every down ride looks new.
  const fresh = Object.entries(rides).filter(([id, r]) => r.status === 'DOWN' && r.downSince === now && !r.incident && prevRides?.[id]);
  if (fresh.length >= GROUP_MIN) for (const [, r] of fresh) r.incident = `group-${Math.round(now / 1000)}`;
  const events = [...changes.map(([type, id, extra]) => ({ type, ride: { id, ...rides[id] }, ...extra })), ...gone];
  return { rides, events };
}

// What kind of outage each down ride is, settled the first poll it is seen
// down: part of a park-wide hold (CLUSTER_MIN_RIDES rides down within
// CLUSTER_WINDOW_MS of each other), or a breakdown. Settled, because its
// alert has gone out saying which, with that kind's advice; a later wave of
// rides must not turn yesterday's "check back soon" into "ride something
// else". A ride settled as a breakdown joins a hold only if the weather
// reported lightning when it went down (a storm rolling in over two polls).
// Hold rides share an incident id and carry the hold's largest size so far.
export function rememberHolds(rides, { stormAt = null } = {}) {
  const down = Object.values(rides).filter((r) => r.status === 'DOWN' && r.downSince && !isLateOpening({ from: r.downFrom }));
  const eligible = (r) => !r.liveKind || r.liveKind === 'hold' || (r.liveKind === 'breakdown' && !!stormAt?.(r.downSince));
  for (const r of down) {
    if (r.liveKind) continue;
    const mates = down.filter((o) => eligible(o) && Math.abs(o.downSince - r.downSince) <= CLUSTER_WINDOW_MS);
    if (mates.length < CLUSTER_MIN_RIDES) continue;
    const incident = mates.find((o) => o.liveKind === 'hold' && o.incident)?.incident
      || `hold-${Math.round(Math.min(...mates.map((o) => o.downSince)) / 1000)}`;
    for (const o of mates) {
      o.liveKind = 'hold';
      o.incident ??= incident;
    }
  }
  const size = {};
  for (const r of down) {
    if (!r.liveKind) r.liveKind = 'breakdown';
    if (r.liveKind === 'hold') size[r.incident ?? 'hold'] = (size[r.incident ?? 'hold'] || 0) + 1;
  }
  for (const r of down) if (r.liveKind === 'hold') r.holdSize = Math.max(r.holdSize || 0, size[r.incident ?? 'hold']);
}

// A down ride switching to CLOSED is news in the middle of the day: it has
// probably given up for the day. Before the park opens, or around closing
// time, it is just the park's hours, and says nothing. Unknown hours count
// as the middle of the day, as with muting.
const CLOSING_WINDOW_MS = 30 * 60_000;
export function closingIsNews(state, now = Date.now()) {
  // Every ride closing at once is the park closing, whatever its hours say.
  if (isParkClosed(state, now)) return false;
  const s = currentSchedule(state, now);
  const at = (iso) => (iso ? Date.parse(iso) : null);
  const open = at(s?.openingTime);
  const close = at(s?.closingTime);
  const last = at(s?.lastCloseTime);
  if (open && now < open) return false;
  if (close && Math.abs(now - close) <= CLOSING_WINDOW_MS) return false;
  if (last && now >= last - CLOSING_WINDOW_MS) return false;
  return true;
}

// Past the park's close, as its hours and its rides both have it.
const isPastClosing = (state, now = Date.now()) => isParkClosed(state, now);

// Whether the trip has alerts on for this ride at all (its switch), pause aside.
export const followsRide = (trip, rideId) => !trip.rideMutes?.[rideId] && (trip.watched == null || trip.watched.includes(rideId));

export function isTripMuted(trip, rideId, state, now = Date.now()) {
  if (trip.mute && (trip.mute.until === null || trip.mute.until > now)) return true;
  if (trip.rideMutes?.[rideId]) return true;
  if (trip.watched !== null && !trip.watched.includes(rideId)) return true;
  if (isPastClosing(state, now)) return true; // auto-mute after park close
  return false;
}

export { currentSchedule } from './parkstatus.js';

// Which transitions phones hear about, and when, lives in gate.js: "down" at
// once, "back up" once it has stuck, and nothing that repeats what phones
// already believe.
export { gateEvents, gateSnapshot, restoreGate, UP_CONFIRM_MS } from './gate.js';
const restored = new Set(); // parks whose saved gate has been read this run

// What to tell people about a DOWN ride: what kind of outage it looks like,
// and a reopen range from past outages of that kind. Shared by alerts and the
// dashboard so both always say the same thing.
// When the weather is why the ride is down, the estimate runs from when it
// clears, and the text says where the weather stands.
export function downOutlook(parkId, rideId, elapsedMin, now = Date.now()) {
  const ride = parkState[parkId]?.rides?.[rideId];
  // Every ride in a hold gets the hold's one outlook, timed from when the
  // hold began, so the hold card and its rides never give different advice.
  // A rain-sensitive ride keeps its own: it also waits for a dry track.
  if (ride?.liveKind === 'hold' && ride.incident && !rainSensitive(parkId, rideId, ride.name)) {
    return holdOutlook(parkId, ride.incident, now);
  }
  return rideOutlook(parkId, rideId, elapsedMin, now);
}

function rideOutlook(parkId, rideId, elapsedMin, now, { shared = false } = {}) {
  const rides = parkState[parkId]?.rides || {};
  const live = classifyLive(rides, rideId);
  const w = weatherOutlook(parkId, rideId, rides[rideId], live.kind, now, { shared });
  const est = w?.est ?? estimate(modelHistory(), parkId, shared ? null : rideId, elapsedMin, live.kind);
  return {
    ...live,
    ...(w ? { cause: w.cause, weather: w.weather, clearedAt: w.clearedAt ?? null } : {}),
    text: describeOutlook(w, est, parkState[parkId]?.timezone),
    basis: est && !est.longerThanUsual ? { from: est.basis, outages: est.n } : null,
    // Minutes from now, rounded exactly as the text is: the text is the promise.
    window: shownWindow(est),
    chance: est && !est.longerThanUsual && est.chance ? est.chance : null,
    advice: advise(est, { minutesToClose: minutesToClose(parkId, now) }),
  };
}

// One outlook per hold, worked out from the ride that went down first and
// kept for a few seconds, so every ride asked about in one go gets the same.
const holdOutlooks = new Map(); // "park|incident" -> { at, outlook }
function holdOutlook(parkId, incident, now) {
  const key = `${parkId}|${incident}`;
  const hit = holdOutlooks.get(key);
  if (hit && Math.abs(now - hit.at) < 15_000) return hit.outlook;
  const all = Object.entries(parkState[parkId]?.rides || {}).filter(([, r]) => r.status === 'DOWN' && r.incident === incident);
  const dry = all.filter(([id, r]) => !rainSensitive(parkId, id, r.name));
  const [firstId, first] = (dry.length ? dry : all).reduce((a, b) => (b[1].downSince < a[1].downSince ? b : a));
  const outlook = rideOutlook(parkId, firstId, (now - first.downSince) / 60_000, now, { shared: true });
  if (holdOutlooks.size > 50) holdOutlooks.clear();
  holdOutlooks.set(key, { at: now, outlook });
  return outlook;
}

// Minutes until the park's last close today (events included), or null.
function minutesToClose(parkId, now) {
  const s = parkState[parkId]?.schedule;
  const close = s?.lastCloseTime ?? s?.closingTime;
  if (!close) return null;
  const m = (Date.parse(close) - now) / 60_000;
  return m > 0 ? m : null;
}

// "Storm passed at 3:12 PM. Usually back in 20 to 35 min", or while it goes
// on, "Lightning still nearby. ..." with a range if the archive can give one.
export function describeOutlook(w, est, timezone) {
  const range = describe(est);
  if (!w) return range;
  const lead = w.weather === 'passed'
    ? `${w.cause === 'rain' ? 'Rain stopped' : 'Storm passed'} at ${localTime(w.clearedAt, timezone)}.`
    : w.what === 'rain' ? 'Still raining.' : 'Lightning still nearby.';
  const fallback = w.cause === 'rain'
    ? 'It reopens once the rain stops and the track dries.'
    : 'Rides reopen about 30 min after it passes.';
  return `${lead} ${range ?? fallback}`;
}

// Where tapping a push should land: the ride it is about, the hold, or the
// Down list. The trip code rides along because on iPhone a tapped link can
// open in Safari, whose storage is separate from the home-screen app's; with
// the code in the link it still opens the right trip there.
export function appLink(trip, params = {}) {
  if (!APP_URL) return null;
  return `${APP_URL}/?${new URLSearchParams({ trip: trip.code, ...params })}`;
}

// This many rides going down in one poll are an incident, told as one push;
// the same many unrelated "back up"s or closings in one poll are one push too.
export const GROUP_MIN = 3;

// Rides that went down together (a hold, or GROUP_MIN or more in one poll)
// share an incident: one "went down" push, then "back up" updates that
// replace it on the lock screen as the rides return. The park's incidents
// are kept in its state, so a restart keeps telling the same story.
//   incidents: { [id]: { id, kind: 'hold'|'group', rides: [rideId], start,
//     announcedAt?, endedAt? } }
export function syncIncidents(parkId, state, rides, now = Date.now()) {
  const incidents = (state.incidents ??= {});
  for (const [id, r] of Object.entries(rides)) {
    if (!r.incident || r.status !== 'DOWN') continue;
    const inc = (incidents[r.incident] ??= {
      id: r.incident, kind: r.incident.startsWith('hold') ? 'hold' : 'group', rides: [], start: r.downSince ?? now,
    });
    if (!inc.rides.includes(id)) inc.rides.push(id);
    inc.start = Math.min(inc.start, r.downSince ?? inc.start);
    delete inc.endedAt;
  }
  for (const [key, inc] of Object.entries(incidents)) {
    const open = inc.rides.some((id) => rides[id]?.status === 'DOWN' || pendingUpFor(parkId, id));
    if (!open) inc.endedAt ??= now;
    if (inc.endedAt && now - inc.endedAt > 6 * 3600_000) delete incidents[key];
  }
  return incidents;
}

// Push events to every active trip at the park (or just `only`), honouring
// each trip's mutes. A trip nobody has opened in three weeks is a finished
// vacation: its park is no longer polled for it, and it gets no pushes
// either, until someone opens it again. The gate (gate.js) has already
// decided what is news; this words it, per trip, for the rides it follows.
//   updates: incident "back up" updates from the gate ({ incident, ups, final })
export async function notifyTrips(parkId, events, { simulated = false, only = null, updates = [], now = Date.now() } = {}) {
  const state = parkState[parkId] || {};
  const incidents = state.incidents || {};
  const rides = state.rides || {};
  const parkName = getPark(parkId)?.name || 'the park';
  const tz = state.timezone;
  let sent = 0;
  let skipped = 0;
  const targets = only ? [only] : Object.values(trips).filter((t) => t.parkId === parkId && isTripActive(t));
  // Trips are sent to side by side, so one slow delivery doesn't hold up the
  // rest; each trip's own pushes still go out in order.
  await Promise.all(targets.map(async (trip) => {
    const follows = (id) => !isTripMuted(trip, id, state);
    const mine = events.filter((ev) => follows(ev.ride.id));
    skipped += events.length - mine.length;
    const pushes = [];
    const single = (ev, msg) => pushes.push({ ...msg, click: appLink(trip, { ride: ev.ride.id }), tag: `ride:${ev.ride.id}` });
    const followedIn = (inc) => (inc?.rides || []).filter(follows);

    // Down: a new incident is one push when this trip follows enough of it;
    // rides joining one already announced update that push quietly.
    const byIncident = new Map();
    for (const ev of mine.filter((e) => e.type === 'DOWN')) {
      const key = ev.ride.incident && incidents[ev.ride.incident] ? ev.ride.incident : null;
      byIncident.set(key, [...(byIncident.get(key) || []), ev]);
    }
    for (const [key, evs] of byIncident) {
      const inc = key ? incidents[key] : null;
      const grouped = inc && followedIn(inc).length >= GROUP_MIN;
      if (!grouped) {
        for (const ev of evs) single(ev, downMessage(ev.ride, downOutlook(parkId, ev.ride.id, (now - (ev.ride.downSince ?? now)) / 60_000, now), parkName, tz));
        continue;
      }
      const outlook = groupOutlook(evs.map((ev) => downOutlook(parkId, ev.ride.id, (now - (ev.ride.downSince ?? now)) / 60_000, now)));
      const view = inc.kind === 'hold' ? 'hold' : 'down';
      if (inc.announcedAt) {
        const downNow = followedIn(inc).filter((id) => rides[id]?.status === 'DOWN').length;
        pushes.push({ ...incidentGrewMessage(inc.kind, downNow, evs.map((ev) => ev.ride.name), parkName, outlook), click: appLink(trip, { view }), tag: `inc:${key}` });
      } else {
        const after = evs.find((ev) => ev.after != null)?.after ?? null;
        pushes.push({ ...incidentDownMessage(inc.kind, evs.map((ev) => ev.ride.name), parkName, outlook, inc.start, tz, after), click: appLink(trip, { view }), tag: `inc:${key}` });
      }
    }

    // Back up (rides not in an incident) and closed: several in one poll
    // are one push, except a ride back after a long outage, which is news.
    for (const type of ['UP', 'CLOSED']) {
      const evs = mine.filter((ev) => ev.type === type);
      const long = type === 'UP' ? evs.filter((ev) => ev.downtimeMs >= LONG_OUTAGE_MS && !ev.late) : [];
      const rest = evs.filter((ev) => !long.includes(ev));
      for (const ev of long) single(ev, upMessage(ev, parkName, tz));
      if (rest.length >= GROUP_MIN) {
        pushes.push({
          ...groupMessage(type, rest.map((ev) => ev.ride.name), parkName, { late: rest.every((ev) => ev.late), downtimes: rest.map((ev) => ev.downtimeMs) }),
          click: appLink(trip, { view: 'down' }),
          tag: `${type.toLowerCase()}:${now}`,
        });
      } else {
        for (const ev of rest) single(ev, type === 'UP' ? upMessage(ev, parkName, tz) : closedMessage(ev, parkName, tz));
      }
    }

    // A down ride that left the feed: nobody can say it is back, so say that.
    for (const ev of mine.filter((e) => e.type === 'GONE')) single(ev, goneMessage(ev, parkName, tz));

    // An incident's rides coming back: one update per incident, replacing
    // the "went down" push, or single pushes for a trip that got singles.
    for (const { incident: key, ups, final } of updates) {
      const inc = incidents[key];
      const mineUp = ups.filter((ev) => follows(ev.ride.id));
      if (!mineUp.length) continue;
      const members = followedIn(inc);
      if (members.length < GROUP_MIN) {
        for (const ev of mineUp) single(ev, upMessage(ev, parkName, tz));
        continue;
      }
      const back = members.filter((id) => rides[id]?.status === 'OPERATING' && !pendingUpFor(parkId, id)).length;
      const closed = members.filter((id) => rides[id]?.status === 'CLOSED').map((id) => rides[id].name);
      pushes.push({
        ...incidentUpMessage({
          names: mineUp.map((ev) => ev.ride.name), back, total: members.length, closed,
          downtimes: mineUp.map((ev) => ev.downtimeMs), late: mineUp.every((ev) => ev.late), final, parkName,
        }),
        click: appLink(trip, { view: 'down' }),
        tag: `inc:${key}`,
      });
    }

    // The Home Screen badge: this trip's rides down now.
    const badge = Object.entries(rides).filter(([id, r]) => r.status === 'DOWN' && followsRide(trip, id)).length;
    for (const push of pushes) {
      if (simulated) push.message += ' · SIMULATED TEST';
      if (await deliver(trip, push, { tag: push.tag, badge })) sent++;
    }
  }));
  // Once told, an incident's later rides update its push instead of starting another.
  for (const ev of events) {
    const inc = ev.type === 'DOWN' && incidents[ev.ride.incident];
    if (inc && !inc.announcedAt && !simulated) inc.announcedAt = now;
  }
  return { sent, skipped };
}

// Wait-time alerts are about the ride as it is now, not a transition, so they
// are checked on every poll. A pause or the park's close holds them back
// without using them up; one fires once, and only if the push got out.
export async function notifyWaitAlerts(parkId, rides, now = Date.now()) {
  const state = parkState[parkId];
  const today = localDate(now, state?.timezone || getPark(parkId)?.timezone || 'America/New_York');
  const parkName = getPark(parkId)?.name || 'the park';
  let changed = false;
  let sent = 0;
  const targets = Object.values(trips).filter((t) => t.parkId === parkId && t.waitAlerts && isTripActive(t, now));
  await Promise.all(targets.map(async (trip) => {
    if (pruneWaitAlerts(trip, today)) changed = true;
    const paused = trip.mute && (trip.mute.until === null || trip.mute.until > now);
    if (paused || isPastClosing(state, now)) return;
    for (const { rideId, ride, alert } of dueWaitAlerts(trip, rides, today)) {
      if (!(await deliver(trip, { ...waitAlertMessage(ride, alert, parkName), click: appLink(trip, { ride: rideId }) }, { tag: `wait:${rideId}`, now }))) continue;
      alert.sentAt = now;
      alert.sentWait = ride.waitTime;
      changed = true;
      sent++;
    }
  }));
  if (changed) saveTrips();
  if (sent) console.log(`[poller] ${parkName}: sent ${sent} wait alert(s)`);
  return sent;
}

// Fire a fake transition through the real notification pipeline (fan-out, mutes,
// closing-time auto-mute all apply). Never touches real ride state.
export async function simulateTransition(trip, type) {
  if (!parkState[trip.parkId]?.lastPoll) await pollPark(trip.parkId);
  const rides = Object.entries(parkState[trip.parkId]?.rides || {});
  if (!rides.length) return { error: 'no ride data for this park yet' };
  // Prefer a ride this trip would actually be notified about, so a default
  // simulate always produces a visible push (unless globally/auto muted).
  const eligible = rides.filter(
    ([id]) => !trip.rideMutes?.[id] && (trip.watched === null || trip.watched.includes(id))
  );
  const pool = eligible.length ? eligible : rides;
  const [id, r] = pool[Math.floor(Math.random() * pool.length)];
  const ev =
    type === 'down'
      ? { type: 'DOWN', ride: { id, ...r } }
      : { type: 'UP', ride: { id, ...r }, downtimeMs: 47 * 60_000 };
  // Only this trip: a test on one trip must never buzz strangers' phones.
  const stats = await notifyTrips(trip.parkId, [ev], { simulated: true, only: trip });
  console.log(`[poller] SIMULATED ${ev.type} ${r.name}: sent ${stats.sent}, skipped ${stats.skipped}`);
  return { simulated: true, type: ev.type, ride: r.name, ...stats };
}

// Hours change on the day (an extension, an added event), so today's
// schedule is checked again every hour, and every 15 minutes in the hour
// before it says the park closes: a stale close would mute alerts while the
// park is still open.
export const SCHEDULE_TTL_MS = 60 * 60_000;
export const SCHEDULE_TTL_NEAR_CLOSE_MS = 15 * 60_000;
// While the rides disagree with the hours (a park closing early, or running
// past its posted close), they are read again every few minutes.
export const SCHEDULE_TTL_DISAGREE_MS = 5 * 60_000;
export function scheduleIsFresh(state, now = Date.now()) {
  const s = state?.schedule;
  const today = localDate(now, state?.timezone || 'America/New_York');
  // Schedules saved before lastCloseTime existed are refetched once.
  if (s?.date !== today || !('lastCloseTime' in s) || !s.fetchedAt) return false;
  if (hoursDisagree(state, now)) return now - s.fetchedAt < SCHEDULE_TTL_DISAGREE_MS;
  const close = Date.parse(s.lastCloseTime || s.closingTime || '');
  const nearClose = Number.isFinite(close) && now >= close - 60 * 60_000 && now <= close + 30 * 60_000;
  return now - s.fetchedAt < (nearClose ? SCHEDULE_TTL_NEAR_CLOSE_MS : SCHEDULE_TTL_MS);
}

async function refreshSchedule(parkId) {
  const state = parkState[parkId];
  if (scheduleIsFresh(state)) return;
  try {
    const sched = await fetchSchedule(parkId);
    state.timezone = sched.timezone;
    state.schedule = { ...sched, fetchedAt: Date.now() };
  } catch (err) {
    // The last good copy stands (for today only; see currentSchedule).
    console.error(`[poller] schedule fetch failed for ${parkId}:`, err.message);
  }
}

// Recent transitions, newest first, so someone opening the app from an alert
// can see what happened even if the ride is already back up. Kept for a whole
// park day so each ride's detail sheet can list what it did today.
const RECENT_MS = 18 * 3600_000;
export function recordRecent(recent = [], events, now = Date.now()) {
  const added = events.map((ev) => ({
    type: ev.type,
    id: ev.ride.id,
    name: ev.ride.name,
    at: now,
    downtimeMs: ev.downtimeMs ?? null,
    ...(ev.late ? { late: true } : {}),
    ...(ev.incident ?? ev.ride.incident ? { incident: ev.incident ?? ev.ride.incident } : {}),
  }));
  return [...added, ...recent].filter((e) => now - e.at < RECENT_MS).slice(0, 400);
}

// Coalesce concurrent polls of the same park (interval tick vs. trip create /
// park switch / dashboard warm-up). Two racing fetches can resolve out of
// order and replay a stale snapshot over fresh state, manufacturing a phantom
// "back up" + duplicate "down" for a single real outage, so callers of an
// already-in-flight poll just await that one.
const inFlight = new Map(); // parkId -> Promise

export function pollPark(parkId) {
  if (inFlight.has(parkId)) return inFlight.get(parkId);
  const p = doPollPark(parkId).finally(() => inFlight.delete(parkId));
  inFlight.set(parkId, p);
  return p;
}

// For readers (the dashboard): if this park's snapshot is old, or a poll is
// already on its way (a park switch starts one), wait briefly for it rather
// than serve the old snapshot as live. Bounded, so a slow API costs a few
// seconds, not a hung request; the reader can tell from lastPoll.
export const FRESH_MS = 2 * POLL_INTERVAL_MS;
export async function freshPark(parkId, waitMs = 5000) {
  const s = parkState[parkId];
  if (!s?.lastPoll || Date.now() - s.lastPoll > FRESH_MS || inFlight.has(parkId)) {
    await Promise.race([pollPark(parkId), new Promise((r) => setTimeout(r, waitMs).unref())]);
  }
  return parkState[parkId] || {};
}

// A snapshot older than this says nothing about when rides changed since:
// the park went unwatched after a park hop, or the server or the API was
// down. Diffing against it sent "back up, was down 18h" the morning after a
// hop, so the next poll starts afresh instead, exactly like the first ever
// poll: no alerts, and every clock starts now. A redeploy is a minute or two.
export const MAX_GAP_MS = 15 * 60_000;
export const isBaseline = (lastPoll, now = Date.now()) => !lastPoll || now - lastPoll > MAX_GAP_MS;

async function doPollPark(parkId) {
  // The zone comes with the schedule, but the park list knows it already, so
  // a California park never runs on New York time while that loads.
  parkState[parkId] ??= { rides: {}, timezone: getPark(parkId)?.timezone || 'America/New_York', schedule: null };
  const state = parkState[parkId];
  try {
    // Weather is fetched alongside, and never holds up the ride poll.
    refreshWeather(parkId);
    await refreshSchedule(parkId);
    const live = await fetchLiveAttractions(parkId);
    // An empty list for a park we know is an API hiccup, not every ride
    // vanishing; count it as a failed poll and keep what we have.
    if (!live.length && Object.keys(state.rides || {}).length) throw new Error('live data came back empty');
    const now = Date.now();
    const baseline = isBaseline(state.lastPoll, now);
    if (baseline && state.lastPoll) {
      console.log(`[poller] ${getPark(parkId)?.name || parkId}: last snapshot is ${Math.round((now - state.lastPoll) / 60_000)} min old, starting afresh`);
      forgetPending(parkId);
    } else if (!restored.has(parkId)) restoreGate(parkId, upgradeGate(parkId, state.gate));
    restored.add(parkId);
    const { rides, events } = applyLiveData(baseline ? {} : state.rides, live, now, {
      stormAt: (t) => stormAt(parkId, t, now), prevPoll: state.lastPoll ?? null,
    });
    state.rides = rides;
    syncIncidents(parkId, state, rides, now);
    state.recent = recordRecent(state.recent, events, now);
    // Break the wait chart where polling stopped, rather than holding the
    // last wait flat across hours nobody was watching.
    state.waits = recordWaits(state.waits, rides, now, baseline && state.lastPoll ? state.lastPoll + POLL_INTERVAL_MS : null);
    state.lastPoll = now;
    state.lastError = null;
    trackEstimates(parkId, state, events, now);
    saveState();
    if (events.length) {
      console.log(
        `[poller] ${getPark(parkId)?.name || parkId}:`,
        events.map((e) => `${e.type} ${e.ride.name}`).join(', ')
      );
    }
    // Every poll, so a "back up" goes out once it has stuck.
    const news = events.filter((ev) => ev.type !== 'CLOSED' || closingIsNews(state, now));
    const { send: toSend, updates } = gateEvents(parkId, news, rides, now, state.incidents || {});
    state.gate = gateSnapshot(parkId);
    await Promise.all([
      toSend.length || updates.length ? notifyTrips(parkId, toSend, { updates, now }) : null,
      notifyWaitAlerts(parkId, rides, now),
      notifyCrowds(parkId, now),
    ]);
  } catch (err) {
    state.lastError = err.message;
    console.error(`[poller] poll failed for ${parkId}:`, err.message);
  }
}

// Gates saved before gate.js keyed rides as "parkId:rideId" and kept a
// time cooldown; only what phones were last told carries over.
export function upgradeGate(parkId, snap) {
  if (!snap || !('lastNotified' in snap)) return snap;
  const lastSent = {};
  for (const [k, v] of Object.entries(snap.lastSent || {})) if (k.startsWith(`${parkId}:`)) lastSent[k.slice(parkId.length + 1)] = v;
  return { lastSent };
}

// Score the estimates of rides that just reopened, then write down what the
// app is saying now about rides that went down or whose weather cleared.
// Never allowed to break a poll: it is bookkeeping, not alerting.
function trackEstimates(parkId, state, events, now) {
  try {
    const scored = scoreCalls(state.calls, state.scores, events, now);
    state.scores = scored.scores;
    state.calls = recordCalls(scored.calls, events, state.rides, (id) => {
      const since = state.rides[id]?.downSince ?? now;
      return downOutlook(parkId, id, (now - since) / 60_000, now);
    }, now);
  } catch (err) {
    console.error(`[poller] scoring estimates for ${parkId}:`, err.message);
  }
}

// Parks are independent, so they are polled side by side: a slow response
// or slow alert delivery at one park never delays another's alerts.
async function pollAll() {
  await Promise.all(activeParkIds().map((parkId) => pollPark(parkId)));
}

let pollTimer = null;
export function startPolling() {
  pollAll();
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`[poller] polling every ${POLL_INTERVAL_MS / 1000}s`);
}

// For shutdown: no new polls, and resolve once the ones under way (and the
// pushes they are sending) finish, or after waitMs, whichever comes first.
export async function stopPolling(waitMs = 5000) {
  clearInterval(pollTimer);
  pollTimer = null;
  await Promise.race([
    Promise.allSettled([...inFlight.values()]),
    new Promise((r) => setTimeout(r, waitMs).unref()),
  ]);
}

// "Lines are building": the headliner waits up by a third (and at least 10
// minutes) in half an hour, at a busier-than-usual time. Once per park every
// two hours, only to trips that asked, never while paused or after close.
// The index is recorded every poll, so the park page can show today's curve.
const CROWD_KEEP_MS = 3 * 3600_000;
const CROWD_ALERT_GAP_MS = 2 * 3600_000;
export async function notifyCrowds(parkId, now = Date.now()) {
  const state = parkState[parkId];
  const index = liveIndex(parkId);
  state.crowd = (state.crowd || []).filter(([t]) => now - t < CROWD_KEEP_MS);
  if (index != null) state.crowd.push([now, index]);
  const building = linesBuilding(state.crowd, now, parkCrowd(parkId, now));
  if (!building || now - (state.crowdAlertAt || 0) < CROWD_ALERT_GAP_MS || isPastClosing(state, now)) return 0;
  state.crowdAlertAt = now;
  const parkName = getPark(parkId)?.name || 'the park';
  const quick = Object.values(state.rides || {})
    .filter((r) => r.status === 'OPERATING' && r.waitTime != null)
    .sort((a, b) => a.waitTime - b.waitTime)
    .slice(0, 2)
    .map((r) => `${r.name} (${r.waitTime} min)`);
  const targets = Object.values(trips).filter((t) => t.parkId === parkId && t.crowdAlerts && isTripActive(t, now)
    && !(t.mute && (t.mute.until === null || t.mute.until > now)));
  let sent = 0;
  await Promise.all(targets.map(async (trip) => {
    if (await deliver(trip, {
      title: `Lines are building at ${parkName}`,
      message: `The big rides average ${building.to} min, up from ${building.from} half an hour ago.${quick.length ? ` Shortest now: ${quick.join(', ')}.` : ''}`,
      click: appLink(trip, { view: 'park' }),
      priority: 3,
    }, { tag: 'crowd', now })) sent++;
  }));
  return sent;
}
