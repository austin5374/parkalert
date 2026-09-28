import { fetchLiveAttractions, fetchSchedule } from './themeparks.js';
import { publish, formatDuration } from './notify.js';
import { trips, parkState, saveState, activeParkIds, history } from './store.js';
import { getPark } from './parks.js';
import { estimate, describe, classifyLive } from './predict.js';

const POLL_INTERVAL_MS = 60_000;

// Pure transition detection so it can be tested without the network.
// Returns { rides, events } where events = [{ type: 'DOWN'|'UP', ride, downtimeMs }].
export function applyLiveData(prevRides, liveAttractions, now = Date.now()) {
  const rides = {};
  const events = [];
  for (const att of liveAttractions) {
    const prev = prevRides?.[att.id];
    const ride = {
      name: att.name,
      status: att.status,
      waitTime: att.waitTime,
      since: prev && prev.status === att.status ? prev.since : now,
      downSince: null,
      downFrom: null, // status it went DOWN from; CLOSED means it never opened
    };
    if (att.status === 'DOWN') {
      const already = prev?.status === 'DOWN';
      ride.downSince = already ? prev.downSince : now;
      ride.downFrom = already ? prev.downFrom ?? null : prev?.status ?? null;
    }
    if (prev && prev.status !== att.status) {
      if (prev.status === 'OPERATING' && att.status === 'DOWN') {
        events.push({ type: 'DOWN', ride: { id: att.id, ...ride } });
      } else if (prev.status === 'DOWN' && att.status === 'OPERATING') {
        events.push({
          type: 'UP',
          ride: { id: att.id, ...ride },
          downtimeMs: prev.downSince ? now - prev.downSince : null,
        });
      }
    }
    rides[att.id] = ride;
  }
  return { rides, events };
}

