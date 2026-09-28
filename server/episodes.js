// Turn a day of ThemeParks.wiki park history into DOWN episodes, and classify
// them. Pure functions so they can be tested without the network.
//
// An episode is one stretch of status DOWN for one ride:
//   { rideId, rideName, start, end, minutes, from, endedAs, kind }
//   start/end: epoch ms. end is null when the day ended with the ride still DOWN.
//   from: the status it went DOWN from. OPERATING is a breakdown mid-run;
//     CLOSED means it never opened on time.
//   endedAs: the status it left DOWN for (OPERATING, CLOSED, ...) or null.
//   kind: 'blip' | 'opening' | 'hold' | 'breakdown'

// Under a minute and back to OPERATING: a sensor flicker, not an outage. The
// 60-second poller mostly never sees these, so they would only skew the numbers.
export const BLIP_MINUTES = 1;

// A park-wide hold takes many running rides down within a couple of minutes of
// each other. In Florida that is nearly always lightning (two September 2026
// storms at Magic Kingdom each closed 11 outdoor rides inside 2 min), but a
// fireworks or power hold looks identical in the data, so it is called a hold,
// not weather. Breakdowns are independent, so five together is the tell.
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
    let from = null;
    for (const row of entity.history || []) {
      const next = row.status ?? status;
      if (next === status) continue;
      const t = toMs(row.time);
      if (next === 'DOWN') {
        start = t;
        from = status;
      } else if (status === 'DOWN' && start !== null) {
        episodes.push(makeEpisode(entity, start, from, t, next));
        start = null;
      }
      status = next;
    }
    if (start !== null) {
      // Still DOWN at the end of the park-local day (24h after opening, give or
      // take DST). Censored: we know it lasted at least this long.
      const dayEnd = dayStart ? dayStart + 24 * 3600_000 : start;
      episodes.push(makeEpisode(entity, start, from, null, null, Math.max(dayEnd, start)));
    }
  }
  return classify(episodes);
}

function makeEpisode(entity, start, from, end, endedAs, censoredAt) {
  const stop = end ?? censoredAt;
  return {
    rideId: entity.id,
    rideName: entity.name,
    start,
    end,
    minutes: Math.round(((stop - start) / 60_000) * 10) / 10,
    from,
    endedAs,
    kind: 'breakdown',
  };
}

// A ride that goes DOWN without having been OPERATING first failed to open.
// At rope drop several often do so together, which is not a hold.
export const isLateOpening = (ep) => ep.from != null && ep.from !== 'OPERATING';

export function classify(episodes) {
  const running = episodes.filter((ep) => !isLateOpening(ep));
  for (const ep of episodes) {
    if (ep.endedAs === 'OPERATING' && ep.minutes < BLIP_MINUTES) {
      ep.kind = 'blip';
    } else if (isLateOpening(ep)) {
      ep.kind = 'opening';
    } else {
      const together = new Set();
      for (const other of running) {
        if (Math.abs(other.start - ep.start) <= CLUSTER_WINDOW_MS) together.add(other.rideId);
      }
      ep.kind = together.size >= CLUSTER_MIN_RIDES ? 'hold' : 'breakdown';
    }
  }
  return episodes;
}

// Resolved: we saw it come back, so the duration is exact. Everything else is
// censored: it lasted at least `minutes`, and how much longer is unknown.
export const isResolved = (ep) => ep.endedAs === 'OPERATING';

export const stayedDown = (ep) => !isResolved(ep) && ep.minutes >= STAYED_DOWN_MINUTES;
