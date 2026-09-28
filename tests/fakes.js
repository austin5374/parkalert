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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-test-'));
  return { upstream, pushes, close: () => server.close() };
}
