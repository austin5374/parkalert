// Turn a day of ThemeParks.wiki park history into DOWN episodes, and classify
// them. Pure functions so they can be tested without the network.
//
// An episode is one stretch of status DOWN for one ride:
//   { rideId, rideName, start, end, minutes, endedAs, kind }
//   start/end: epoch ms. end is null when the day ended with the ride still DOWN.
//   endedAs: the status it left DOWN for (OPERATING, CLOSED, ...) or null.
//   kind: 'blip' | 'weather' | 'breakdown'

// Under a minute and back to OPERATING: a sensor flicker, not an outage. The
// 60-second poller mostly never sees these, so they would only skew the numbers.
export const BLIP_MINUTES = 1;

// A weather hold closes every outdoor ride within a couple of minutes of each
// other (two September 2026 storms at Magic Kingdom: 11 rides inside 2 min).
// Breakdowns are independent, so five rides going down together is the tell.
export const CLUSTER_WINDOW_MS = 10 * 60_000;
export const CLUSTER_MIN_RIDES = 5;

// A ride still down after an hour that never came back that day (it went to
// CLOSED, or the day ended) most likely stayed down for the night. A short
// episode that ended in CLOSED is just the park closing on it.
export const STAYED_DOWN_MINUTES = 60;

const toMs = (iso) => new Date(iso).getTime();

// envelope: GET /v1/entity/{parkId}/history?date=D (the PARK shape, with entities[]).
export function extractEpisodes(envelope) {
  const episodes = [];
  for (const entity of envelope.entities || []) {
    if (entity.entityType !== 'ATTRACTION') continue;
    const dayStart = entity.opening?.time ? toMs(entity.opening.time) : null;
    // A ride that was already DOWN when the day opened went down on an earlier
    // day; its true start is unknown, so that stretch is skipped rather than
    // recorded with a made-up duration.
    let status = entity.opening?.status ?? null;
    let start = null;
    for (const row of entity.history || []) {
      const next = row.status ?? status;
      if (next === status) continue;
      const t = toMs(row.time);
      if (next === 'DOWN') {
        start = t;
      } else if (status === 'DOWN' && start !== null) {
        episodes.push(makeEpisode(entity, start, t, next));
        start = null;
      }
      status = next;
    }
    if (start !== null) {
      // Still DOWN at the end of the park-local day (24h after opening, give or
      // take DST). Censored: we know it lasted at least this long.
      const dayEnd = dayStart ? dayStart + 24 * 3600_000 : start;
      episodes.push(makeEpisode(entity, start, null, null, Math.max(dayEnd, start)));
    }
  }
  return classify(episodes);
}

function makeEpisode(entity, start, end, endedAs, censoredAt) {
  const stop = end ?? censoredAt;
  return {
    rideId: entity.id,
    rideName: entity.name,
    start,
    end,
    minutes: Math.round(((stop - start) / 60_000) * 10) / 10,
    endedAs,
    kind: 'breakdown',
  };
}

export function classify(episodes) {
  const byStart = [...episodes].sort((a, b) => a.start - b.start);
  for (const ep of byStart) {
    if (ep.endedAs === 'OPERATING' && ep.minutes < BLIP_MINUTES) {
      ep.kind = 'blip';
      continue;
    }
    const together = new Set();
    for (const other of byStart) {
      if (Math.abs(other.start - ep.start) <= CLUSTER_WINDOW_MS) together.add(other.rideId);
    }
    ep.kind = together.size >= CLUSTER_MIN_RIDES ? 'weather' : 'breakdown';
  }
  return episodes;
}

// Resolved: we saw it come back, so the duration is exact. Everything else is
// censored: it lasted at least `minutes`, and how much longer is unknown.
export const isResolved = (ep) => ep.endedAs === 'OPERATING';

export const stayedDown = (ep) => !isResolved(ep) && ep.minutes >= STAYED_DOWN_MINUTES;
