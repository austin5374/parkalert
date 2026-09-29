#!/usr/bin/env node
// The stress lab: the real ParkAlert server against a fake park you control.
//
//   npm run lab              control panel at http://localhost:4100, app at http://localhost:3000
//   npm run lab -- --auto    also fires a random scenario every 90 seconds
//   npm run lab -- --keep    reuse .lab-data from the last run instead of reseeding
//
// Everything is local: a fake ThemeParks.wiki feed, fake airport weather, a
// fake ntfy that captures every push, and a throwaway data folder seeded with
// 30 days of outage history and wait profiles, trips on three parks, one ride
// already down for five hours, and rides with hostile names. The server polls
// every 10 seconds. Nothing here talks to production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PARKS } from '../server/parks.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAB_PORT = Number(process.env.LAB_PORT) || 4100;
const APP_PORT = Number(process.env.APP_PORT) || 3000;
const DATA = path.join(ROOT, '.lab-data');
const AUTO = process.argv.includes('--auto');
const KEEP = process.argv.includes('--keep');
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const now0 = Date.now();

// ---------- rides ----------
// Real ride names and ids when the real feed answers (one call per park), so
// the app looks like the real thing; a generated roster otherwise.
const FALLBACK = ['Space Mountain', 'Big Thunder Mountain Railroad', 'Haunted Mansion', 'Pirates of the Caribbean', 'Jungle Cruise',
  'Seven Dwarfs Mine Train', "Peter Pan's Flight", 'Tiana\'s Bayou Adventure', 'TRON Lightcycle / Run', '"it\'s a small world"',
  'Astro Orbiter', 'Dumbo the Flying Elephant', 'Mad Tea Party', 'The Barnstormer', 'Tomorrowland Speedway',
  'Under the Sea - Journey of The Little Mermaid', 'Buzz Lightyear\'s Space Ranger Spin', 'Walt Disney World Railroad', 'Swiss Family Treehouse', 'Monsters, Inc. Laugh Floor'];
// Names an app must survive: markup, length, emoji, quotes.
const HOSTILE = [
  '<img src=x onerror=alert("xss")> Ride',
  'A Ride With An Extraordinarily Long Name That Keeps Going Well Past Where Any Layout Would Expect It To Stop, Presented by Someone',
  '🎢 Emoji Coaster 🎢',
  'Quote "Test" & Friends\' Ride',
];

async function roster(park) {
  try {
    const res = await fetch(`https://api.themeparks.wiki/v1/entity/${park.id}/live`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const rides = (data.liveData || []).filter((e) => e.entityType === 'ATTRACTION').map((e) => ({ id: e.id, name: e.name }));
    if (rides.length >= 8) return rides;
  } catch {}
  return FALLBACK.map((name, i) => ({ id: `${park.id.slice(0, 8)}-ride-${i}`, name }));
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const lognormal = (median, spread) => Math.exp(Math.log(median) + spread * Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random()));

// ---------- the fake world ----------
const world = {}; // parkId -> { name, tz, rides: Map(id -> ride), metar: null|string, fail: null|'error'|'slow', close: epoch }
const pushes = []; // captured ntfy messages, newest first
const events = []; // what the lab did, newest first
const log = (text) => { events.unshift({ at: Date.now(), text }); events.length = Math.min(events.length, 200); console.log(`[lab] ${text}`); };

function schedule(park) {
  const w = world[park.id];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: park.timezone }).format(new Date());
  return {
    timezone: park.timezone,
    schedule: [{ date: day, type: 'OPERATING', openingTime: new Date(now0 - 6 * HOUR).toISOString(), closingTime: new Date(w.close).toISOString() }],
  };
}

// Waits wander a little each tick, around each ride's typical wait.
function tick() {
  for (const w of Object.values(world)) {
    for (const r of w.rides.values()) {
      if (r.status !== 'OPERATING' || r.walkOn) continue;
      const target = r.base * w.crowd;
      r.waitTime = Math.max(5, Math.round((r.waitTime + (target - r.waitTime) * 0.2 + rand(-5, 5)) / 5) * 5);
    }
  }
}
setInterval(tick, 10_000);

const later = (min, fn) => setTimeout(fn, min * MIN);
const setStatus = (park, r, status) => {
  r.status = status;
  if (status === 'OPERATING' && !r.walkOn) r.waitTime = Math.round((r.base * world[park.id].crowd) / 5) * 5;
  if (status !== 'OPERATING') r.waitTime = null;
};
const running = (park) => [...world[park.id].rides.values()].filter((r) => r.status === 'OPERATING' && !r.hostile);
const headliner = (park) => running(park).sort((a, b) => b.base - a.base)[Math.floor(Math.random() * 4)];

