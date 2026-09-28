// Airport weather reports (METARs), read for the two things that shut rides:
// lightning and rain. Pure functions, so they can be tested on real reports.
//
// The automated stations near the parks (Kissimmee and Orlando for Walt
// Disney World, Fullerton and Santa Ana for Disneyland) have lightning
// detectors. They report TS when lightning is within about 10 nautical
// miles, VCTS or "LTG DSNT" when it is 10 to 30 miles off, and issue a
// special report the minute a thunderstorm begins or ends, with remarks like
// "TSB35E55" (began :35, ended :55). That is what a storm's end looks like
// from outside the park.

const WEATHER = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)*(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*$/;
const EVENTS = /^([A-Z]*[BE](\d{4}|\d{2}))+$/;

// Minute-of-hour ("35") or hhmm ("1510") from a remark, as a time at or
// before the report it came in (remarks describe the hour just past).
function eventTime(digits, reportAt) {
  const d = new Date(reportAt);
  const t = new Date(reportAt);
  if (digits.length === 2) t.setUTCMinutes(Number(digits), 0, 0);
  else t.setUTCHours(Number(digits.slice(0, 2)), Number(digits.slice(2)), 0, 0);
  if (t > d) t.setTime(t.getTime() - (digits.length === 2 ? 3600_000 : 24 * 3600_000));
  return t.getTime();
}

// "TSB35E55RAB45" -> [{ kind: 'thunder', edge: 'begin', at }, ...]
function remarkEvents(token, reportAt) {
  const out = [];
  let what = null;
  for (const [, code, edge, digits] of token.matchAll(/([A-Z]*?)([BE])(\d{4}|\d{2})(?=[A-Z]|$)/g)) {
    if (code) what = code;
    const kind = /TS/.test(what) ? 'thunder' : /RA|DZ/.test(what) ? 'rain' : null;
    if (kind) out.push({ kind, edge: edge === 'B' ? 'begin' : 'end', at: eventTime(digits, reportAt) });
  }
  return out;
}

// Parse one raw report. `at` is its observation time (epoch ms), which both
// sources give alongside the text. Returns:
//   { at, thunder, rain, events }
//   thunder: 'here' (TS at the station), 'near' (VCTS, or lightning in the
//     remarks), or null; rain: precipitation falling at the station
//   events: begin/end times from the remarks, exact to the minute
export function parseMetar(raw, at) {
  const [body, remarks = ''] = String(raw).split(/\sRMK\s/);
  let thunder = null;
  let rain = false;
  for (const tok of body.trim().split(/\s+/)) {
    if (tok.length < 2 || !WEATHER.test(tok) || /^\d/.test(tok)) continue;
    if (tok.includes('TS')) thunder = tok.startsWith('VC') ? thunder || 'near' : 'here';
    if (!tok.startsWith('VC') && /RA|DZ/.test(tok)) rain = true;
  }
  const events = [];
  for (const tok of remarks.trim().split(/\s+/)) {
    if (/^LTG/.test(tok) || tok === 'VCTS') thunder ||= 'near';
    if (EVENTS.test(tok)) events.push(...remarkEvents(tok, at));
  }
  return { at, thunder, rain, events };
}

// Spells of one kind ('thunder' or 'rain') from a station's reports, oldest
// first: [{ start, end }], end null while it is still going on. Reports are
// hourly plus a special one at each change, so a spell runs from its first
// report (or its "began" remark) to the report that no longer shows it (or
// its "ended" remark, which is exact).
export function spells(observations, kind) {
  const has = (o) => (kind === 'thunder' ? !!o.thunder : o.rain);
  const out = [];
  let open = null;
  for (const o of [...observations].sort((a, b) => a.at - b.at)) {
    const began = o.events.filter((e) => e.kind === kind && e.edge === 'begin').map((e) => e.at);
    const ended = o.events.filter((e) => e.kind === kind && e.edge === 'end').map((e) => e.at);
    if (!open && (has(o) || began.length)) {
      open = { start: Math.min(o.at, ...began), end: null };
      out.push(open);
    }
    if (open && !has(o)) {
      open.end = ended.length ? Math.max(open.start, Math.max(...ended)) : o.at;
      open = null;
    }
  }
  return out;
}

// Merge several stations' spells into one timeline: lightning at either
// station counts, so the storm is over only when both are clear.
export function mergeSpells(lists) {
  const all = lists.flat().map((s) => ({ ...s })).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && (last.end === null || s.start <= last.end)) {
      last.end = last.end === null || s.end === null ? null : Math.max(last.end, s.end);
    } else out.push(s);
  }
  return out;
}
