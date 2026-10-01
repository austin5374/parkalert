// The sky at the top of Down now and along detail pages: the park's own
// coaster track (never a real park building), lit for the time of day and
// the weather. Flat shapes in the app icon's style, drawn once per park,
// time and weather and reused.
//
// Everything drawn in the sky keeps to the right third and the ground, clear
// of the words, which sit on the left. Detail strips draw no sun, moon or
// clouds at all, so titles and buttons always sit on a clear sky.
/* exported sceneSvg, sceneMood */
'use strict';

const SCENE_W = 400;
const SCENE_H = 280;

// Each park's track ends in its landmark on the right.
const SCENE_TRACKS = {
  mk: 'M-10 262 C 60 262, 90 244, 140 244 C 190 244, 240 258, 295 252 C 336 247, 380 230, 380 206 C 380 186, 368 176, 354 176 C 338 176, 328 188, 328 204 C 328 224, 348 238, 370 244 C 386 249, 398 250, 410 248',
  epcot: 'M-10 250 L 180 250 C 250 250, 290 214, 330 214 C 370 214, 390 236, 410 240',
  ak: 'M-10 256 C 30 256, 50 232, 80 232 C 110 232, 120 256, 150 256 C 180 256, 196 228, 226 228 C 256 228, 264 254, 292 254 C 320 254, 334 222, 360 222 C 384 222, 396 244, 410 246',
  hs: 'M-10 262 C 70 262, 150 256, 250 254 C 300 253, 318 250, 330 236 L 348 150 C 352 140, 362 140, 366 150 L 386 236 C 390 246, 400 250, 410 250',
  dl: 'M-10 258 C 60 258, 120 252, 180 252 C 240 252, 262 236, 290 222 C 318 208, 340 190, 364 190 C 388 190, 392 214, 372 222 C 350 230, 320 214, 300 204 C 280 194, 262 190, 250 200 C 238 210, 250 228, 290 238 C 330 248, 380 252, 410 250',
  dca: 'M-10 258 C 80 258, 160 250, 230 246 C 290 242, 312 190, 342 190 C 372 190, 384 238, 410 244',
};
const SCENE_SUPPORTS = {
  mk: [310, 340, 372, 60, 140, 220],
  epcot: [60, 140, 220, 300, 350],
  ak: [50, 80, 120, 170, 226, 262, 300, 360, 390],
  hs: [300, 348, 366, 120],
  dl: [100, 200, 262, 300, 330, 364, 382],
  dca: [120, 240, 310, 342, 372],
};

// Midday ground and tree shapes for each park; other times of day use the
// time's own colors, keeping the park's track and trees.
const SCENE_PARKS = {
  mk: { far: '#78aad6', trees: '#31567c', ground: '#284866', tree: 'round', tint: '#1f6fbf' },
  epcot: { far: '#7cc3c9', trees: '#1f6468', ground: '#1a5054', tree: 'hedge', tint: '#1c7a9a' },
  ak: { far: '#8fbf92', trees: '#2a5c3a', ground: '#1f4a2e', tree: 'palm', tint: '#2a7d8c' },
  hs: { far: '#a3a9c4', trees: '#3c4460', ground: '#2e3550', tree: 'poles', tint: '#2d5fa6' },
  dl: { far: '#e8b58a', trees: '#b0643a', ground: '#8f4d2c', tree: 'round', tint: '#3a78c0' },
  dca: { far: '#9fcfd0', trees: '#2f6f73', ground: '#23585c', tree: 'palm', tint: '#2479b5' },
};

const SCENE_STATES = {
  morning: { sky: [['0', '#2a64a3'], ['.5', '#5f9bd0'], ['1', '#f1cf9f']], far: '#8aaed0', trees: '#46658a', ground: '#3a5676', sun: [300, 140, 12, '#ffe3a3'], clouds: [], cloud: '#ffffff', cloudOp: 0.55, stars: 0, rain: false, scrim: 0.62 },
  day: { sky: [['0', '#1f6fbf'], ['.55', '#5aa2e4'], ['1', '#b7dcfa']], far: '#78aad6', trees: '#31567c', ground: '#284866', clouds: [[300, 166, 0.6]], cloud: '#ffffff', cloudOp: 0.75, stars: 0, rain: false, scrim: 0.62 },
  dusk: { sky: [['0', '#0a1a33'], ['.45', '#17406b'], ['.7', '#2f6a8f'], ['.86', '#e98a4a'], ['1', '#ff9f55']], far: '#3a5d84', trees: '#132641', ground: '#0e1e36', sun: [122, 236, 20, '#ffb772'], clouds: [], cloud: '#f3a26c', cloudOp: 0.4, stars: 6, rain: false, scrim: 0 },
  night: { sky: [['0', '#040b18'], ['.55', '#0a1a33'], ['1', '#17406b']], far: '#193355', trees: '#071325', ground: '#050e1d', moon: [362, 124], clouds: [], cloud: '#9fb4d0', cloudOp: 0.12, stars: 12, rain: false, scrim: 0 },
  storm: { sky: [['0', '#1f252f'], ['.55', '#343d4b'], ['1', '#56606f']], far: '#4a5465', trees: '#222934', ground: '#1a2029', clouds: [[318, 172, 0.7]], cloud: '#161b23', cloudOp: 0.6, stars: 0, rain: true, scrim: 0 },
};

