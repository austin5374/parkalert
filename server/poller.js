import { fetchLiveAttractions, fetchSchedule } from './themeparks.js';
import { publish, formatDuration } from './notify.js';
import { APP_URL } from './config.js';
import { trips, parkState, saveState, saveTrips, activeParkIds, isTripActive, history } from './store.js';
import { dueWaitAlerts, pruneWaitAlerts, waitAlertMessage } from './waitalerts.js';
import { getPark } from './parks.js';
import { estimate, describe, classifyLive } from './predict.js';
import { isLateOpening } from './episodes.js';
import { recordWaits } from './insights.js';
import { localDate } from './time.js';

const POLL_INTERVAL_MS = 60_000;
// A ride missing from a response keeps its last state this many polls before
// it is dropped, so one patchy response can't restart its outage clock.
export const MISSING_POLLS = 5;
// A ride that closes while down is still on the same outage if it reopens
// within this long: "back up" then says how long it was really out. Past
// it (reopening next morning, say) it had simply closed for the day.
export const CLOSED_OUTAGE_MS = 8 * 3600_000;

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
    // Still on an outage that began earlier: down, or closed while down.
    const outage = prev && (prev.status === 'DOWN' || (prev.closedWhileDown && now - prev.downSince < CLOSED_OUTAGE_MS))
      ? prev
      : null;
    if (att.status === 'DOWN') {
      ride.downSince = outage ? outage.downSince : now;
      ride.downFrom = outage ? outage.downFrom ?? null : prev?.status ?? null;
    }
    if (att.status === 'CLOSED' && outage) {
      ride.downSince = outage.downSince;
      ride.downFrom = outage.downFrom ?? null;
      ride.closedWhileDown = true;
    }
    if (prev && prev.status !== att.status) {
      if (prev.status === 'OPERATING' && att.status === 'DOWN') {
        events.push({ type: 'DOWN', ride: { id: att.id, ...ride } });
      } else if (outage && att.status === 'OPERATING') {
        events.push({
          type: 'UP',
          ride: { id: att.id, ...ride },
          downtimeMs: outage.downSince ? now - outage.downSince : null,
          // It never opened on time, so it is opening late, not coming back.
          late: isLateOpening({ from: outage.downFrom }),
        });
      } else if (prev.status === 'DOWN' && att.status === 'CLOSED') {
        events.push({
          type: 'CLOSED',
          ride: { id: att.id, ...ride },
          downtimeMs: prev.downSince ? now - prev.downSince : null,
        });
      }
    }
    rides[att.id] = ride;
  }
  for (const [id, prev] of Object.entries(prevRides || {})) {
    if (rides[id]) continue;
    const missed = (prev.missed || 0) + 1;
    if (missed <= MISSING_POLLS) rides[id] = { ...prev, missed };
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

// Hours count only on the park day they describe. If today's schedule could
// not be fetched, yesterday's is still in state, and its closing time would
// mute every alert all day; unknown hours mean no auto-mute instead.
export function currentSchedule(state, now = Date.now()) {
  const s = state?.schedule;
  if (!s?.date) return null;
  return s.date === localDate(now, state.timezone || s.timezone || 'America/New_York') ? s : null;
}

// A down ride switching to CLOSED is news in the middle of the day: it has
// probably given up for the day. Before the park opens, or around closing
// time, it is just the park's hours, and says nothing. Unknown hours count
// as the middle of the day, as with muting.
const CLOSING_WINDOW_MS = 30 * 60_000;
export function closingIsNews(state, now = Date.now()) {
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

function isPastClosing(state, now = Date.now()) {
  const s = currentSchedule(state, now);
  const closing = s?.lastCloseTime ?? s?.closingTime;
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
// otherwise push up to 60 alerts/hour to every phone. A repeat of the same
// ride+direction within the cooldown is held back, not dropped: once the
// cooldown passes, it goes out if the ride is still that way and the last
// alert about it said otherwise. Dropping it outright meant a ride that went
// down, came back, and went down again a minute later for an hour left every
// phone saying "back up".
export const NOTIFY_COOLDOWN_MS = 5 * 60_000;
const lastNotified = new Map(); // "parkId:rideId:type" -> epoch ms
const lastSent = new Map(); // "parkId:rideId" -> type of the last alert sent
const held = new Map(); // "parkId:rideId" -> { parkId, ev } held back by the cooldown

function cooldownOk(key, now) {
  if (now - (lastNotified.get(key) ?? -Infinity) < NOTIFY_COOLDOWN_MS) return false;
  lastNotified.set(key, now);
  if (lastNotified.size > 500) {
    for (const [k, ts] of lastNotified) if (now - ts >= NOTIFY_COOLDOWN_MS) lastNotified.delete(k);
  }
  return true;
}

// The status a ride must still have for a held alert to still be true.
const STILL = { DOWN: 'DOWN', UP: 'OPERATING', CLOSED: 'CLOSED' };

// Decide which of this poll's transitions to alert on now, and release any
// held-back alert whose cooldown has passed. rides: the park's current state.
export function gateEvents(parkId, events, rides, now = Date.now()) {
  const out = [];
  const send = (ev) => {
    lastSent.set(`${parkId}:${ev.ride.id}`, ev.type);
    out.push(ev);
  };
  for (const ev of events) {
    const key = `${parkId}:${ev.ride.id}`;
    held.delete(key); // a newer transition supersedes anything held
    if (cooldownOk(`${key}:${ev.type}`, now)) send(ev);
    else {
      held.set(key, { parkId, ev });
      console.log(`[poller] cooldown: holding ${ev.type} ${ev.ride.name}`);
    }
  }
  for (const [key, { parkId: p, ev }] of held) {
    if (p !== parkId || events.some((e) => `${parkId}:${e.ride.id}` === key)) continue;
    if (now - (lastNotified.get(`${key}:${ev.type}`) ?? -Infinity) < NOTIFY_COOLDOWN_MS) continue;
    held.delete(key);
    const ride = rides[ev.ride.id];
    if (ride?.status !== STILL[ev.type] || lastSent.get(key) === ev.type) continue;
    cooldownOk(`${key}:${ev.type}`, now);
    send({ ...ev, ride: { id: ev.ride.id, ...ride } });
  }
  return out;
}

// Held alerts belong to the snapshot they came from; after a gap they are stale.
function forgetHeld(parkId) {
  for (const [key, h] of held) if (h.parkId === parkId) held.delete(key);
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
    // Minutes from now, for the dashboard's timeline; the text is the promise.
    window: est && !est.longerThanUsual ? { lo: est.p25, hi: est.p75 } : null,
  };
}

// This many alerts of one kind in a single poll become one push. A storm hold
// closes ~11 rides inside two minutes; eleven buzzes in a row reads as a bug.
export const GROUP_MIN = 3;

function listNames(names, max = 5) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function downMessage(parkId, ev, parkName, timezone) {
  // A held-back alert goes out after the fact, so both the time and the
  // estimate come from when the ride actually went down.
  const since = ev.ride.downSince ?? Date.now();
  const outlook = downOutlook(parkId, ev.ride.id, (Date.now() - since) / 60_000);
  const lines = [`Went down at ${localTime(since, timezone)} · ${parkName}`];
  if (outlook.kind === 'hold') lines.push(`Park-wide hold: ${outlook.rides} rides closed at once`);
  if (outlook.text) lines.push(outlook.text);
  // Emoji comes from the ntfy tag (red_circle/green_circle), which apps render as a title prefix.
  return { title: `${ev.ride.name} is down`, message: lines.join('\n'), tags: 'red_circle', priority: 3 };
}

function upMessage(ev, parkName) {
  if (ev.late) {
    return {
      title: `${ev.ride.name} is now open`,
      message: `Opened ${ev.downtimeMs ? `${formatDuration(ev.downtimeMs)} late` : 'late'} · ${parkName}`,
      tags: 'green_circle',
      priority: 4,
    };
  }
  return {
    title: `${ev.ride.name} is back up`,
    message: `Was down ${ev.downtimeMs ? formatDuration(ev.downtimeMs) : 'a while'} · ${parkName}`,
    tags: 'green_circle',
    priority: 4,
  };
}

function closedMessage(ev, parkName, timezone) {
  const since = ev.ride.downSince ? `Down since ${localTime(ev.ride.downSince, timezone)}, now closed` : 'Now closed';
  return {
    title: `${ev.ride.name} has closed`,
    message: `${since}. It may not reopen today · ${parkName}`,
    tags: 'no_entry',
    priority: 3,
  };
}

// One push for many rides at once. Pure apart from the outlook lookup.
// The outlook a grouped push can speak for: the one shared by at least half
// the group, else none. Six rides in a storm hold plus one unrelated
// breakdown is still "Park-wide hold"; taking whichever ride came first
// could call it a breakdown, or quote a breakdown's estimate for the hold.
export function groupOutlook(outlooks) {
  const counts = new Map();
  for (const o of outlooks) counts.set(o.kind, (counts.get(o.kind) || 0) + 1);
  const [kind, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  return n * 2 >= outlooks.length ? outlooks.find((o) => o.kind === kind) : null;
}

// late: every ride in the group is a delayed opening, now open.
export function groupMessage(type, names, parkName, outlook, { late = false } = {}) {
  if (type === 'CLOSED') {
    return {
      title: `${names.length} rides have closed`,
      message: `${listNames(names)}\nThey may not reopen today · ${parkName}`,
      tags: 'no_entry',
      priority: 3,
    };
  }
  if (type === 'DOWN') {
    const lines = [listNames(names)];
    if (outlook?.kind === 'hold') lines.push(`Park-wide hold at ${parkName}`);
    else lines.push(parkName);
    if (outlook?.text) lines.push(outlook.text);
    return { title: `${names.length} rides just went down`, message: lines.join('\n'), tags: 'red_circle', priority: 3 };
  }
  return {
    title: `${names.length} rides ${late ? 'are now open' : 'are back up'}`,
    message: `${listNames(names)}\n${parkName}`,
    tags: 'green_circle',
    priority: 4,
  };
}

// Push events to every active trip at the park (or just `only`), honouring
// each trip's mutes. A trip nobody has opened in three weeks is a finished
// vacation: its park is no longer polled for it, and it gets no pushes
// either, until someone opens it again. The anti-flicker gate (gateEvents)
// runs before this, in the poller.
export async function notifyTrips(parkId, events, { simulated = false, only = null } = {}) {
  const state = parkState[parkId];
  const parkName = getPark(parkId)?.name || 'the park';
  let sent = 0;
  let skipped = 0;
  const targets = only ? [only] : Object.values(trips).filter((t) => t.parkId === parkId && isTripActive(t));
  // Trips are sent to side by side, so one slow delivery doesn't hold up the
  // rest; each trip's own pushes still go out in order.
  await Promise.all(targets.map(async (trip) => {
    const mine = events.filter((ev) => !isTripMuted(trip, ev.ride.id, state));
    skipped += events.length - mine.length;
    for (const type of ['DOWN', 'UP', 'CLOSED']) {
      const evs = mine.filter((ev) => ev.type === type);
      if (!evs.length) continue;
      const pushes =
        evs.length >= GROUP_MIN
          ? [groupMessage(type, evs.map((ev) => ev.ride.name), parkName,
              type === 'DOWN' ? groupOutlook(evs.map((ev) => downOutlook(parkId, ev.ride.id, 0))) : null,
              { late: evs.every((ev) => ev.late) })]
          : evs.map((ev) => (type === 'DOWN' ? downMessage(parkId, ev, parkName, state.timezone)
            : type === 'CLOSED' ? closedMessage(ev, parkName, state.timezone)
              : upMessage(ev, parkName)));
      for (const push of pushes) {
        if (simulated) push.message += ' · SIMULATED TEST';
        if (await publish(trip.topic, { ...push, click: APP_URL })) sent++;
      }
    }
  }));
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
    for (const { ride, alert } of dueWaitAlerts(trip, rides, today)) {
      if (!(await publish(trip.topic, { ...waitAlertMessage(ride, alert, parkName), click: APP_URL }))) continue;
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

async function refreshSchedule(parkId) {
  const state = parkState[parkId];
  const today = localDate(Date.now(), state?.timezone || 'America/New_York');
  // Schedules saved before lastCloseTime existed are refetched once.
  if (state?.schedule?.date === today && 'lastCloseTime' in state.schedule) return;
  try {
    const sched = await fetchSchedule(parkId);
    state.timezone = sched.timezone;
    state.schedule = sched;
  } catch (err) {
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
  }));
  return [...added, ...recent].filter((e) => now - e.at < RECENT_MS).slice(0, 400);
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
    await refreshSchedule(parkId);
    const live = await fetchLiveAttractions(parkId);
    // An empty list for a park we know is an API hiccup, not every ride
    // vanishing; count it as a failed poll and keep what we have.
    if (!live.length && Object.keys(state.rides || {}).length) throw new Error('live data came back empty');
    const now = Date.now();
    const baseline = isBaseline(state.lastPoll, now);
    if (baseline && state.lastPoll) {
      console.log(`[poller] ${getPark(parkId)?.name || parkId}: last snapshot is ${Math.round((now - state.lastPoll) / 60_000)} min old, starting afresh`);
      forgetHeld(parkId);
    }
    const { rides, events } = applyLiveData(baseline ? {} : state.rides, live, now);
    state.rides = rides;
    state.recent = recordRecent(state.recent, events, now);
    // Break the wait chart where polling stopped, rather than holding the
    // last wait flat across hours nobody was watching.
    state.waits = recordWaits(state.waits, rides, now, baseline && state.lastPoll ? state.lastPoll + POLL_INTERVAL_MS : null);
    state.lastPoll = now;
    state.lastError = null;
    saveState();
    if (events.length) {
      console.log(
        `[poller] ${getPark(parkId)?.name || parkId}:`,
        events.map((e) => `${e.type} ${e.ride.name}`).join(', ')
      );
    }
    // Every poll, so an alert held by the cooldown goes out once it passes.
    const news = events.filter((ev) => ev.type !== 'CLOSED' || closingIsNews(state, now));
    const toSend = gateEvents(parkId, news, rides, now);
    await Promise.all([
      toSend.length ? notifyTrips(parkId, toSend) : null,
      notifyWaitAlerts(parkId, rides, now),
    ]);
  } catch (err) {
    state.lastError = err.message;
    console.error(`[poller] poll failed for ${parkId}:`, err.message);
  }
}

// Parks are independent, so they are polled side by side: a slow response
// or slow alert delivery at one park never delays another's alerts.
async function pollAll() {
  await Promise.all(activeParkIds().map((parkId) => pollPark(parkId)));
}

export function startPolling() {
  pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
  console.log(`[poller] polling every ${POLL_INTERVAL_MS / 1000}s`);
}
