/* Park-clock helpers. A classic script like app.js and loaded before it, so
   these are plain globals; nothing here touches the DOM, so tests can run it,
   and the service worker loads it too. */
/* exported localDay, nextLocalHour, fmtDuration, matchesSearch, extractTripCode, localClock */

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
// order ("mountain space" finds Space Mountain). Guests also type numbers
// and nicknames: digits match number words ("7 dwarfs"), a few short forms
// and plurals are understood ("mtn", "dwarves"), and a ride's initials or
// its well-known acronym find it ("7DMT", "BTMRR").
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const SEARCH_SAME = { mtn: 'mountain', mt: 'mountain', rr: 'railroad', dwarves: 'dwarfs', n: 'and' };
// Acronyms fans use that aren't simply a ride's initials.
const SEARCH_ALIASES = {
  btmrr: 'big thunder mountain railroad', rnrc: 'rock n roller coaster', tsmm: 'toy story mania',
  rotr: 'rise of the resistance', mfsr: 'millennium falcon smugglers run', fop: 'flight of passage',
  gotg: 'guardians of the galaxy', tta: 'peoplemover', mmrr: 'runaway railway', totr: 'twilight zone tower of terror',
};
function searchWords(text) {
  return String(text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => (/^\d+$/.test(w) && NUMBER_WORDS[Number(w)]) || SEARCH_SAME[w] || w);
}
function matchesSearch(name, query) {
  let words = searchWords(query);
  if (words.length > 1 && words[0] === 'the') words = words.slice(1);
  if (!words.length) return true;
  const hay = searchWords(name);
  const joined = hay.join('');
  if (words.every((w) => hay.some((h) => h.startsWith(w))) || joined.includes(words.join(''))) return true;
  // One word typed: a ride's initials, with a number as its digit ("7dmt"),
  // or a known acronym.
  if (words.length !== 1) return false;
  const q = String(query).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (q.length < 2) return false;
  const initials = hay.map((h) => h[0]).join('');
  const withDigits = hay.map((h) => (NUMBER_WORDS.indexOf(h) > 0 ? String(NUMBER_WORDS.indexOf(h)) : h[0])).join('');
  if (initials.includes(q) || withDigits.includes(q)) return true;
  return !!SEARCH_ALIASES[q] && matchesSearch(name, SEARCH_ALIASES[q]);
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

// Times written the park's way in a push ("9:44 AM", "8:05 to 8:27 AM",
// "4 PM"), in the phone's own format instead ("09:44", "16 Uhr"...). The
// wall-clock time stays the park's: only how it is written changes. The
// service worker applies it to each push, so a push and the app it opens
// read the same.
function localClock(text, locale) {
  if (!text) return text;
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  const hourOnly = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' });
  const at = (h, m, ap) => Date.UTC(2000, 0, 1, (Number(h) % 12) + (ap === 'PM' ? 12 : 0), Number(m));
  const tidy = (t) => t.replace(/\s(?=[AP]M\b)/, '\u00a0');
  // Written the park's way already: leave it exactly as sent.
  if (tidy(clock.format(at(9, 44, 'AM'))) === '9:44\u00a0AM') return text;
  const S = '[\\s\\u00a0\\u202f]';
  return String(text)
    .replace(new RegExp(`\\b(\\d{1,2}):(\\d{2}) to (\\d{1,2}):(\\d{2})${S}(AM|PM)\\b`, 'g'), (_, h1, m1, h2, m2, ap) => `${tidy(clock.format(at(h1, m1, ap)))} to ${tidy(clock.format(at(h2, m2, ap)))}`)
    .replace(new RegExp(`\\b(\\d{1,2}):(\\d{2})${S}(AM|PM)\\b`, 'g'), (_, h, m, ap) => tidy(clock.format(at(h, m, ap))))
    .replace(new RegExp(`\\b(\\d{1,2})${S}(AM|PM)\\b`, 'g'), (_, h, ap) => tidy(hourOnly.format(at(h, 0, ap))));
}
