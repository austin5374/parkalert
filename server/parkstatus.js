// Is the park open? Its posted hours say one thing; its rides, polled every
// minute, say what is really happening. Posted hours alone muted every alert
// while forty rides ran past a close the feed had wrong, and said
// "Everything's running" with every ride closed early. Pure, so it can be
// tested alone.
import { localDate } from './time.js';

// Past the posted close, this share of rides still running means the park
// is open late (hours extended, or listed wrong).
export const OPEN_LATE_SHARE = 0.4;
// Within posted hours, this share or less of rides running or down means
// the park has closed early.
export const CLOSED_EARLY_SHARE = 0.1;
const SETTLE_AFTER_OPEN_MS = 30 * 60_000;

// Hours count only on the park day they describe. If today's schedule could
// not be fetched, yesterday's is still in state, and its closing time would
// mute every alert all day; unknown hours mean no auto-mute instead.
export function currentSchedule(state, now = Date.now()) {
  const s = state?.schedule;
  if (!s?.date) return null;
  return s.date === localDate(now, state.timezone || s.timezone || 'America/New_York') ? s : null;
}

// Rides now, leaving out any missing from the feed.
export function rideCounts(rides = {}) {
  const c = { operating: 0, down: 0, closed: 0, total: 0 };
  for (const r of Object.values(rides)) {
    if (r.missed) continue;
    c.total++;
    if (r.status === 'OPERATING') c.operating++;
    else if (r.status === 'DOWN') c.down++;
    else c.closed++;
  }
  return c;
}

// Where the posted hours put now: 'before', 'open', 'after', or null.
export function postedPhase(state, now = Date.now()) {
  const s = currentSchedule(state, now);
  if (!s) return null;
  const open = Date.parse(s.openingTime || '');
  const last = Date.parse(s.lastCloseTime || s.closingTime || '');
  if (Number.isFinite(open) && now < open) return 'before';
  if (Number.isFinite(last) && now > last) return 'after';
  return Number.isFinite(open) || Number.isFinite(last) ? 'open' : null;
}

// The park as a guest finds it:
//   'open', 'before' (not open yet), 'closed' (past its hours, and the rides
//   agree), 'closedEarly' (within its hours, but nearly every ride is shut),
//   'openLate' (past its hours, but many rides still run), or 'unknown'.
export function parkStatus(state, now = Date.now()) {
  const phase = postedPhase(state, now);
  const c = rideCounts(state?.rides);
  const running = c.total ? c.operating / c.total : 0;
  const inService = c.total ? (c.operating + c.down) / c.total : 0;
  if (phase === 'after') return c.total >= 5 && running >= OPEN_LATE_SHARE ? 'openLate' : 'closed';
  if (phase === 'before') return 'before';
  const opened = Date.parse(currentSchedule(state, now)?.openingTime || '');
  const settled = !Number.isFinite(opened) || now - opened > SETTLE_AFTER_OPEN_MS;
  if (c.total >= 10 && inService <= CLOSED_EARLY_SHARE && settled && phase === 'open') return 'closedEarly';
  return phase ? 'open' : 'unknown';
}

// Alerts stop once the park is closed, by its hours and its rides together.
export const isParkClosed = (state, now = Date.now()) => ['closed', 'closedEarly'].includes(parkStatus(state, now));

// Hours and rides disagree: the hours are worth reading again soon.
export const hoursDisagree = (state, now = Date.now()) => ['closedEarly', 'openLate'].includes(parkStatus(state, now));
