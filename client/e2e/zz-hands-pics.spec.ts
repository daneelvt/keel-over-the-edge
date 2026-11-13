// SPDX-License-Identifier: AGPL-3.0-only
import { type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { openScene } from './helpers';

const OUT = '/private/tmp/claude-501/-Users-daneel-dev-keel-over-the-edge-design/b4b95c91-8657-4f1b-8e5f-d371c4673fd9/scratchpad/pics82c/page';
test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });

async function fly(page: Page, eye: number[], at: number[]) {
  await page.evaluate(async ({ eye, at }) => {
    const k = globalThis.keel;
    const s = k.boat().state;
    const h = s.heading;
    const w = (p: number[]) => ({ east: s.x + p[0] * Math.cos(h) - p[2] * Math.sin(h), north: s.y - p[0] * Math.sin(h) - p[2] * Math.cos(h), up: p[1] });
    const e = w(eye); const t = w(at);
    const bearing = (Math.atan2(t.east - e.east, t.north - e.north) * 180) / Math.PI;
    const pitch = (Math.atan2(t.up - e.up, Math.hypot(t.east - e.east, t.north - e.north)) * 180) / Math.PI;
    if (k.freeCam().on) k.landCamera();
    k.fly({ east: e.east, north: e.north, height: e.up, bearing, pitch });
    await k.show();
  }, { eye, at });
}
async function shot(page: Page, name: string, eye: number[], at: number[]) {
  await fly(page, eye, at);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.evaluate(() => globalThis.keel.landCamera());
}
const crew = (page: Page) => page.evaluate(() => {
  const c = globalThis.keel.crew();
  return { gang: c.gang, aloftBand: c.aloftBand, at: c.members.filter((m) => m.work?.phase === 'at').length, going: c.members.filter((m) => m.work?.phase === 'going').length, back: c.members.filter((m) => m.work?.phase === 'back').length, walking: c.members.filter((m) => m.moving !== null).length, side: c.side };
});
/** Sails on, a frame each 0.2 s, until a condition holds or a time passes. */
const until = (page: Page, what: string, seconds: number) => page.evaluate(({ what, seconds }) => {
  const k = globalThis.keel;
  for (let i = 0; i < seconds * 5; i++) {
    k.sailFrames(1, 6);
    const c = k.crew();
    const at = c.members.filter((m) => m.work?.phase === 'at').length;
    const going = c.members.filter((m) => m.work?.phase === 'going').length;
    if (what === 'after' && c.gang?.group === 'after') return i;
    if (what === 'fore' && c.gang?.group === 'fore') return i;
    if (what === 'coil' && c.gang !== null && c.gang.coil > 0) return i;
    if (what === 'idle' && c.gang === null && c.members.every((m) => m.moving === null && m.work == null)) return i;
    if (what === 'hauling' && at >= 10) return i;
    if (what === 'aloft' && c.aloftBand > 0 && going === 0 && at >= 6) return i;
    if (what === 'down' && c.aloftBand === 0) return i;
  }
  return -1;
}, { what, seconds });

async function underWay(page: Page, n = 40) {
  await openScene(page, 'boat=tall-ship');
  await page.evaluate(async (n) => {
    const k = globalThis.keel;
    k.setSky(14);
    k.setWind(16, 0);
    await k.showCrew(n, 0);
    await k.crewReady();
    k.freezeTick(k.world.ticks);
    k.setControls(0, 0.2);
    for (let i = 0; i < 40; i++) k.sailFrames(1, 30);
    k.autopilot('wind');
    for (let i = 0; i < 10; i++) k.sailFrames(1, 30);
  }, n);
}

const HIGH = [[-20, 24, 26], [0, 4, 1]];
const QD = [[-9.5, 10, 17.5], [-2.2, 5.5, 9]];
const WAIST = [[-10.5, 9, 1], [-3, 3.5, -3.5]];

test('a tack', async ({ page }) => {
  test.setTimeout(400_000);
  await underWay(page);
  await page.evaluate(() => globalThis.keel.autopilot('tack'));
  await shot(page, 'tack-1-ready-about', HIGH[0], HIGH[1]);
  console.log('after', await until(page, 'after', 90), JSON.stringify(await crew(page)));
  await until(page, 'none', 3);
  await shot(page, 'tack-2-mainsail-haul-to-the-braces', HIGH[0], HIGH[1]);
  console.log('hauling', await until(page, 'hauling', 20), JSON.stringify(await crew(page)));
  await shot(page, 'tack-3-mainsail-haul', QD[0], QD[1]);
  await shot(page, 'tack-3b-mainsail-haul-high', HIGH[0], HIGH[1]);
  console.log('fore', await until(page, 'fore', 60), JSON.stringify(await crew(page)));
  await until(page, 'none', 4);
  await shot(page, 'tack-4-let-go-and-haul-forward', HIGH[0], HIGH[1]);
  await until(page, 'none', 8);
  await shot(page, 'tack-5-let-go-and-haul', WAIST[0], WAIST[1]);
  console.log('coil', await until(page, 'coil', 60), JSON.stringify(await crew(page)));
  await until(page, 'none', 2);
  await shot(page, 'tack-6-coiling-down', WAIST[0], WAIST[1]);
  console.log('idle', await until(page, 'idle', 120), JSON.stringify(await crew(page)));
  await shot(page, 'tack-7-on-the-new-tack', [20, 24, 26], [0, 4, 1]);
});

