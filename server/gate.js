// Which of a poll's transitions phones hear about, and when.
//
// A ride going down is the alert that matters, so it goes out at once,
// unless phones already think the ride is down (it came back up only
// briefly, and they were never told). "Back up" waits until the ride has
// stayed up for a minute: a ride that flickers back and breaks again costs
// nothing, and phones' last word ("is down") stays true throughout. That
// replaces a time cooldown on both directions, which held a real "down"
// for up to five minutes after a "back up" and so left phones saying "back
// up" about a ride that was down again.
//
// Rides that went down together (a storm hold, or several in one poll) share
// an incident. Their "back up"s are gathered and sent a few minutes apart, as
// one update per incident, instead of one buzz per ride as they reopen.

export const UP_CONFIRM_MS = 60_000;
export const INCIDENT_FLUSH_MS = 3 * 60_000;

const parks = new Map(); // parkId -> { lastSent, pendingUp, batches }

function mem(parkId) {
  let m = parks.get(parkId);
  if (!m) {
    m = { lastSent: new Map(), pendingUp: new Map(), batches: new Map() };
    parks.set(parkId, m);
  }
  return m;
}

// What phones were last told about a ride: 'DOWN', 'UP', 'CLOSED', 'GONE'.
export const lastSentFor = (parkId, rideId) => mem(parkId).lastSent.get(rideId) ?? null;
export const pendingUpFor = (parkId, rideId) => mem(parkId).pendingUp.has(rideId);

// events: this poll's transitions from applyLiveData. rides: the park now.
// incidents: { [id]: { rides: [rideId] } }, the park's current incidents.
// Returns { send, updates }: events to send now, and incident updates
// ({ incident, ups, final }) whose "back up"s are due.
export function gateEvents(parkId, events, rides, now = Date.now(), incidents = {}) {
  const m = mem(parkId);
  const send = [];
  const updates = [];
  for (const ev of events) {
    const id = ev.ride.id;
    if (ev.type === 'UP') {
      m.pendingUp.set(id, { ev, seenAt: now });
      continue;
    }
    // Down, closed or gone: any "back up" waiting to be told is void.
    m.pendingUp.delete(id);
    for (const b of m.batches.values()) b.ups = b.ups.filter((u) => u.ride.id !== id);
    const last = m.lastSent.get(id);
    if (ev.type === 'DOWN' && last === 'DOWN') continue; // phones still think it's down
    if (ev.type !== 'DOWN' && last === ev.type) continue;
    m.lastSent.set(id, ev.type);
    send.push(ev);
  }
  // "Back up" once the ride has stayed up long enough.
  for (const [id, p] of m.pendingUp) {
    const ride = rides[id];
    if (ride?.status !== 'OPERATING') {
      if (!ride) m.pendingUp.delete(id); // left the feed; applyLiveData handles that
      continue;
    }
    if (now - p.seenAt < UP_CONFIRM_MS) continue;
    m.pendingUp.delete(id);
    if (m.lastSent.get(id) === 'UP') continue;
    const ev = { ...p.ev, ride: { ...p.ev.ride, ...ride, id }, reopenedAt: p.seenAt };
    const incident = ev.incident && incidents[ev.incident] ? ev.incident : null;
    if (!incident) {
      m.lastSent.set(id, 'UP');
      send.push(ev);
      continue;
    }
    const b = m.batches.get(incident) || { ups: [], firstAt: now };
    b.ups.push(ev);
    m.batches.set(incident, b);
  }
  // An incident's gathered "back up"s go out when every ride in it is back
  // (or closed), or a few minutes after the first one.
  for (const [incident, b] of m.batches) {
    if (!b.ups.length) {
      m.batches.delete(incident);
      continue;
    }
    const members = incidents[incident]?.rides || b.ups.map((u) => u.ride.id);
    const open = members.some((rid) => rides[rid]?.status === 'DOWN' || m.pendingUp.has(rid));
    if (open && now - b.firstAt < INCIDENT_FLUSH_MS) continue;
    for (const u of b.ups) m.lastSent.set(u.ride.id, 'UP');
    updates.push({ incident, ups: b.ups, final: !open });
    m.batches.delete(incident);
  }
  return { send, updates };
}

// After a gap in polling, anything waiting belongs to a snapshot nobody can
// vouch for; what phones were last told still stands.
export function forgetPending(parkId) {
  const m = mem(parkId);
  m.pendingUp.clear();
  m.batches.clear();
}

// The gate lives in memory, so it is copied into the park's saved state each
// poll and read back after a restart.
export function gateSnapshot(parkId) {
  const m = mem(parkId);
  return {
    lastSent: Object.fromEntries(m.lastSent),
    pendingUp: [...m.pendingUp].map(([id, p]) => [id, p]),
    batches: [...m.batches].map(([id, b]) => [id, b]),
  };
}

export function restoreGate(parkId, snap) {
  if (!snap) return;
  const m = mem(parkId);
  for (const [k, v] of Object.entries(snap.lastSent || {})) if (!m.lastSent.has(k)) m.lastSent.set(k, v);
  for (const [k, p] of snap.pendingUp || []) if (!m.pendingUp.has(k)) m.pendingUp.set(k, p);
  for (const [k, b] of snap.batches || []) if (!m.batches.has(k)) m.batches.set(k, b);
}
