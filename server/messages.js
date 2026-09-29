// What each push says. Pure, so the wording can be tested alone.
// A push is { title, message, priority, quiet? }: quiet ones update what is
// already on the lock screen without buzzing (see deliver.js).
import { formatDuration } from './notify.js';

// "3:12 PM" on the park's clock. The space before AM/PM never breaks.
export function localTime(ts, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(ts))
    .replace(/\s(?=[AP]M$)/, ' ');
}

// "2 PM": an hour on the park's clock.
export const hourLabel = (h) => `${h % 12 || 12}\u00a0${h < 12 ? 'AM' : 'PM'}`;

export function listNames(names, max = 5) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// A range and the advice that goes with it: "Often back in 10 to 40 min · Check back soon".
export function outlookLine(outlook) {
  if (!outlook) return null;
  if (outlook.text && outlook.advice) return `${outlook.text} · ${outlook.advice.verdict}`;
  return outlook.text || outlook.advice?.verdict || null;
}

const isStorm = (outlook) => !!outlook?.cause;
export const holdTitle = (outlook) => (isStorm(outlook) ? 'Storm hold' : 'Park-wide hold');

// ---- One ride ----

// ride: { name, downSince }, outlook from downOutlook.
// When a ride went down, as far as anyone knows: exact, between two polls
// either side of a gap in the feed, or only that it was down when first seen.
export function wentDown(ride, timezone) {
  const at = localTime(ride.downSince ?? Date.now(), timezone);
  if (ride.downExact !== false) return `Went down at ${at}`;
  return ride.downAfter != null ? `Went down between ${localTime(ride.downAfter, timezone)} and ${at}` : `Down since before ${at}`;
}

export function downMessage(ride, outlook, parkName, timezone) {
  const lines = [`${wentDown(ride, timezone)} · ${parkName}`];
  if (outlook?.kind === 'hold') lines.push(`Part of a ${holdTitle(outlook).toLowerCase()}: ${outlook.rides} rides closed`);
  const line = outlookLine(outlook);
  if (line) lines.push(line);
  return { title: `${ride.name} is down`, message: lines.join('\n'), priority: 3, urgency: 'high' };
}

// ev: an UP event (downtimeMs, late, reopenedAt).
export function upMessage(ev, parkName, timezone) {
  if (ev.late) {
    return {
      title: `${ev.ride.name} is now open`,
      message: `Opened at ${localTime(ev.reopenedAt ?? Date.now(), timezone)}, late · ${parkName}`,
      priority: 4,
    };
  }
  const long = ev.downtimeMs >= LONG_OUTAGE_MS;
  const took = ev.downtimeRange ? downtimeSpan(ev.downtimeRange) : ev.downtimeMs ? `Was down ${formatDuration(ev.downtimeMs)}` : null;
  return {
    title: long ? `${ev.ride.name} is back up after ${ev.downtimeRange && ev.downtimeRange[1] == null ? 'at least ' : ''}${formatDuration(ev.downtimeRange?.[0] ?? ev.downtimeMs)}` : `${ev.ride.name} is back up`,
    message: `${long ? `Down since ${ev.ride.downExact === false ? 'before ' : ''}${localTime(ev.ride.downSince ?? Date.now() - ev.downtimeMs, timezone)}` : took ?? `Back at ${localTime(ev.reopenedAt ?? Date.now(), timezone)}`} · ${parkName}`,
    priority: 4,
  };
}

// An outage whose length is only known to lie in [lo, hi] (hi null: no upper
// bound, it was already down when first seen).
export function downtimeSpan([lo, hi]) {
  if (hi == null) return `Was down at least ${formatDuration(lo)}`;
  if (hi - lo < 2 * 60_000) return `Was down ${formatDuration((lo + hi) / 2)}`;
  return `Was down ${formatDuration(lo)} to ${formatDuration(hi)}`;
}

// A ride back after this long is news on its own, never folded into a group.
export const LONG_OUTAGE_MS = 60 * 60_000;

export function goneMessage(ev, parkName, timezone) {
  const since = ev.ride.downSince ? `Down since ${localTime(ev.ride.downSince, timezone)}. ` : '';
  return { title: `${ev.ride.name} is no longer listed`, message: `${since}It left the park's ride list while down, and may not reopen today · ${parkName}`, priority: 3, urgency: 'high' };
}

export function closedMessage(ev, parkName, timezone) {
  const since = ev.ride.downSince ? `Down since ${localTime(ev.ride.downSince, timezone)}, now closed` : 'Now closed';
  return { title: `${ev.ride.name} has closed`, message: `${since}. It may not reopen today · ${parkName}`, priority: 3, urgency: 'high' };
}

// ---- Several rides ----

// How long a group of rides was out: "Down about 12 min" when they agree to
// within a few minutes (a hold always does), else the spread. Nothing for
// late openings: that time runs from when the ride was noticed down, not
// from when it should have opened, so "12 min late" would be a guess.
export function groupDowntime(ms, late = false) {
  const known = ms.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!known.length || late) return null;
  const lo = known[0];
  const hi = known[known.length - 1];
  const span = hi - lo <= 5 * 60_000 ? `about ${formatDuration(known[known.length >> 1])}` : `${formatDuration(lo)} to ${formatDuration(hi)}`;
  return late ? `Opened ${span} late` : `Down ${span}`;
}