test('a wear', async ({ page }) => {
  test.setTimeout(400_000);
  await underWay(page);
  await page.evaluate(() => globalThis.keel.autopilot('gybe'));
  console.log('after', await until(page, 'after', 120), JSON.stringify(await crew(page)));
  await shot(page, 'wear-1-to-the-after-braces', HIGH[0], HIGH[1]);
  console.log('hauling', await until(page, 'hauling', 20), JSON.stringify(await crew(page)));
  await until(page, 'none', 3);
  await shot(page, 'wear-2-hauling', QD[0], QD[1]);
  console.log('coil', await until(page, 'coil', 60), JSON.stringify(await crew(page)));
  await until(page, 'none', 2);
  await shot(page, 'wear-3-coiling-down', QD[0], QD[1]);
  await until(page, 'none', 10);
  await shot(page, 'wear-4-back', [20, 24, 26], [0, 4, 1]);
});

test('the topgallants taken in', async ({ page }) => {
  test.setTimeout(400_000);
  await underWay(page);
  await page.evaluate(() => globalThis.keel.setReef(1));
  await until(page, 'none', 4);
  await shot(page, 'reef-1-to-the-weather-shrouds', [-16, 14, 8], [-3, 4, -3]);
  console.log('aloft', await until(page, 'aloft', 100), JSON.stringify(await crew(page)));
  await shot(page, 'reef-2-on-the-yards-abeam', [-34, 24, -2], [0, 22, -4]);
  await shot(page, 'reef-3-on-the-yards-from-aloft', [3, 34, 6], [0, 28, -0.6]);
  await shot(page, 'reef-3b-fore-from-aloft', [3, 34, -5], [0, 28, -11.6]);
  console.log('down', await until(page, 'down', 140), JSON.stringify(await crew(page)));
  await until(page, 'none', 14);
  await shot(page, 'reef-4-coming-down', [-16, 14, 8], [-3, 4, -3]);
});

test('a tack seen from a friend', async ({ page }) => {
  test.setTimeout(400_000);
  const ship = data.boats.findIndex((b) => b.capacity >= 40);
  await openScene(page, 'boat=keelboat');
  await page.evaluate(async (ship) => {
    const k = globalThis.keel;
    k.setSky(14);
    const from = k.world.wind.meanFrom;
    const me = k.boat().state;
    const { crew, look } = k.fleetCrew(40, 0, 3);
    const at = { east: me.x + Math.sin(me.heading) * 45 + Math.cos(me.heading) * 25, north: me.y + Math.cos(me.heading) * 45 - Math.sin(me.heading) * 25 };
    (globalThis as unknown as { shipAt: unknown }).shipAt = { ...at, heading: from - 1.2 };
    k.setFleet([{ kind: ship, crew, look, ...at, heading: from - 1.2, yardsTurn: -0.67, foreYardsTurn: -0.67 }]);
    await k.fleetLoaded();
    await k.fleetCrewsReady();
    k.freezeTick(k.world.ticks);
  }, ship);
  const sail = (from: number, seconds: number) => page.evaluate(({ from, seconds }) => {
    const k = globalThis.keel;
    const turn = (t: number, at: number) => Math.max(-0.67, Math.min(0.67, -0.67 + Math.max(0, t - at) * 0.056));
    for (let i = 0; i < seconds * 5; i++) {
      const t = from + i / 5;
      k.moveFleet(0, { yardsTurn: turn(t, 2), foreYardsTurn: turn(t, 22) });
      k.sailFrames(1, 6);
    }
  }, { from, seconds });
  const view = async (name: string) => {
    await page.evaluate(async () => {
      const k = globalThis.keel;
      const s = (globalThis as unknown as { shipAt: { east: number; north: number; heading: number } }).shipAt;
      // 40 m off her port beam, a little aft, 6 m up: as a friend's boat there sees her.
      const h = s.heading;
      const port = { x: -Math.cos(h), y: Math.sin(h) };
      const ahead = { x: Math.sin(h), y: Math.cos(h) };
      const e = { east: s.east + port.x * 40 - ahead.x * 6, north: s.north + port.y * 40 - ahead.y * 6 };
      const bearing = (Math.atan2(s.east - e.east, s.north - e.north) * 180) / Math.PI;
      k.fly({ ...e, height: 6, bearing, pitch: -2 });
      await k.show();
    });
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };
  await sail(0, 1);
  await view('friend-1-ready-about');
  await sail(1, 16);
  await view('friend-2-mainsail-haul');
  await sail(17, 18);
  await view('friend-3-let-go-and-haul');
});