// ---------- scenarios ----------
const SCENARIOS = {
  breakdown: ['One headliner breaks down, back in 2 to 8 min', (park) => {
    const r = headliner(park); if (!r) return;
    setStatus(park, r, 'DOWN'); log(`${park.name}: ${r.name} DOWN`);
    later(rand(2, 8), () => { setStatus(park, r, 'OPERATING'); log(`${park.name}: ${r.name} back up`); });
  }],
  wave: ['Three rides go down at once (one grouped push)', (park) => {
    for (const r of running(park).sort(() => Math.random() - 0.5).slice(0, 3)) {
      setStatus(park, r, 'DOWN'); log(`${park.name}: ${r.name} DOWN (wave)`);
      later(rand(3, 10), () => { setStatus(park, r, 'OPERATING'); log(`${park.name}: ${r.name} back up`); });
    }
  }],
  storm: ['Lightning: outdoor rides close together (a hold)', (park) => {
    const w = world[park.id];
    w.metar = 'TS';
    const outdoor = running(park).filter((r) => r.outdoor);
    for (const r of outdoor) setStatus(park, r, 'DOWN');
    log(`${park.name}: storm, ${outdoor.length} outdoor rides DOWN`);
  }],
  clear: ['The storm passes; held rides reopen over the next 3 to 6 min', (park) => {
    const w = world[park.id];
    w.metar = null;
    log(`${park.name}: storm passed`);
    for (const r of w.rides.values()) if (r.status === 'DOWN' && r.outdoor) later(rand(3, 6), () => { setStatus(park, r, 'OPERATING'); log(`${park.name}: ${r.name} reopened after storm`); });
  }],
  flap: ['A ride flaps down and up every 20 seconds for 3 min (anti-flicker)', (park) => {
    const r = headliner(park); if (!r) return;
    log(`${park.name}: ${r.name} flapping`);
    const t = setInterval(() => setStatus(park, r, r.status === 'DOWN' ? 'OPERATING' : 'DOWN'), 20_000);
    later(3, () => { clearInterval(t); setStatus(park, r, 'OPERATING'); log(`${park.name}: ${r.name} stopped flapping`); });
  }],
  ropedrop: ['Two closed rides fail to open (delayed opening)', (park) => {
    const rs = running(park).slice(-2);
    for (const r of rs) setStatus(park, r, 'CLOSED');
    later(0.4, () => rs.forEach((r) => { setStatus(park, r, 'DOWN'); log(`${park.name}: ${r.name} late to open`); }));
    later(5, () => rs.forEach((r) => { setStatus(park, r, 'OPERATING'); log(`${park.name}: ${r.name} finally open`); }));
  }],
  closes: ['A down ride gives up and closes for the day', (park) => {
    const r = headliner(park); if (!r) return;
    setStatus(park, r, 'DOWN'); log(`${park.name}: ${r.name} DOWN`);
    later(2, () => { setStatus(park, r, 'CLOSED'); log(`${park.name}: ${r.name} CLOSED for the day`); });
  }],
  rush: ['Lines build: every wait up 60% (crowd level, lines-building alert)', (park) => {
    world[park.id].crowd = 1.6;
    for (const r of running(park)) if (!r.walkOn) r.waitTime = Math.round((r.base * 1.6) / 5) * 5;
    log(`${park.name}: crowd surge`);
  }],
  calm: ['Crowds ease back to normal', (park) => { world[park.id].crowd = 1; log(`${park.name}: crowds normal`); }],
  closing: ['The park closes in 2 minutes (auto-mute, closed states)', (park) => {
    world[park.id].close = Date.now() + 2 * MIN;
    log(`${park.name}: closing in 2 min`);
    later(2.2, () => { for (const r of world[park.id].rides.values()) setStatus(park, r, 'CLOSED'); log(`${park.name}: closed`); });
  }],
  reopen: ['Undo closing: the park is open for 6 more hours', (park) => {
    world[park.id].close = Date.now() + 6 * HOUR;
    for (const r of world[park.id].rides.values()) if (r.status === 'CLOSED') setStatus(park, r, 'OPERATING');
    log(`${park.name}: open again`);
  }],
  outage: ['The ride feed errors (503) for 4 min (stale data)', (park) => {
    world[park.id].fail = 'error'; log(`${park.name}: feed failing`);
    later(4, () => { world[park.id].fail = null; log(`${park.name}: feed back`); });
  }],
  slow: ['The ride feed takes 25 s to answer for 3 min', (park) => {
    world[park.id].fail = 'slow'; log(`${park.name}: feed slow`);
    later(3, () => { world[park.id].fail = null; log(`${park.name}: feed fast again`); });
  }],
  vanish: ['A running ride disappears from the feed for 3 min', (park) => {
    const r = headliner(park); if (!r) return;
    r.hidden = true; log(`${park.name}: ${r.name} missing from feed`);
    later(3, () => { r.hidden = false; log(`${park.name}: ${r.name} back in feed`); });
  }],
  chaos: ['Everything at once: storm, wave, surge, and a flapper', (park) => {
    for (const n of ['rush', 'storm', 'wave', 'flap']) SCENARIOS[n][1](park);
  }],
  recover: ['Everything back to normal now', (park) => {
    const w = world[park.id];
    w.metar = null; w.fail = null; w.crowd = 1; w.close = Date.now() + 6 * HOUR;
    for (const r of w.rides.values()) { r.hidden = false; setStatus(park, r, 'OPERATING'); }
    log(`${park.name}: all recovered`);
  }],
};

