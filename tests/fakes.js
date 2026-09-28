// Stand-ins for ThemeParks.wiki and ntfy, for tests that drive the real
// server modules. Call startFakes() before importing anything from server/,
// since those modules read their base URLs from the environment on import.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startFakes() {
  const upstream = {
    live: {}, // parkId -> [{ id, name, status, waitTime }]
    schedule: {}, // parkId -> ThemeParks.wiki schedule body
    // (parkId, date) -> { status, body, remaining } for the history archive
    history: () => ({ status: 200, body: { entities: [] } }),
    historyCalls: [],
    // Airport weather: live reports [{ icaoId, obsTime (s), rawOb }], and the
    // archive's CSV rows per 'STATION:YYYY-MM-DD'; a request spanning days gets each day's.
    metars: [],
    archive: {},
    archiveCalls: [],
    archiveStatus: 200,
    fail: false,
  };
  const pushes = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/ntfy') {
        pushes.push(JSON.parse(body));
        return send(200, {});
      }
      if (req.url.startsWith('/weather/metar')) {
        const ids = new URL(req.url, base).searchParams.get('ids').split(',');
        return send(200, upstream.metars.filter((m) => ids.includes(m.icaoId)));
      }
      if (req.url.startsWith('/archive')) {
        const q = new URL(req.url, base).searchParams;
        const ymd = (n) => `${q.get(`year${n}`)}-${q.get(`month${n}`).padStart(2, '0')}-${q.get(`day${n}`).padStart(2, '0')}`;
        // day2 is the day after the last one asked for.
        const days = [];
        for (let t = Date.parse(`${ymd(1)}T00:00Z`); t < Date.parse(`${ymd(2)}T00:00Z`); t += 864e5) days.push(new Date(t).toISOString().slice(0, 10));
        upstream.archiveCalls.push(`${q.get('station')}:${days[0]}..${days[days.length - 1]}`);
        if (upstream.archiveStatus !== 200) return send(upstream.archiveStatus, {});
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const rows = days.map((d) => upstream.archive[`${q.get('station')}:${d}`]).filter(Boolean);
        return res.end(`station,valid,metar\n${rows.join('\n')}`);
      }
      const m = req.url.match(/^\/v1\/entity\/([^/?]+)\/(live|schedule|history)/);
      if (!m || upstream.fail) return send(upstream.fail ? 503 : 404, {});
      const [, parkId, kind] = m;
      if (kind === 'live') {
        return send(200, {
          liveData: (upstream.live[parkId] || []).map((r) => ({
            id: r.id,
            name: r.name,
            entityType: 'ATTRACTION',
            status: r.status,
            queue: { STANDBY: { waitTime: r.waitTime ?? null } },
          })),
        });
      }
      if (kind === 'schedule') return send(200, upstream.schedule[parkId] || { timezone: 'America/New_York', schedule: [] });
      const date = new URL(req.url, base).searchParams.get('date');
      upstream.historyCalls.push({ parkId, date });
      const h = upstream.history(parkId, date);
      if (h.remaining !== undefined) res.setHeader('ratelimit-history-remaining', String(h.remaining));
      return send(h.status, h.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.THEMEPARKS_BASE = `${base}/v1`;
  process.env.NTFY_BASE = `${base}/ntfy`;
  process.env.WEATHER_BASE = `${base}/weather`;
  process.env.WEATHER_ARCHIVE = `${base}/archive`;
  process.env.HEALTH_TOKEN = 'health-secret';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-test-'));
  return { upstream, pushes, close: () => server.close() };
}