// The same shapes every time for the same seed, so a redraw never shuffles
// the stars or the trees.
function sceneRandom(seed) {
  let a = seed >>> 0;
  return (lo, hi) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return lo + r * (hi - lo);
  };
}

const f1 = (n) => n.toFixed(1);

function sceneCloud(cx, cy, s) {
  const parts = [[0, 0, 10], [11, -6, 12], [24, -2, 10], [-9, 3, 7]];
  return parts.map(([dx, dy, r]) => `<circle cx="${f1(cx + dx * s)}" cy="${f1(cy + dy * s)}" r="${f1(r * s)}"/>`).join('')
    + `<rect x="${f1(cx - 9 * s)}" y="${f1(cy)}" width="${f1(42 * s)}" height="${f1(9 * s)}" rx="${f1(4.5 * s)}"/>`;
}

function sceneTrees(kind, color) {
  const rnd = sceneRandom(7);
  const out = [];
  if (kind === 'poles') {
    for (let x = 0; x < SCENE_W;) {
      const w = rnd(24, 46);
      out.push(`<rect x="${f1(x)}" y="${f1(246 - rnd(0, 10))}" width="${f1(w - 3)}" height="40"/>`);
      x += w;
    }
    for (const px of [40, 150, 262]) out.push(`<rect x="${px}" y="214" width="2" height="40"/><circle cx="${px + 1}" cy="213" r="3.2"/>`);
  } else if (kind === 'palm') {
    for (let x = -4; x < SCENE_W + 8;) {
      const r = rnd(6, 10);
      out.push(`<ellipse cx="${f1(x)}" cy="${f1(250 + rnd(-2, 2))}" rx="${f1(r * 1.3)}" ry="${f1(r * 0.8)}"/>`);
      x += rnd(8, 13);
    }
    for (const px of [70, 205]) {
      out.push(`<rect x="${px}" y="222" width="2.4" height="30"/><path d="M${px + 1} 222c-10 -2 -16 3 -18 8c6 -5 12 -5 18 -8zm0 0c10 -2 16 3 18 8c-6 -5 -12 -5 -18 -8zm0 0c-4 -8 -12 -10 -16 -8c6 1 11 4 16 8zm0 0c4 -8 12 -10 16 -8c-6 1 -11 4 -16 8z"/>`);
    }
  } else if (kind === 'hedge') {
    out.push(`<rect x="0" y="246" width="${SCENE_W}" height="40" rx="4"/>`);
    for (let x = 10; x < SCENE_W;) {
      out.push(`<rect x="${f1(x)}" y="240" width="${f1(rnd(18, 34))}" height="12" rx="6"/>`);
      x += rnd(30, 50);
    }
  } else {
    for (let x = -4; x < SCENE_W + 8;) {
      out.push(`<circle cx="${f1(x)}" cy="${f1(250 + rnd(-2, 2))}" r="${f1(rnd(5, 9))}"/>`);
      x += rnd(6, 10);
    }
  }
  out.push(`<rect x="0" y="250" width="${SCENE_W}" height="${SCENE_H}"/>`);
  return `<g fill="${color}">${out.join('')}</g>`;
}

// Which park's scene: by its name, as parks.js has it.
function sceneParkKey(parkName = '') {
  const n = parkName.toLowerCase();
  if (n.includes('epcot')) return 'epcot';
  if (n.includes('animal kingdom')) return 'ak';
  if (n.includes('hollywood')) return 'hs';
  if (n.includes('california adventure')) return 'dca';
  if (n.includes('disneyland')) return 'dl';
  return 'mk';
}

// The time of day on the park's clock, or the weather when it is storming.
//   hour: 0-23 at the park; storm: lightning or rain closing rides now
function sceneMood(hour, storm) {
  if (storm) return 'storm';
  if (hour >= 20 || hour < 6) return 'night';
  if (hour >= 18) return 'dusk';
  if (hour < 11) return 'morning';
  return 'day';
}

