// SPDX-License-Identifier: AGPL-3.0-only

// The towns in a real browser, in the sandbox on seed 1's world (the file
// go run ./tools/dev -world 1 writes): the boat starts moored in Port
// Royal's basin, facing the narrows; the town is drawn in the factory's
// materials within its budget of draws and triangles, and a town behind
// the horizon is not; chimney smoke is where world time puts it, the same
// on every page; the lanterns ashore are lit after sunset and not by day;
// and pictures of Port Royal from its basin by day and by night, and from
// the roads.

import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene, softwareGPU } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

/** The draws and triangles the town may take at Port Royal on the high rung. */
const DRAWS = 15;
const TRIANGLES = 60_000;

interface Records {
  start: { heading: number; places: [number, number][]; headings?: number[]; moorings?: number };
  towns: { name: string; kind: string; x: number; y: number }[];
}

/** The world file's records, read as the page reads them. */
function records(): Records {
  const b = readFileSync(world);
  const n = b.readUInt32LE(8);
  return JSON.parse(b.subarray(12, 12 + n).toString('utf8')) as Records;
}

/** Renders until the land and its towns about the boat are had. */
async function landed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const k = globalThis.keel;
      k.render();
      const l = k.land();
      const t = k.towns();
      return l !== null && l.stats.inFlight === 0 && l.ready && t !== null && t.held > 0;
    },
    null,
    { timeout: 90_000, polling: 250 },
  );
}

test('the boat starts moored in Port Royal’s basin, facing the narrows; the town is drawn within its budget', async ({
  page,
}) => {
  test.slow(softwareGPU);
  const r = records();
  await openScene(page, 'world=1&wind=0,0', false, true);
  await landed(page);
  const s = await page.evaluate(() => globalThis.keel.boat().state);
  const [x, y] = r.start.places[0] ?? [0, 0];
  expect(Math.hypot(s.x - x, s.y - y)).toBeLessThan(2);
  const off = s.heading - (r.start.headings?.[0] ?? Number.NaN);
  expect(Math.abs(Math.atan2(Math.sin(off), Math.cos(off)))).toBeLessThan(0.05);
  expect(r.start.moorings ?? 0).toBeGreaterThanOrEqual(60);
  // From above the basin, looking at the town: every building near drawn.
  await page.evaluate(() => {
    globalThis.keel.setSky(12);
    globalThis.keel.render();
  });
  await landed(page);
  const t = await page.evaluate(() => globalThis.keel.towns());
  expect(t?.held).toBeGreaterThan(150);
  expect(t?.near).toBeGreaterThan(30);
  expect(t?.draws).toBeLessThanOrEqual(DRAWS);
  expect(t?.triangles).toBeLessThanOrEqual(TRIANGLES);
  expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
  test.info().annotations.push({
    type: 'town',
    description: `${t?.near} buildings near, ${t?.far} far, ${t?.props} props: ${t?.draws} draws, ${t?.triangles} triangles`,
  });
});

test('a town below the horizon is not drawn', async ({ page }) => {
  test.slow(softwareGPU);
  await openScene(page, 'world=1&wind=0,0');
  await landed(page);
  // 1.8 km east of Port Royal, the eye 6.5 m up: its town's tops are below
  // the horizon (180 m and at most 380 m for a tower's 30 m).
  await page.evaluate(() => {
    globalThis.keel.placeBoat(1800, 71, Math.PI / 2);
    globalThis.keel.render();
    globalThis.keel.render();
  });
  const t = await page.evaluate(() => globalThis.keel.towns());
  expect((t?.near ?? 0) + (t?.far ?? 0)).toBe(0);
});

test('chimney smoke is where world time puts it, the same on two pages', async ({ browser }) => {
  test.slow(softwareGPU);
  const puffs: number[][] = [];
  for (let k = 0; k < 2; k++) {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    await openScene(page, 'world=1&wind=10,0');
    await page.evaluate(() => globalThis.keel.placeBoat(-60, 40, 0));
    await landed(page);
    // The wind at a chimney is asked of the module again after 300 ms: one
    // asked before its shelter was held must not be the one drawn.
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.setSky(12);
      k.freezeTick(3000);
      k.render();
      k.render();
    });
    const t = await page.evaluate(() => globalThis.keel.towns());
    expect(t?.puffs).toBeGreaterThan(0);
    puffs.push(t?.puff ?? []);
    await page.close();
  }
  expect(puffs[0]?.length).toBeGreaterThan(0);
  expect(puffs[1]).toEqual(puffs[0]);
});

test('the lanterns ashore are lit after sunset, and not by day', async ({ page }) => {
  test.slow(softwareGPU);
  await openScene(page, 'world=1&wind=0,0');
  await page.evaluate(() => globalThis.keel.placeBoat(-60, 40, 0));
  await landed(page);
  const lit = async (hour: number): Promise<number> =>
    page.evaluate((h) => {
      const k = globalThis.keel;
      k.setSky(h);
      k.render();
      return k.towns()?.lanternsLit ?? 0;
    }, hour);
  expect(await lit(12)).toBe(0);
  expect(await lit(22)).toBeGreaterThan(10);
});

test.describe('pictures', () => {
  const views: {
    name: string;
    hour: number;
    at: { east: number; north: number; height: number; bearing: number; pitch: number };
    /** Whether the boat is put where the camera is, for the land about it to be had. */
    boat?: boolean;
  }[] = [
    {
      name: 'basin-day',
      hour: 10,
      at: { east: 140, north: -20, height: 45, bearing: -50, pitch: -18 },
    },
    {
      name: 'basin-night',
      hour: 22,
      at: { east: 140, north: -20, height: 45, bearing: -50, pitch: -18 },
    },
    { name: 'quay-day', hour: 9, at: { east: 10, north: 50, height: 10, bearing: -40, pitch: -5 } },
    {
      name: 'roads-day',
      hour: 12,
      at: { east: 290, north: -320, height: 30, bearing: -18, pitch: -4 },
      boat: true,
    },
  ];
  for (const v of views) {
    test(`${v.name} @long`, async ({ page }) => {
      test.slow(softwareGPU);
      await openScene(page, 'world=1&wind=10,0');
      if (v.boat === true) {
        // Out on the roads, the land streams in about the boat, not the camera.
        await page.evaluate((v) => globalThis.keel.placeBoat(v.at.east, v.at.north, 0), v);
      }
      await landed(page);
      await page.evaluate((v) => {
        const k = globalThis.keel;
        k.setSky(v.hour);
        k.fly(v.at);
      }, v);
      await page.waitForTimeout(1500);
      await landed(page);
      await test
        .info()
        .attach(`town-${v.name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
});
