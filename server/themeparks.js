const BASE = 'https://api.themeparks.wiki/v1';

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'ParkAlert/1.0 (personal ride-status notifier)' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`themeparks.wiki ${path} -> HTTP ${res.status}`);
  return res.json();
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