const sceneCache = new Map();
//   mood: from sceneMood; parkName: the park's name
//   opts.strip: a detail page's strip (no sun, moon or clouds)
//   opts.train: 'stopped' (with the icon's red dot) or 'running'
//   opts.align: how the picture fills its box
function sceneSvg(mood, parkName, { strip = false, train = null, align = 'xMaxYMax' } = {}) {
  const park = sceneParkKey(parkName);
  const cacheKey = `${mood}|${park}|${strip}|${train}|${align}`;
  const hit = sceneCache.get(cacheKey);
  if (hit) return hit;
  const c = { ...SCENE_STATES[mood] };
  const p = SCENE_PARKS[park];
  if (mood === 'day') Object.assign(c, { far: p.far, trees: p.trees, ground: p.ground, sky: [['0', p.tint], ...c.sky.slice(1)] });
  if (strip) Object.assign(c, { clouds: [], sun: null, moon: null, stars: 0 });
  const uid = `s${sceneCache.size}`;
  const stops = c.sky.map(([o, col]) => `<stop offset="${o}" stop-color="${col}"/>`).join('');
  const out = [
    `<svg class="scene-art" viewBox="0 0 ${SCENE_W} ${SCENE_H}" preserveAspectRatio="${align} slice" aria-hidden="true" focusable="false">`,
    `<defs><linearGradient id="g${uid}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`,
    `<linearGradient id="k${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1e3c" stop-opacity="${c.scrim}"/><stop offset=".45" stop-color="#0a1e3c" stop-opacity="${(c.scrim * 0.8).toFixed(2)}"/><stop offset=".75" stop-color="#0a1e3c" stop-opacity="0"/></linearGradient></defs>`,
    `<rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#g${uid})"/>`,
  ];
  if (c.scrim) out.push(`<rect width="${SCENE_W}" height="${SCENE_H}" fill="url(#k${uid})"/>`);
  const rnd = sceneRandom(3);
  for (let i = 0; i < c.stars; i++) {
    out.push(`<circle cx="${f1(rnd(290, SCENE_W))}" cy="${f1(rnd(96, 200))}" r="${rnd(0.6, 1.3).toFixed(2)}" fill="#fff" opacity="${rnd(0.4, 0.9).toFixed(2)}"/>`);
  }
  if (c.sun) out.push(`<circle cx="${c.sun[0]}" cy="${c.sun[1]}" r="${c.sun[2]}" fill="${c.sun[3]}"/>`);
  if (c.moon) out.push(`<path d="M${c.moon[0] + 2} ${c.moon[1] - 11}a11 11 0 1 0 9 17a9 9 0 1 1 -9 -17Z" fill="#f4f1e2"/>`);
  if (c.clouds.length) out.push(`<g fill="${c.cloud}" opacity="${c.cloudOp}">${c.clouds.map(([x, y, s]) => sceneCloud(x, y, s)).join('')}</g>`);
  out.push(`<path d="M0 238C50 224 100 222 150 230S250 220 300 228S370 218 400 226V280H0Z" fill="${c.far}"/>`);
  out.push(sceneTrees(p.tree, c.trees));
  const tr = mood === 'storm' ? 0.55 : 0.92;
  out.push(`<g stroke="#fff" stroke-opacity="${(tr * 0.34).toFixed(2)}" stroke-width="1.8"><path d="${SCENE_SUPPORTS[park].map((x) => `M${x} 200V280`).join('')}"/></g>`);
  const t = SCENE_TRACKS[park];
  out.push(`<path d="${t}" fill="none" stroke="#fff" stroke-opacity="${(tr * 0.45).toFixed(2)}" stroke-width="8" stroke-dasharray="1.4 5"/>`);
  out.push(`<path d="${t}" fill="none" stroke="#fff" stroke-opacity="${tr}" stroke-width="2.2"/>`);
  if (park === 'dl') {
    // The front pass of the figure eight, over a gap in the rear rail.
    const front = 'M290 222 C 318 208, 340 190, 364 190';
    out.push(`<clipPath id="x${uid}"><circle cx="312" cy="210" r="12"/></clipPath><g clip-path="url(#x${uid})"><path d="${front}" fill="none" stroke="${c.far}" stroke-width="7"/><path d="${front}" fill="none" stroke="#fff" stroke-opacity="${tr}" stroke-width="2.2"/></g>`);
  }
  if (train === 'running') {
    out.push('<g transform="rotate(-2 150 244)"><rect x="132" y="236" width="13" height="7" rx="2.2" fill="#fff"/><rect x="147" y="236" width="13" height="7" rx="2.2" fill="#fff"/></g>');
  } else if (train === 'stopped') {
    out.push('<g transform="rotate(-5 262 250)"><rect x="244" y="244" width="13" height="7" rx="2.2" fill="#fff"/><rect x="259" y="243" width="13" height="7" rx="2.2" fill="#fff"/></g>');
    out.push('<circle cx="278" cy="232" r="4.6" fill="#ff3b30" stroke="#fff" stroke-width="1.4"/>');
  }
  if (c.rain) {
    const r2 = sceneRandom(11);
    const lines = [];
    for (let i = 0; i < 16; i++) lines.push(`<path d="M${r2(290, SCENE_W).toFixed(0)} ${r2(120, SCENE_H).toFixed(0)}l-4 10"/>`);
    out.push(`<g stroke="#cfd8e6" stroke-opacity=".22" stroke-width="1" stroke-linecap="round">${lines.join('')}</g>`);
  }
  out.push('</svg>');
  const svg = out.join('');
  sceneCache.set(cacheKey, svg);
  return svg;
}