function localTime(ts, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

function isPastClosing(state, now = Date.now()) {
  const closing = state?.schedule?.closingTime;
  return closing ? now > new Date(closing).getTime() : false;
}

export function isTripMuted(trip, rideId, state, now = Date.now()) {
  if (trip.mute && (trip.mute.until === null || trip.mute.until > now)) return true;
  if (trip.rideMutes?.[rideId]) return true;
  if (trip.watched !== null && !trip.watched.includes(rideId)) return true;
  if (isPastClosing(state, now)) return true; // auto-mute after park close
  return false;
}

// Anti-flicker: a ride flapping OPERATING/DOWN on consecutive polls would
// otherwise push up to 60 alerts/hour to every phone. Suppress a repeat of the
// same ride+direction within the cooldown; the dashboard still shows live truth.
const NOTIFY_COOLDOWN_MS = 5 * 60_000;
const lastNotified = new Map(); // "parkId:rideId:type" -> epoch ms

export function cooldownOk(key, now = Date.now()) {
  if (now - (lastNotified.get(key) || 0) < NOTIFY_COOLDOWN_MS) return false;
  lastNotified.set(key, now);
  if (lastNotified.size > 500) {
    for (const [k, ts] of lastNotified) if (now - ts >= NOTIFY_COOLDOWN_MS) lastNotified.delete(k);
  }
  return true;
}

// What to tell people about a DOWN ride: what kind of outage it looks like,
// and a reopen range from past outages of that kind. Shared by alerts and the
// dashboard so both always say the same thing.
export function downOutlook(parkId, rideId, elapsedMin) {
  const live = classifyLive(parkState[parkId]?.rides || {}, rideId);
  const est = estimate(history.episodes, parkId, rideId, elapsedMin, live.kind);
  return {
    ...live,
    text: describe(est),
    basis: est && !est.longerThanUsual ? { from: est.basis, outages: est.n } : null,
  };
}

async function notifyTrips(parkId, events, { simulated = false } = {}) {
  const state = parkState[parkId];
  const park = getPark(parkId);
  const parkName = park?.name || 'the park';
  const subscribers = Object.values(trips).filter((t) => t.parkId === parkId);
  let sent = 0;
  let skipped = 0;
  for (const ev of events) {
    if (!simulated && !cooldownOk(`${parkId}:${ev.ride.id}:${ev.type}`)) {
      console.log(`[poller] cooldown: suppressed ${ev.type} ${ev.ride.name}`);
      continue;
    }
    const isDown = ev.type === 'DOWN';
    // Emoji comes from the ntfy tag (red_circle/green_circle), which apps render as a title prefix.
    const title = isDown ? `${ev.ride.name} is down` : `${ev.ride.name} is back up`;
    let message = isDown
      ? `Went down at ${localTime(Date.now(), state.timezone)} · ${parkName}`
      : `Was down ${ev.downtimeMs ? formatDuration(ev.downtimeMs) : 'a while'} · ${parkName}`;
    if (isDown) {
      const outlook = downOutlook(parkId, ev.ride.id, 0);
      if (outlook.kind === 'hold') message += `\nPark-wide hold: ${outlook.rides} rides closed at once`;
      if (outlook.text) message += `\n${outlook.text}`;
    }
    if (simulated) message += ' · SIMULATED TEST';
    for (const trip of subscribers) {
      if (isTripMuted(trip, ev.ride.id, state)) {
        skipped++;
        continue;
      }
      if (await publish(trip.topic, {
        title,
        message,
        tags: isDown ? 'red_circle' : 'green_circle',
        priority: isDown ? 3 : 4,
      })) sent++;
    }
  }
  return { sent, skipped };
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
  const stats = await notifyTrips(trip.parkId, [ev], { simulated: true });
  console.log(`[poller] SIMULATED ${ev.type} ${r.name}: sent ${stats.sent}, skipped ${stats.skipped}`);
  return { simulated: true, type: ev.type, ride: r.name, ...stats };
}

async function refreshSchedule(parkId) {
  const state = parkState[parkId];
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: state?.timezone || 'America/New_York',
  }).format(new Date());
  if (state?.schedule?.date === today) return;
  try {
    const sched = await fetchSchedule(parkId);
    state.timezone = sched.timezone;
    state.schedule = sched;
  } catch (err) {
    console.error(`[poller] schedule fetch failed for ${parkId}:`, err.message);
  }
}

// Coalesce concurrent polls of the same park (interval tick vs. trip create /
// park switch / dashboard warm-up). Two racing fetches can resolve out of
// order and replay a stale snapshot over fresh state, manufacturing a phantom
// "back up" + duplicate "down" for a single real outage — so callers of an
// already-in-flight poll just await that one.
const inFlight = new Map(); // parkId -> Promise

export function pollPark(parkId) {
  if (inFlight.has(parkId)) return inFlight.get(parkId);
  const p = doPollPark(parkId).finally(() => inFlight.delete(parkId));
  inFlight.set(parkId, p);
  return p;
}

async function doPollPark(parkId) {
  parkState[parkId] ??= { rides: {}, timezone: 'America/New_York', schedule: null };
  const state = parkState[parkId];
  try {
    await refreshSchedule(parkId);
    const live = await fetchLiveAttractions(parkId);
    const { rides, events } = applyLiveData(state.rides, live);
    state.rides = rides;
    state.lastPoll = Date.now();
    state.lastError = null;
    saveState();
    if (events.length) {
      console.log(
        `[poller] ${getPark(parkId)?.name || parkId}:`,
        events.map((e) => `${e.type} ${e.ride.name}`).join(', ')
      );
      await notifyTrips(parkId, events);
    }
  } catch (err) {
    state.lastError = err.message;
    console.error(`[poller] poll failed for ${parkId}:`, err.message);
  }
}

async function pollAll() {
  for (const parkId of activeParkIds()) {
    await pollPark(parkId);
  }
}

export function startPolling() {
  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`[poller] polling every ${POLL_INTERVAL_MS / 1000}s`);
}
