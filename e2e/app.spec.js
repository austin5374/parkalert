// The guest's-eye tests: real WebKit on an emulated iPhone, against the
// stress lab. Every test fails on any page error or console error.
import { test, expect } from '@playwright/test';

const LAB = 'http://127.0.0.1:4210';
const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const scenario = (name, park = MK) => fetch(`${LAB}/lab/scenario`, { method: 'POST', body: JSON.stringify({ park, name }) });
const labState = async () => (await fetch(`${LAB}/lab/state`)).json();
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

let errors;
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack || ''}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(() => localStorage.setItem('parkalert.alertsReady.MKLABS', '1'));
  await page.goto('/?trip=MKLABS');
  await page.waitForFunction(() => typeof dash !== 'undefined' && dash && document.querySelector('#down-list [data-key]:not([data-key=skeleton])'));
});
test.afterEach(async ({ page }) => {
  await scenario('recover');
  await page.evaluate(() => fetch('/api/trips/MKLABS', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mute: null }) })).catch(() => {});
  expect(errors, errors.join('\n')).toEqual([]);
});

// How many pages are really on screen, and whether any is stranded part way.
const pageState = (page) => page.evaluate(() => ({
  count: document.querySelectorAll('#pages .page').length,
  depth: pages.depth,
  stranded: [...document.querySelectorAll('#pages .page')].filter((p) => {
    const m = /translate3d\((-?[\d.]+)px/.exec(p.style.transform);
    return m && Math.abs(Number(m[1])) > 1 && p === document.querySelector('#pages .page:last-of-type');
  }).length,
}));

test('Back then quickly opening another ride leaves exactly one page, fully in place', async ({ page }) => {
  const ids = await page.evaluate(() => dash.rides.filter((r) => !r.other).slice(0, 2).map((r) => r.id));
  await page.evaluate((id) => openRide(id), ids[0]);
  await settle(page, 600);
  // Back and a new page inside the same slide-out: the ghost-page race.
  await page.evaluate((id) => { pages.back(); setTimeout(() => openRide(id), 60); }, ids[1]);
  await settle(page, 2000);
  const st = await pageState(page);
  expect(st).toEqual({ count: 1, depth: 1, stranded: 0 });
  await expect(page).toHaveURL(new RegExp(`/ride/${ids[1]}`));
});

test('A double tap on a ride opens it once', async ({ page }) => {
  await scenario('breakdown');
  await page.waitForSelector('#view-down [data-ride]', { timeout: 30_000 });
  const card = page.locator('#view-down [data-ride]').first();
  await card.dblclick();
  await settle(page);
  expect((await pageState(page)).count).toBe(1);
});

test('Back closes the page and the address returns to the app', async ({ page }) => {
  await scenario('breakdown');
  await page.waitForSelector('#view-down [data-ride]', { timeout: 30_000 });
  await page.locator('#view-down [data-ride]').first().click();
  await settle(page);
  expect((await pageState(page)).count).toBe(1);
  await page.goBack();
  await settle(page);
  expect((await pageState(page)).count).toBe(0);
  await expect(page).not.toHaveURL(/\/ride\//);
});

test('A swipe from the left edge closes the page', async ({ page }) => {
  await page.evaluate(() => openRide(dash.rides.find((r) => !r.other).id));
  await settle(page);
  const swiped = await page.evaluate(async () => {
    const host = document.querySelector('#pages');
    try { new Touch({ identifier: 0, target: host, clientX: 0, clientY: 0 }); } catch { return 'no-touch'; }
    const at = (x) => new Touch({ identifier: 1, target: host, clientX: x, clientY: 400 });
    const fire = (type, x) => host.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [at(x)], changedTouches: [at(x)], bubbles: true, cancelable: true }));
    fire('touchstart', 10);
    for (let x = 30; x <= 320; x += 30) { fire('touchmove', x); await new Promise((r) => setTimeout(r, 16)); }
    fire('touchend', 320);
    return 'ok';
  });
  test.skip(swiped === 'no-touch', 'this WebKit build has no Touch constructor');
  await settle(page, 1500);
  expect((await pageState(page)).count).toBe(0);
});

