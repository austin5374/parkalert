// How the app's reopen estimates are doing, live. Each estimate is written
// down when it is made (when a ride goes down, and again when the weather
// that closed it clears) and scored when the ride reopens. The backtest
// (server/backtest.js) says how the method does on the archive; this says
// how it is doing today, on what people were actually told.
//
// Pure functions over park state, so they can be tested alone.
//   calls:  { [rideId]: call[] }  estimates waiting for their ride to reopen
//     call: { stage: 'down'|'cleared', cause, at, lo, mid, hi }  (epoch ms)
//   scores: [{ at, stage, cause, hit, width, miss }]  (minutes), newest first

export const SCORE_KEEP_MS = 14 * 24 * 3600_000;
export const MIN_SCORED = 10;
// A call whose ride never reopened (closed for the night, left the feed) is
// forgotten after this; it was not wrong, it just never got its answer.
const CALL_KEEP_MS = 12 * 3600_000;
const MAX_SCORES = 3000;
const MIN = 60_000;

// A call from an outlook as downOutlook gives it: window in minutes from now.
function callOf(stage, outlook, now) {
  const w = outlook?.window;
  if (!w || !Number.isFinite(w.lo) || !Number.isFinite(w.hi)) return null;
  return {
    stage,
    cause: outlook.cause ?? null,
    at: now,
    lo: now + w.lo * MIN,
    mid: now + ((w.lo + w.hi) / 2) * MIN,
    hi: now + w.hi * MIN,
  };
}

// Write down what the app is saying about each down ride. events: this
// poll's transitions; rides: the park's rides now; outlookOf(rideId) gives
// the same outlook the dashboard and alerts show.
// Returns the new calls object.
export function recordCalls(calls = {}, events, rides, outlookOf, now = Date.now()) {
  const next = {};
  for (const [id, list] of Object.entries(calls)) {
    const kept = list.filter((c) => now - c.at < CALL_KEEP_MS);
    if (kept.length && rides[id]?.status !== 'OPERATING') next[id] = kept;
  }
  // The estimate made the moment a ride went down.
  for (const ev of events) {
    if (ev.type !== 'DOWN') continue;
    const call = callOf('down', outlookOf(ev.ride.id), now);
    next[ev.ride.id] = call ? [call] : [];
  }
  // The estimate made the first time the weather that closed it had
  // cleared: rides that went down in a storm are the ones that can be
  // called closely, so they are scored on their own.
  for (const [id, list] of Object.entries(next)) {
    if (rides[id]?.status !== 'DOWN' || list.some((c) => c.stage === 'cleared')) continue;
    const down = list.find((c) => c.stage === 'down');
    if (!down?.cause) continue;
    const outlook = outlookOf(id);
    if (outlook?.weather !== 'passed') continue;
    const call = callOf('cleared', outlook, now);
    if (call) list.push(call);
  }
  for (const [id, list] of Object.entries(next)) if (!list.length) delete next[id];
  return next;
}

// Score the calls of every ride that just came back up. A late opening was
// never an outage the app estimated, so it is not scored. A ride that closed
// for the day after its range had passed is a miss, and the kind guests
// remember; leaving those out made the hit rate look better than it was.
// One that closed while its range was still open (the park closing on it,
// say) never got its answer, and is not scored.
// Returns { calls, scores }.
export function scoreCalls(calls = {}, scores = [], events, now = Date.now()) {
  const nextCalls = { ...calls };
  const added = [];
  for (const ev of events) {
    if (ev.type !== 'UP' && ev.type !== 'CLOSED' && ev.type !== 'GONE') continue;
    const list = nextCalls[ev.ride.id];
    delete nextCalls[ev.ride.id];
    if (ev.late || !list) continue;
    for (const c of list) {
      const width = Math.round((c.hi - c.lo) / MIN);
      if (ev.type !== 'UP') {
        if (now > c.hi) added.push({ at: now, stage: c.stage, cause: c.cause, hit: false, width, miss: null, closed: true });
        continue;
      }
      added.push({
        at: now,
        stage: c.stage,
        cause: c.cause,
        hit: now >= c.lo && now <= c.hi,
        width,
        miss: Math.round(Math.abs(now - c.mid) / MIN * 10) / 10,
      });
    }
  }
  const kept = [...added, ...scores].filter((s) => now - s.at < SCORE_KEEP_MS).slice(0, MAX_SCORES);
  return { calls: nextCalls, scores: kept };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const GROUPS = [
  { id: 'cleared', label: 'After a storm or rain passed', match: (s) => s.stage === 'cleared' },
  { id: 'weather', label: 'When the weather closed it', match: (s) => s.stage === 'down' && s.cause },
  { id: 'other', label: 'Breakdowns and other outages', match: (s) => s.stage === 'down' && !s.cause },
];

// For the park sheet: per kind of estimate, how many were scored, how
// often the ride reopened inside the range, how wide the ranges were, and
// how often the middle of the range was within 7.5 minutes (a 15-minute
// window). Groups with nothing scored are left out.
export function scorecard(scores = [], now = Date.now()) {
  const recent = scores.filter((s) => now - s.at < SCORE_KEEP_MS);
  const groups = [];
  for (const g of GROUPS) {
    const rows = recent.filter(g.match);
    if (!rows.length) continue;
    groups.push({
      id: g.id,
      label: g.label,
      n: rows.length,
      // A share of one or two reopenings is noise ("0% in range" after one).
      inRange: rows.length >= MIN_SCORED ? Math.round((rows.filter((s) => s.hit).length / rows.length) * 100) : null,
      width: Math.round(median(rows.map((s) => s.width))),
      within15: Math.round((rows.filter((s) => s.miss != null && s.miss <= 7.5).length / rows.length) * 100),
      closed: rows.filter((s) => s.closed).length,
    });
  }
  return { days: Math.round(SCORE_KEEP_MS / (24 * 3600_000)), groups };
}
