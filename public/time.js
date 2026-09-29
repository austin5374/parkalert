/* Park-clock helpers. A classic script like app.js and loaded before it, so
   these are plain globals; nothing here touches the DOM, so tests can run it. */
/* exported localDay, nextLocalHour, fmtDuration, matchesSearch, extractTripCode */

// "<1 min", "47 min", "1 hr 5 min". server/notify.js says it the same way,
// so a push and the app never describe one outage differently.
function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

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

// Ride search, the way Apple's search fields behave: case, accents and
// apostrophes don't matter ("remys" finds "Rémy's"), a leading "the" is
// ignored, and every word typed must start some word of the name, in any
// order ("mountain space" finds Space Mountain).
function searchWords(text) {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}
function matchesSearch(name, query) {
  let words = searchWords(query);
  if (words.length > 1 && words[0] === 'the') words = words.slice(1);
  if (!words.length) return true;
  const hay = searchWords(name);
  const joined = hay.join('');
  return words.every((w) => hay.some((h) => h.startsWith(w))) || joined.includes(words.join(''));
}

// A trip code out of whatever was pasted into the join field: the code alone
// (with stray spaces), an invite link (?join=CODE), or a whole invite message
// ("Join my ParkAlert trip at Magic Kingdom. Code MKLABS ..."). Null while
// nothing in it looks like one yet, so typing is left alone.
function extractTripCode(text) {
  const s = String(text || '');
  const link = s.match(/[?&](?:join|trip)=([A-Za-z0-9]{6})(?![A-Za-z0-9])/);
  if (link) return link[1].toUpperCase();
  const said = s.match(/\bcode\s*:?\s*([A-Za-z0-9]{6})(?![A-Za-z0-9])/i);
  if (said) return said[1].toUpperCase();
  const bare = s.replace(/\s+/g, '');
  if (/^[A-Za-z0-9]{6}$/.test(bare)) return bare.toUpperCase();
  const runs = s.match(/\b[A-Z0-9]{6}\b/g);
  return runs ? runs[runs.length - 1] : null;
}