// ---------- fake upstream + control panel ----------
const METAR = (station, ts) => `${station} ${new Date().toISOString().slice(8, 10)}${new Date().toISOString().slice(11, 13)}${new Date().toISOString().slice(14, 16)}Z 27012G25KT 5SM ${ts ? '+TSRA ' : ''}SCT030${ts ? 'CB' : ''} 29/22 A2992`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${LAB_PORT}`);
  let body = '';
  for await (const c of req) body += c;
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/ntfy') {
    const msg = JSON.parse(body || '{}');
    pushes.unshift({ at: Date.now(), ...msg });
    pushes.length = Math.min(pushes.length, 300);
    console.log(`[push] ${msg.topic}: ${msg.title}`);
    return json(200, {});
  }
  if (url.pathname.startsWith('/weather/metar')) {
    const ids = (url.searchParams.get('ids') || '').split(',');
    const out = [];
    for (const park of PARKS) {
      for (const id of park.weather || []) {
        if (ids.includes(id) && !out.some((m) => m.icaoId === id)) {
          out.push({ icaoId: id, obsTime: Math.floor(Date.now() / 1000), rawOb: METAR(id, world[park.id]?.metar === 'TS') });
        }
      }
    }
    return json(200, out);
  }
  if (url.pathname.startsWith('/archive')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('station,valid,metar\n'); }

  const m = url.pathname.match(/^\/v1\/entity\/([^/]+)\/(live|schedule|history)/);
  if (m) {
    const park = PARKS.find((p) => p.id === m[1]);
    const w = park && world[park.id];
    if (!w) return json(404, {});
    if (m[2] === 'history') return json(403, { error: { type: 'HISTORY_WINDOW_EXCEEDED', message: 'lab' } });
    if (w.fail === 'error') return json(503, {});
    if (w.fail === 'slow') await new Promise((r) => setTimeout(r, 25_000));
    if (m[2] === 'schedule') return json(200, schedule(park));
    return json(200, {
      liveData: [...w.rides.values()].filter((r) => !r.hidden).map((r) => ({
        id: r.id, name: r.name, entityType: 'ATTRACTION', status: r.status,
        queue: { STANDBY: { waitTime: r.status === 'OPERATING' ? r.waitTime : null } },
      })),
    });
  }

  if (url.pathname === '/lab/scenario' && req.method === 'POST') {
    const { park: parkId, name } = JSON.parse(body || '{}');
    const park = PARKS.find((p) => p.id === parkId) || PARKS[0];
    if (!SCENARIOS[name]) return json(400, { error: 'unknown scenario' });
    SCENARIOS[name][1](park);
    return json(200, { ok: true });
  }
  if (url.pathname === '/lab/state') {
    return json(200, {
      pushes: pushes.slice(0, 60),
      events: events.slice(0, 60),
      parks: PARKS.map((p) => ({
        id: p.id, name: p.name, crowd: world[p.id]?.crowd, storm: !!world[p.id]?.metar, fail: world[p.id]?.fail,
        down: [...(world[p.id]?.rides.values() || [])].filter((r) => r.status === 'DOWN').map((r) => r.name),
      })),
    });
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PANEL);
  }
  json(404, {});
});

const PANEL = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>ParkAlert lab</title>
<style>body{font:15px system-ui;margin:0;padding:16px;background:#111;color:#eee}h1{font-size:20px}a{color:#4da3ff}
button{font:inherit;margin:3px;padding:8px 10px;border-radius:8px;border:0;background:#2a2a2e;color:#eee;cursor:pointer}button:hover{background:#3a3a40}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.box{background:#1c1c1e;border-radius:12px;padding:12px}
li{margin:4px 0}small{color:#999}select{font:inherit;padding:6px;border-radius:8px}</style>
<h1>ParkAlert stress lab</h1>
<p>App: <a href="http://localhost:${APP_PORT}/?trip=MKLABS" target=_blank>Magic Kingdom trip MKLABS</a> ·
<a href="http://localhost:${APP_PORT}/?trip=DLLABS" target=_blank>Disneyland trip DLLABS</a> ·
<a href="http://localhost:${APP_PORT}/?trip=EPLABS" target=_blank>EPCOT trip EPLABS</a>. The server polls every 10 s.</p>
<p>Park: <select id=park>${PARKS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('')}</select></p>
<div class=box>${Object.entries(SCENARIOS).map(([k, [d]]) => `<button data-s="${k}" title="${d.replace(/"/g, '&quot;')}">${k}</button>`).join('')}<p id=desc><small>Hover a button for what it does.</small></p></div>
<div class=cols><div class=box><h2>Pushes captured (ntfy)</h2><ul id=pushes></ul></div><div class=box><h2>Lab events</h2><ul id=events></ul></div><div class=box><h2>Parks</h2><ul id=parks></ul></div></div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const t=(ms)=>new Date(ms).toLocaleTimeString();
document.querySelectorAll('[data-s]').forEach(b=>{b.onclick=()=>fetch('/lab/scenario',{method:'POST',body:JSON.stringify({park:park.value,name:b.dataset.s})}).then(load);b.onmouseenter=()=>desc.innerHTML='<small>'+esc(b.title)+'</small>';});
async function load(){const s=await (await fetch('/lab/state')).json();
pushes.innerHTML=s.pushes.map(p=>'<li><small>'+t(p.at)+' · '+esc(p.topic)+'</small><br><b>'+esc(p.title)+'</b><br>'+esc(p.message)+'</li>').join('');
events.innerHTML=s.events.map(e=>'<li><small>'+t(e.at)+'</small> '+esc(e.text)+'</li>').join('');
parks.innerHTML=s.parks.map(p=>'<li><b>'+esc(p.name)+'</b> crowd ×'+p.crowd+(p.storm?' · storm':'')+(p.fail?' · feed '+p.fail:'')+'<br><small>down: '+esc(p.down.join(', ')||'none')+'</small></li>').join('');}
load();setInterval(load,3000);
</script>`;

// ---------- seed ----------
function seed() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const history = { fetched: {}, episodes: {}, waits: {} };
  const state = {};
  const trips = {};
  for (const park of PARKS) {
    const w = world[park.id];
    const rides = [...w.rides.values()].filter((r) => !r.hostile);
    const openHour = (Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: park.timezone }).format(new Date(now0))) + 18) % 24;
    history.fetched[park.id] = [];
    history.episodes[park.id] = [];
    history.waits[park.id] = {};
    for (let d = 30; d >= 1; d--) {
      const dayStart = now0 - d * DAY;
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: park.timezone }).format(new Date(dayStart));
      history.fetched[park.id].push(date);
      const busy = rand(0.7, 1.4); // some days are busier than others
      const profile = {};
      for (const r of rides) {
        if (r.walkOn) continue;
        // The lab's park is open from 6 hours ago to 6 hours ahead, whatever
        // the real clock says, so its usual day is centred on the hour now.
        profile[r.id] = Array.from({ length: 24 }, (_, h) => {
          const k = ((h - openHour + 24) % 24);
          return k > 12 ? null : Math.max(5, Math.round((r.base * busy * (0.55 + 0.6 * Math.sin((k / 12) * Math.PI)) + rand(-5, 5)) / 5) * 5);
        });
      }
      history.waits[park.id][date] = profile;
      // Outages: breakdowns most days, a storm hold now and then, a late opening or two.
      for (let i = 0; i < Math.round(rand(3, 9)); i++) {
        const r = pick(rides);
        const start = dayStart + rand(9, 21) * HOUR;
        const minutes = Math.min(400, lognormal(14, 0.9));
        const stayed = Math.random() < 0.07;
        history.episodes[park.id].push({ rideId: r.id, rideName: r.name, start, end: stayed ? null : start + minutes * MIN, minutes: stayed ? Math.max(90, minutes) : Math.round(minutes * 10) / 10, from: 'OPERATING', endedAs: stayed ? 'CLOSED' : 'OPERATING', kind: 'breakdown', date });
      }
      if (Math.random() < 0.3) {
        const start = dayStart + rand(13, 17) * HOUR;
        const len = rand(35, 110);
        for (const r of rides.filter((x) => x.outdoor)) history.episodes[park.id].push({ rideId: r.id, rideName: r.name, start, end: start + len * MIN, minutes: Math.round(len), from: 'OPERATING', endedAs: 'OPERATING', kind: 'hold', date });
      }
      if (Math.random() < 0.5) {
        const r = pick(rides), start = dayStart + 9 * HOUR, len = rand(10, 45);
        history.episodes[park.id].push({ rideId: r.id, rideName: r.name, start, end: start + len * MIN, minutes: Math.round(len), from: 'CLOSED', endedAs: 'OPERATING', kind: 'opening', date });
      }
    }
  }
  // One Magic Kingdom ride has been down for five hours: "Running long".
  const mk = PARKS[0];
  const long = [...world[mk.id].rides.values()].filter((r) => !r.hostile && !r.walkOn).sort((a, b) => b.base - a.base)[0];
  long.status = 'DOWN';
  long.waitTime = null;
  state[mk.id] = {
    timezone: mk.timezone, lastPoll: Date.now() - 5000,
    rides: Object.fromEntries([...world[mk.id].rides.values()].map((r) => [r.id, {
      name: r.name, status: r.status, waitTime: r.waitTime, since: r === long ? Date.now() - 5 * HOUR : Date.now() - HOUR,
      downSince: r === long ? Date.now() - 5 * HOUR : null, downFrom: r === long ? 'OPERATING' : null,
    }])),
  };
  for (const [code, park] of [['MKLABS', PARKS[0]], ['DLLABS', PARKS[4]], ['EPLABS', PARKS[1]]]) {
    trips[code] = { code, topic: `lab-${code.toLowerCase()}`, parkId: park.id, watched: null, mute: null, rideMutes: {}, crowdAlerts: true, createdAt: Date.now(), lastSeenAt: Date.now() };
  }
  fs.writeFileSync(path.join(DATA, 'history.json'), JSON.stringify(history));
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(DATA, 'trips.json'), JSON.stringify(trips));
  log(`seeded ${PARKS.length} parks with 30 days of history; ${long.name} down for 5 hours at ${mk.name}`);
}

// ---------- start ----------
for (const park of PARKS) {
  const list = await roster(park);
  const rides = new Map();
  for (const [i, r] of list.entries()) {
    const walkOn = i % 9 === 8; // shows and walk-throughs that post no wait
    const base = walkOn ? 0 : Math.round(pick([10, 15, 20, 30, 40, 50, 60, 75, 90]) / 5) * 5;
    rides.set(r.id, { ...r, base, walkOn, outdoor: Math.random() < 0.5, status: 'OPERATING', waitTime: walkOn ? null : base });
  }
  if (park === PARKS[0]) {
    for (const [i, name] of HOSTILE.entries()) rides.set(`hostile-${i}`, { id: `hostile-${i}`, name, base: 15, walkOn: false, outdoor: false, status: 'OPERATING', waitTime: 15, hostile: true });
  }
  world[park.id] = { name: park.name, tz: park.timezone, rides, metar: null, fail: null, crowd: 1, close: now0 + 6 * HOUR };
}
if (!KEEP || !fs.existsSync(DATA)) seed();

await new Promise((r) => server.listen(LAB_PORT, r));
const app = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    DATA_DIR: DATA,
    POLL_MS: '10000',
    THEMEPARKS_BASE: `http://127.0.0.1:${LAB_PORT}/v1`,
    WEATHER_BASE: `http://127.0.0.1:${LAB_PORT}/weather`,
    WEATHER_ARCHIVE: `http://127.0.0.1:${LAB_PORT}/archive`,
    NTFY_BASE: `http://127.0.0.1:${LAB_PORT}/ntfy`,
    PUBLIC_URL: `http://localhost:${APP_PORT}`,
    HEALTH_TOKEN: 'lab',
  },
});
app.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
app.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));
app.on('exit', (code) => { console.log(`[lab] app exited (${code})`); process.exit(code ?? 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.kill('SIGTERM'); });

console.log(`\n[lab] control panel: http://localhost:${LAB_PORT}\n[lab] app:           http://localhost:${APP_PORT}/?trip=MKLABS  (also DLLABS, EPLABS)\n`);
if (AUTO) {
  const names = Object.keys(SCENARIOS).filter((n) => !['recover', 'reopen', 'chaos'].includes(n));
  setInterval(() => {
    const park = pick([PARKS[0], PARKS[1], PARKS[4]]);
    const name = pick(names);
    log(`auto: ${name} at ${park.name}`);
    SCENARIOS[name][1](park);
  }, 90_000);
}