test('Pausing everyone means no alerts while rides break down', async ({ page }) => {
  await page.locator('.tab[data-view=trip]').click();
  await page.locator('#row-pause').click();
  await page.locator('#sheet [data-sheet=pause] .row', { hasText: 'For 1 hour' }).click();
  // Pausing the whole trip asks first; Cancel is the big button.
  await page.locator('#sheet [data-sheet=pause-all] [data-act=all]').click();
  await settle(page, 1500);
  const before = (await labState()).pushes.filter((p) => p.topic === 'lab-mklabs').length;
  await scenario('wave');
  await scenario('breakdown');
  await page.waitForTimeout(25_000); // two polls
  const after = (await labState()).pushes.filter((p) => p.topic === 'lab-mklabs').length;
  expect(after - before).toBe(0);
});

test('A chart being scrubbed is not rebuilt by a refresh', async ({ page }) => {
  const id = await page.evaluate(() => dash.rides.find((r) => r.status === 'OPERATING' && r.waitTime != null).id);
  await page.evaluate((i) => openRide(i), id);
  await page.waitForSelector('.page [data-chart=wait] svg');
  const same = await page.evaluate(async () => {
    const box = document.querySelector('.page [data-chart=wait]');
    const svg = box.querySelector('svg');
    const r = svg.getBoundingClientRect();
    svg.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: r.left + r.width / 2, clientY: r.top + 20, bubbles: true, pointerType: 'touch' }));
    box.dataset.sig = 'changed-under-the-finger';
    await refresh();
    pages.refresh();
    const kept = box.querySelector('svg') === svg;
    svg.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true, pointerType: 'touch' }));
    return kept;
  });
  expect(same).toBe(true);
});

test('A ride page opens its best times and past closures as pages of their own', async ({ page }) => {
  const id = await page.evaluate(() => dash.rides.find((r) => !r.other && r.status === 'OPERATING').id);
  await page.evaluate((i) => openRide(i), id);
  await page.waitForSelector('.page [data-key=rows]');
  for (const act of ['open-best', 'open-history']) {
    const btn = page.locator(`.page:last-of-type [data-act=${act}]`);
    if (!(await btn.count())) continue;
    await btn.click();
    await settle(page, 700);
    expect((await pageState(page)).count).toBe(2);
    await page.goBack();
    await settle(page, 700);
    expect((await pageState(page)).count).toBe(1);
  }
});

test('Every ride row names a land, and the Rides list groups by it', async ({ page }) => {
  await page.evaluate(() => switchView('rides'));
  await page.locator('[data-filter=land]').click();
  const labels = await page.locator('#rides-list .section-label').allTextContents();
  expect(labels).toContain('Tomorrowland');
  expect(labels[labels.length - 1] === 'Other rides' || !labels.includes('Other rides')).toBe(true);
});

test('Nothing on screen says a ride broke down', async ({ page }) => {
  await scenario('breakdown');
  await scenario('wave');
  await settle(page, 25_000);
  await page.evaluate(() => { document.querySelector('[data-act=toggle-others]')?.click(); });
  await settle(page, 500);
  expect(await page.locator('body').innerText()).not.toMatch(/broke/i);
});

test('Two minutes of an impatient guest: random taps, backs and scenarios', async ({ page }) => {
  test.setTimeout(180_000);
  const names = ['breakdown', 'wave', 'storm', 'clear', 'flap', 'rush', 'calm'];
  const end = Date.now() + 120_000;
  const log = [];
  let i = 0;
  while (Date.now() < end) {
    if (i % 15 === 0) await scenario(names[(i / 15) % names.length]);
    const action = await page.evaluate((n) => {
      if (!document.querySelector('#sheet-layer')) return `left the app: ${location.href}`;
      const sheetUp = !document.querySelector('#sheet-layer').classList.contains('hidden');
      if (sheetUp) { document.querySelector('#scrim').click(); return 'scrim'; }
      if (n % 7 === 0 && pages.depth) { pages.back(); return 'back'; }
      const pick = [...document.querySelectorAll('#pages .page:last-of-type [data-act^=open-], #pages .page:last-of-type [data-ride], #app [data-ride], .tab, [data-filter], [data-act=toggle-others]')]
        .filter((el) => el.offsetParent !== null && !el.closest('[inert]'));
      const el = pick[Math.floor(Math.random() * pick.length)];
      el?.click();
      return el ? (el.dataset.ride ? 'ride' : el.dataset.act || el.dataset.view || el.id || 'tap') : 'none';
    }, i);
    if (String(action).startsWith('left the app')) throw new Error(`${action} after ${log.slice(-8).join(' > ')}`);
    log.push(action);
    await page.waitForTimeout(150 + Math.random() * 400);
    i++;
  }
  await settle(page, 2000);
  const st = await pageState(page);
  expect(st.stranded).toBe(0);
  expect(st.count).toBe(st.depth);
});
