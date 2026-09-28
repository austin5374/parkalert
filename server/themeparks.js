const BASE = 'https://api.themeparks.wiki/v1';

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
  if (process.env.THEMEPARKS_API_KEY) headers['x-api-key'] = process.env.THEMEPARKS_API_KEY;
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

// Today's operating hours (park-local) + timezone.
export async function fetchSchedule(parkId) {
  const data = await getJSON(`/entity/${parkId}/schedule`);
  const timezone = data.timezone || 'America/New_York';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const entry = (data.schedule || []).find(
    (s) => s.date === today && s.type === 'OPERATING'
  );
  return {
    timezone,
    date: today,
    openingTime: entry?.openingTime || null,
    closingTime: entry?.closingTime || null,
  };
}
