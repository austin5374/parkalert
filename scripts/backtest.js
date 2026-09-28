// npm run backtest: how good are the reopen ranges on this server's own
// archive? Reads data/history.json and data/weather.json (or DATA_DIR).
import { history, weather } from '../server/store.js';
import { PARKS } from '../server/parks.js';
import { spells, mergeSpells } from '../server/metar.js';
import { backtest } from '../server/backtest.js';

const tls = {};
for (const park of PARKS) {
  const obs = (park.weather || []).map((s) => weather.obs[s] || []);
  tls[park.id] = { thunder: mergeSpells(obs.map((o) => spells(o, 'thunder'))), rain: mergeSpells(obs.map((o) => spells(o, 'rain'))) };
}
const days = Object.values(history.fetched).reduce((n, d) => n + d.length, 0);
const reports = Object.values(weather.obs).reduce((n, o) => n + o.length, 0);
console.log(`Archive: ${days} park-days of outages, ${reports} weather reports.\n`);
console.log('in range: share of reopenings inside the range (about half is right: it is the middle half)');
console.log('width: typical range width, min · miss: typical distance from the middle guess, min');
console.log('within 7: share of reopenings within 7.5 min of the middle guess (a 15-minute window)\n');
const rows = Object.entries(backtest(history.episodes, tls));
if (!rows.length) console.log('Not enough archive yet: it needs at least two days.');
const pad = Math.max(...rows.map(([k]) => k.length), 10);
console.log(`${'group'.padEnd(pad)}  ${'n'.padStart(5)}  in range  width   miss  within 7`);
for (const [k, s] of rows) {
  if (!s.n) continue;
  console.log(`${k.padEnd(pad)}  ${String(s.n).padStart(5)}  ${`${Math.round(s.inRange * 100)}%`.padStart(8)}  ${String(s.width).padStart(5)}  ${String(s.miss).padStart(5)}  ${`${Math.round(s.within7 * 100)}%`.padStart(8)}`);
}
