// Park-local calendar helpers. A park's "today" is its own time zone's day,
// which is how the schedule, the history archive and "today" filters all
// count, whatever the server's clock says.

// The park-local date as YYYY-MM-DD.
export function localDate(ts, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(ts));
}

// Midnight in the park's zone, as epoch ms, for "today" filters. Found by
// walking from the wall-clock reading, so a daylight-saving day (23 or 25
// hours long) still starts at midnight rather than an hour off.
export function parkDayStart(timezone, now = Date.now()) {
  const wallOf = (t) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }).formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const [y, m, d] = localDate(now, timezone).split('-').map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  let t = midnight - (wallOf(now) - (now - (now % 1000)));
  for (let i = 0; i < 2; i++) t += midnight - wallOf(t);
  return t;
}
