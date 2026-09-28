/* Park-clock helpers. A classic script like app.js and loaded before it, so
   these are plain globals; nothing here touches the DOM, so tests can run it. */
/* exported localDay, nextLocalHour */

// The wall-clock reading in a zone: { year, month, day, hour, minute, second }.
function localParts(ts, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return Object.fromEntries(
    f.formatToParts(new Date(ts)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)])
  );
}

// The calendar day in a zone, as YYYY-MM-DD.
function localDay(ts, timeZone) {
  const p = localParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// The next time the zone's clock reads hour:00, today if that is still ahead,
// else tomorrow. Right across daylight-saving changes.
function nextLocalHour(now, timeZone, hour) {
  const p = localParts(now, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day + (p.hour < hour ? 0 : 1), hour);
  // wall reads the wanted clock time as if it were UTC; walk it by the zone's
  // offset until the zone's clock agrees (twice covers a DST edge).
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const q = localParts(t, timeZone);
    t += wall - Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second);
  }
  return t;
}
