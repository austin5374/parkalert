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

export function listNames(names, max = 5) {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

// A range and the advice that goes with it: "Usually back in 10 to 40 min · Check back soon".
export function outlookLine(outlook) {
  if (!outlook) return null;
  if (outlook.text && outlook.advice) return `${outlook.text} · ${outlook.advice.verdict}`;
  return outlook.text || outlook.advice?.verdict || null;
}

const isStorm = (outlook) => !!outlook?.cause;
export const holdTitle = (outlook) => (isStorm(outlook) ? 'Storm hold' : 'Park-wide hold');

// ---- One ride ----

// ride: { name, downSince }, outlook from downOutlook.
export function downMessage(ride, outlook, parkName, timezone) {
  const lines = [`Went down at ${localTime(ride.downSince ?? Date.now(), timezone)} · ${parkName}`];
  if (outlook?.kind === 'hold') lines.push(`Part of a ${holdTitle(outlook).toLowerCase()}: ${outlook.rides} rides closed`);
  const line = outlookLine(outlook);
  if (line) lines.push(line);
  return { title: `${ride.name} is down`, message: lines.join('\n'), priority: 3 };
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
  return {
    title: long ? `${ev.ride.name} is back up after ${formatDuration(ev.downtimeMs)}` : `${ev.ride.name} is back up`,
    message: ev.downtimeMs
      ? `${long ? `Down since ${localTime(ev.ride.downSince ?? Date.now() - ev.downtimeMs, timezone)}` : `Was down ${formatDuration(ev.downtimeMs)}`} · ${parkName}`
      : `Back at ${localTime(ev.reopenedAt ?? Date.now(), timezone)} · ${parkName}`,
    priority: 4,
  };
}

// A ride back after this long is news on its own, never folded into a group.
export const LONG_OUTAGE_MS = 60 * 60_000;

export function closedMessage(ev, parkName, timezone) {
  const since = ev.ride.downSince ? `Down since ${localTime(ev.ride.downSince, timezone)}, now closed` : 'Now closed';
  return { title: `${ev.ride.name} has closed`, message: `${since}. It may not reopen today · ${parkName}`, priority: 3 };
}

// ---- Several rides ----

// How long a group of rides was out: "Down about 12 min" when they agree to
// within a few minutes (a hold always does), else the spread.
export function groupDowntime(ms, late = false) {
  const known = ms.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!known.length) return null;
  const lo = known[0];
  const hi = known[known.length - 1];
  const span = hi - lo <= 5 * 60_000 ? `about ${formatDuration(known[known.length >> 1])}` : `${formatDuration(lo)} to ${formatDuration(hi)}`;
  return late ? `Opened ${span} late` : `Down ${span}`;
}

// Rides that went down together. kind: 'hold' or 'group'. The hold, its
// range and what to do come first, since a lock screen shows two lines.
export function incidentDownMessage(kind, names, parkName, outlook, at, timezone) {
  const when = `${parkName} · ${localTime(at, timezone)}`;
  if (kind === 'hold') {
    const lines = [outlookLine(outlook), listNames(names), when].filter(Boolean);
    return { title: `${holdTitle(outlook)}: ${names.length} rides closed`, message: lines.join('\n'), priority: 3 };
  }
  const lines = [listNames(names), when, outlookLine(outlook)].filter(Boolean);
  return { title: `${names.length} rides went down`, message: lines.join('\n'), priority: 3 };
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
    return { title: `${names.length} rides have closed`, message: `${listNames(names)}\nThey may not reopen today · ${parkName}`, priority: 3 };
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
