import { getPark } from './parks.js';
import { localDate } from './time.js';
import { THEMEPARKS_BASE as BASE, THEMEPARKS_API_KEY } from './config.js';

const USER_AGENT = 'ParkAlert/1.0 (personal ride-status notifier)';

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`themeparks.wiki ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Every status change for every ride in a park, for one park-local day.
// Without a key the archive allows the last 7 days and 60 history calls an
// hour; a free key (THEMEPARKS_API_KEY) allows 30 days and 600 calls.
// Resolves { envelope, remaining } where remaining is the hourly budget left.
// Rejects with err.code = 'WINDOW' (day too old for this key), 'BUDGET'
// (hourly limit spent), or a plain error for anything else.
export async function fetchParkHistory(parkId, date) {
  const headers = { 'User-Agent': USER_AGENT };
  if (THEMEPARKS_API_KEY) headers['x-api-key'] = THEMEPARKS_API_KEY;
  const res = await fetch(`${BASE}/entity/${parkId}/history?date=${date}`, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  const remainingHeader = res.headers.get('ratelimit-history-remaining');
  const remaining = remainingHeader === null ? null : Number(remainingHeader);
  if (res.status === 429) throw Object.assign(new Error('history budget spent'), { code: 'BUDGET' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error?.type === 'HISTORY_WINDOW_EXCEEDED') {
      throw Object.assign(new Error(body.error.message), { code: 'WINDOW' });
    }
    throw new Error(`themeparks.wiki history ${date} -> HTTP ${res.status}`);
  }
  return { envelope: await res.json(), remaining };
}

// All attractions with live status for a park.
export async function fetchLiveAttractions(parkId) {
  const data = await getJSON(`/entity/${parkId}/live`);
  return (data.liveData || [])
    .filter((e) => e.entityType === 'ATTRACTION')
    .map((e) => ({
      id: e.id,
      name: e.name,
      status: e.status || 'CLOSED',
      waitTime: e.queue?.STANDBY?.waitTime ?? null,
    }));
}

// Today's hours (park-local) + timezone.
export async function fetchSchedule(parkId) {
  return parseSchedule(await getJSON(`/entity/${parkId}/schedule`), Date.now(), getPark(parkId)?.timezone);
}

// Pure so it can be tested. closingTime is the regular close; lastCloseTime is
// when the last guests leave, which on a party night (Mickey's Not-So-Scary
// Halloween Party runs 7pm to midnight after a 6pm close) is hours later.
// Auto-mute must use lastCloseTime or party guests silently get no alerts.
export function parseSchedule(data, now = Date.now(), fallbackZone = 'America/New_York') {
  const timezone = data.timezone || fallbackZone;
  const today = localDate(now, timezone);
  const entries = (data.schedule || []).filter((s) => s.date === today && s.closingTime);
  const regular = entries.find((s) => s.type === 'OPERATING');
  const late = entries
    .filter((s) => s.type === 'OPERATING' || s.type === 'TICKETED_EVENT')
    .sort((a, b) => Date.parse(b.closingTime) - Date.parse(a.closingTime))[0];
  // An event that runs past regular hours, or a day that is only an event.
  const lateEvent = late && late !== regular && (!regular || Date.parse(late.closingTime) > Date.parse(regular.closingTime))
    ? late
    : null;
  return {
    timezone,
    date: today,
    openingTime: regular?.openingTime || null,
    closingTime: regular?.closingTime || null,
    lastCloseTime: late?.closingTime || null,
    lateEvent: lateEvent ? { name: lateEvent.description || 'Evening event', closingTime: lateEvent.closingTime } : null,
  };
}