// Rides that went down together. kind: 'hold' or 'group'. The hold, its
// range and what to do come first, since a lock screen shows two lines.
//   after: set when the rides were first seen after a gap in the feed
export function incidentDownMessage(kind, names, parkName, outlook, at, timezone, after = null) {
  const when = `${parkName} · ${after != null ? `between ${localTime(after, timezone)} and ${localTime(at, timezone)}` : localTime(at, timezone)}`;
  if (kind === 'hold') {
    const lines = [outlookLine(outlook), listNames(names), when].filter(Boolean);
    return { title: `${holdTitle(outlook)}: ${names.length} rides closed`, message: lines.join('\n'), priority: 3, urgency: 'high' };
  }
  const lines = [listNames(names), when, outlookLine(outlook)].filter(Boolean);
  return { title: `${names.length} rides went down`, message: lines.join('\n'), priority: 3, urgency: 'high' };
}

// More rides joining a hold already announced: the same notification,
// updated quietly. down: how many of this trip's rides are now closed.
export function incidentGrewMessage(kind, down, added, parkName, outlook) {
  const title = kind === 'hold' ? `${holdTitle(outlook)}: ${down} rides closed` : `${down} rides down`;
  return { title, message: [`Also closed: ${listNames(added)}`, parkName].join('\n'), priority: 3, quiet: true };
}

// Rides from one incident coming back. back and total count this trip's
// rides; closed: names that closed instead. Final when none is still down.
export function incidentUpMessage({ names, back, total, closed = [], downtimes = [], late = false, final, parkName }) {
  const title = final && !closed.length
    ? `All ${total} rides ${late ? 'are now open' : 'are back up'}`
    : `${back} of ${total} rides ${late ? 'are now open' : 'are back up'}`;
  const took = groupDowntime(downtimes, late);
  const lines = [listNames(names), `${took ? `${took} · ` : ''}${parkName}`];
  if (final && closed.length) lines.push(`Closed for now: ${listNames(closed)}`);
  return { title, message: lines.join('\n'), priority: 4, quiet: !final };
}

// Several unrelated rides in one poll: "back up" or "closed".
export function groupMessage(type, names, parkName, { late = false, downtimes = [] } = {}) {
  if (type === 'CLOSED') {
    return { title: `${names.length} rides have closed`, message: `${listNames(names)}\nThey may not reopen today · ${parkName}`, priority: 3, urgency: 'high' };
  }
  const took = groupDowntime(downtimes, late);
  return {
    title: `${names.length} rides ${late ? 'are now open' : 'are back up'}`,
    message: `${listNames(names)}\n${took ? `${took} · ` : ''}${parkName}`,
    priority: 4,
  };
}

// The outlook a grouped push can speak for: the one shared by at least half
// the group, else none.
export function groupOutlook(outlooks) {
  const counts = new Map();
  for (const o of outlooks) counts.set(o.kind, (counts.get(o.kind) || 0) + 1);
  const [kind, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
  return n * 2 >= outlooks.length ? outlooks.find((o) => o.kind === kind) : null;
}

// "3:40 to 3:55 PM", "11:50 AM to 12:10 PM", or "around 3:40 PM".
export function clockSpan(a, b, timezone) {
  const A = localTime(a, timezone);
  const B = b == null ? A : localTime(b, timezone);
  if (A === B) return `around ${A}`;
  const [ta, pa] = A.split('\u00a0');
  return `${pa === B.split('\u00a0')[1] ? ta : A} to ${B}`;
}

// The weather that closed a hold has passed: the moment everyone waiting is
// waiting for. outlook: the hold's (weather 'passed', clearedAt, window in
// minutes from now, basis). down: this trip's rides still closed by it.
export function stormPassedMessage(outlook, down, parkName, timezone, now = Date.now()) {
  const w = outlook.window;
  const when = w ? clockSpan(now + w.lo * 60_000, w.hi == null ? null : now + w.hi * 60_000, timezone) : null;
  const back = !when ? null
    : outlook.basis?.from === 'rule' ? `Rides reopen about 30 min after the last lightning: ${when}`
      : `Rides often back ${when}`;
  return {
    title: `${outlook.cause === 'rain' ? 'Rain stopped' : 'Storm passed'} at ${localTime(outlook.clearedAt, timezone)}`,
    message: [back, `${down.length} ride${down.length === 1 ? '' : 's'} still closed: ${listNames(down)}`, parkName].filter(Boolean).join('\n'),
    priority: 4,
  };
}

// ---- Crowds ----

// building: { from, to } minutes, from linesBuilding. crowd: parkCrowd now.
// shorter: rides this trip follows that are well under their usual.
export function linesMessage(building, crowd, parkName, shorter = []) {
  const usual = crowd?.typical != null ? ` Usually ${crowd.typical} at ${hourLabel(crowd.hour)}.` : '';
  const tip = shorter.length ? ` Shorter than usual now: ${shorter.map((r) => `${r.name} ${r.wait} min (usually ${r.usual})`).join(', ')}.` : '';
  return {
    title: `Lines are building at ${parkName}`,
    message: `The big rides average about ${building.to} min, up from ${building.from} half an hour ago.${usual}${tip}`,
    priority: 3,
  };
}

// ---- The trip itself ----

// The day before a trip nobody opens stops being polled.
export function idleMessage(code) {
  return {
    title: 'Ride alerts stop tomorrow',
    message: `Nobody has opened trip ${code} in two months. Open ParkAlert to keep its alerts on.`,
    priority: 3,
  };
}
