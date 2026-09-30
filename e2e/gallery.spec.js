// A screenshot of every main screen at three iPhone sizes, light and dark,
// for a design review: npm run gallery (then open e2e/gallery/index.html).
// Not part of npm run e2e; it asserts nothing, it looks.
import { test, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const LAB = 'http://127.0.0.1:4210';
const MK = '75ea578a-adc8-4116-a54d-dccb60765ef9';
const OUT = path.join(process.cwd(), 'e2e', 'gallery');
const PHONES = { 'iPhone SE': devices['iPhone SE'], 'iPhone 15 Pro': devices['iPhone 15 Pro'], 'iPhone 15 Pro Max': devices['iPhone 15 Pro Max'] };
const shots = [];

test.skip(!process.env.GALLERY, 'run with npm run gallery');

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of ['storm', 'wave', 'breakdown']) await fetch(`${LAB}/lab/scenario`, { method: 'POST', body: JSON.stringify({ park: MK, name }) });
  // Long enough for the lab's lightning to reach the weather check.
  await new Promise((r) => setTimeout(r, 70_000));
});

for (const [phone, device] of Object.entries(PHONES)) {
  for (const scheme of ['light', 'dark']) {
    test(`${phone} ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ ...device, colorScheme: scheme, serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem('parkalert.alertsReady.MKLABS', '1'));
      await page.goto('http://127.0.0.1:3210/?trip=MKLABS');
      await page.waitForFunction(() => typeof dash !== 'undefined' && dash && document.querySelector('#down-list [data-key]:not([data-key=skeleton])'));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const snap = async (label) => {
        await page.waitForTimeout(400);
        const file = `${phone.replace(/ /g, '-')}-${scheme}-${label}.png`;
        await page.screenshot({ path: path.join(OUT, file), fullPage: false });
        shots.push({ phone, scheme, label, file });
      };
      await snap('01-down-now');
      await page.evaluate(() => { document.querySelector('[data-act=toggle-others]')?.click(); window.scrollTo(0, 360); });
      await snap('02-down-scrolled');
      await page.evaluate(() => { document.querySelector('[data-act=toggle-others]')?.click(); window.scrollTo(0, 0); switchView('rides'); });
      await snap('03-rides');
      await page.evaluate(() => switchView('trip'));
      await snap('04-trip');
      await page.evaluate(() => { switchView('down'); openRide(dash.rides.find((r) => r.status === 'DOWN' && r.outlook?.kind !== 'hold' && !r.other)?.id || dash.rides.find((r) => r.status === 'DOWN').id); });
      await page.waitForTimeout(1500);
      await snap('05-ride-down');
      await page.evaluate(() => { pages.clear(); openRide(dash.rides.find((r) => r.status === 'OPERATING' && r.waitTime != null && !r.other).id); });
      await page.waitForTimeout(1500);
      await snap('06-ride-open');
      await page.evaluate(() => document.querySelector('.page [data-act=wait-sheet]')?.click());
      await snap('07-wait-alert');
      await page.evaluate(() => { document.querySelector('#scrim').click(); });
      await page.waitForTimeout(500);
      await page.evaluate(() => { pages.clear(); if (dash.rides.some((r) => r.outlook?.kind === 'hold')) openHold(); });
      await page.waitForTimeout(800);
      await snap('08-hold');
      await page.evaluate(() => { pages.clear(); openParkInfo(); });
      await page.waitForTimeout(1500);
      await snap('09-park');
      await page.evaluate(() => { pages.clear(); openPause(); });
      await snap('10-pause-sheet');
      await page.evaluate(() => { document.querySelector('#scrim').click(); });
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelector('#btn-choose').click());
      await snap('11-choose');
      await page.evaluate(() => { document.querySelector('#scrim').click(); });
      await page.waitForTimeout(500);
      await page.evaluate(() => { document.documentElement.style.fontSize = '170%'; dispatchEvent(new Event('resize')); renderAll(); });
      await snap('12-large-text');
      await context.close();
    });
  }
}

test.afterAll(() => {
  const rows = [...new Set(shots.map((s) => s.label))].sort().map((label) => `<h2>${label}</h2><div class=row>${shots.filter((s) => s.label === label)
    .map((s) => `<figure><img src="${s.file}" loading=lazy><figcaption>${s.phone} · ${s.scheme}</figcaption></figure>`).join('')}</div>`).join('');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset=utf-8><title>ParkAlert gallery</title>
<style>body{font:14px system-ui;background:#888;margin:16px}.row{display:flex;gap:12px;overflow-x:auto}figure{margin:0}img{width:260px;border-radius:12px;display:block}figcaption{color:#fff;margin:4px 0 16px}</style>${rows}`);
});
