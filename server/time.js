// Park-local calendar helpers. A park's "today" is its own time zone's day,
// which is how the schedule, the history archive and "today" filters all
// count, whatever the server's clock says.

// The park-local date as YYYY-MM-DD.
export function localDate(ts, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(ts));
}

// Midnight in the park's zone, as epoch ms, for "today" filters.
export function parkDayStart(timezone, now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(now)).map((p) => [p.type, Number(p.value)])
  );
  const sinceMidnight = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
  return now - sinceMidnight - (now % 1000);
}
