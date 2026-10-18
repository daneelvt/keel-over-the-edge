// SPDX-License-Identifier: AGPL-3.0-only

// The islands' plants and features in a real browser, in the sandbox on
// seed 1's world (the file go run ./tools/dev -world 1 writes): the plants
// are drawn at Port Royal's mooring within their budget of draws and
// triangles, in the factory's materials; the same plants, birds and spouts
// stand at the same world time on two pages; and pictures from the sea of
// an arch, a tropical waterfall, a smoking crater, a colony, and the woods
// of Port Royal's island.

import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene, softwareGPU } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);
const catalogFile = new URL('../src/catalog/catalog.gen.json', import.meta.url);

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

/** The plants' draws and triangles at Port Royal on the high rung (the rung's budget). */
const DRAWS = 10;
const TRIANGLES = 40_000;

interface Feature {
  kind: string;
  island: number;
  x: number;
  y: number;
  seen: boolean;
  sightX: number;
  sightY: number;
}

interface Records {
  islands: { biome: string; x: number; y: number; across: number }[];
  features: Feature[];
  start: { places: [number, number][]; headings?: number[] };
}

/** The world file's records, read as the page reads them. */
function records(): Records {
  const b = readFileSync(world);
  const n = b.readUInt32LE(8);
  return JSON.parse(b.subarray(12, 12 + n).toString('utf8')) as Records;
}

/** The kinds of feature's sites, by id; the biomes with mangroves; every biome. */
function kinds(): { site: Map<string, string>; tropical: Set<string>; biomes: string[] } {
  const c = JSON.parse(readFileSync(catalogFile, 'utf8')) as {
    world: {
      features: { kinds: { id: string; site: string }[] };
      biomes: { id: string; mangroves: boolean }[];
    };
  };
  return {
    site: new Map(c.world.features.kinds.map((k) => [k.id, k.site])),
    tropical: new Set(c.world.biomes.filter((b) => b.mangroves).map((b) => b.id)),
    biomes: c.world.biomes.map((b) => b.id),
  };
}

/**
 * Renders until the land about the boat is had and the plants' models are
 * loaded; with parts, until some feature's parts are held too. Moving the
 * boat lets the land go, and it is handed anew only every half second, so
 * some land must be drawn again.
 */
async function landed(page: Page, parts = false): Promise<void> {
  await page.waitForFunction(
    (parts) => {
      const k = globalThis.keel;
      k.render();
      const l = k.land();
      const f = k.flora();
      return (
        l !== null &&
        l.drawn.length > 0 &&
        l.stats.inFlight === 0 &&
        l.ready &&
        f !== null &&
        (f.held === 0 || f.loaded) &&
        (!parts || (k.features()?.parts ?? 0) > 0)
      );
    },
    parts,
    { timeout: 90_000, polling: 250 },
  );
}

test('the plants are drawn at Port Royal’s mooring within their budget', async ({ page }) => {
  test.slow(softwareGPU);
  await openScene(page, 'world=1&wind=0,0', false, true);
  await page.evaluate(() => {
    globalThis.keel.setSky(12);
    globalThis.keel.render();
  });
  await landed(page);
  // Looking up at the island from the mooring.
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.render();
    k.camera({ azimuth: Math.PI, elevation: 0.2, distance: 40 });
    k.render();
  });
  const f = await page.evaluate(() => globalThis.keel.flora());
  expect(f?.held).toBeGreaterThan(500);
  expect((f?.near ?? 0) + (f?.far ?? 0)).toBeGreaterThan(20);
  expect(f?.draws).toBeLessThanOrEqual(DRAWS);
  expect(f?.triangles).toBeLessThanOrEqual(TRIANGLES);
  expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
  test.info().annotations.push({
    type: 'flora',
    description: `${f?.near} plants near, ${f?.far} far: ${f?.draws} draws, ${f?.triangles} triangles`,
  });
});

test('the same plants, birds and spouts at the same world time on two pages', async ({
  browser,
}) => {
  test.slow(softwareGPU);
  const r = records();
  const { site } = kinds();
  const colony = r.features.find((f) => site.get(f.kind) === 'colony' && f.seen);
  test.skip(colony === undefined, 'no colony in seed 1');
  const seen: unknown[] = [];
  const speeds: number[] = [];
  for (let k = 0; k < 2; k++) {
    const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
    await openScene(page, 'world=1&wind=8,90');
    await page.evaluate((c) => globalThis.keel.placeBoat(c.sightX, c.sightY, 0), colony as Feature);
    await landed(page, true);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.freezeTick(3000);
      k.setSky(12);
      k.render();
      k.render();
    });
    const f = await page.evaluate(() => ({
      flora: globalThis.keel.flora(),
      features: globalThis.keel.features(),
    }));
    expect(f.features?.birds).toBeGreaterThan(0);
    // The wind the plants sway in is eased over the frames each page drew.
    speeds.push(f.flora?.speed ?? 0);
    seen.push({ ...f, flora: { ...f.flora, speed: 0 } });
    await page.close();
  }
  expect(seen[1]).toEqual(seen[0]);
  expect(speeds[1]).toBeCloseTo(speeds[0] ?? 0, 1);
});

test.describe('pictures of the features from the sea', () => {
  const r = existsSync(world) ? records() : { islands: [], features: [], start: { places: [] } };
  const { site, tropical, biomes } = existsSync(catalogFile)
    ? kinds()
    : { site: new Map(), tropical: new Set(), biomes: [] };
  const first = (ok: (f: Feature) => boolean): Feature | undefined =>
    r.features.find((f) => f.seen && ok(f));
  const views: { name: string; f: Feature | undefined; back: number }[] = [
    { name: 'arch', f: first((f) => site.get(f.kind) === 'arch'), back: 70 },
    {
      name: 'tropical-waterfall',
      f: first(
        (f) => site.get(f.kind) === 'waterfall' && tropical.has(r.islands[f.island]?.biome ?? ''),
      ),
      back: 10,
    },
    { name: 'smoking-crater', f: first((f) => site.get(f.kind) === 'fumarole'), back: 160 },
    { name: 'colony', f: first((f) => site.get(f.kind) === 'colony'), back: 90 },
  ];
  for (const v of views) {
    test(`${v.name} @long`, async ({ page }) => {
      test.skip(v.f === undefined, `no ${v.name} in seed 1`);
      const f = v.f as Feature;
      // Back from where it is seen, on the line from it, facing it.
      const dx = f.x - f.sightX;
      const dy = f.y - f.sightY;
      const l = Math.hypot(dx, dy) || 1;
      const east = f.sightX - (dx / l) * v.back;
      const north = f.sightY - (dy / l) * v.back;
      await openScene(page, 'world=1&wind=6,90');
      await page.evaluate(
        ([e, n, h]) => {
          const k = globalThis.keel;
          k.placeBoat(e ?? 0, n ?? 0, h);
          k.freezeTick(3000);
          k.setSky(12);
          k.render();
        },
        [east, north, Math.atan2(dx, dy)],
      );
      await landed(page, true);
      await page.evaluate(async () => {
        const k = globalThis.keel;
        k.render();
        k.camera({ azimuth: 0, elevation: 0.12, distance: 14 });
        await k.show();
      });
      await expect.soft(page.locator('canvas.scene')).toHaveScreenshot(`features-${v.name}.png`);
    });
  }
  // Each biome's widest island but the start's, from offshore on the side
  // of the world's middle, facing it.
  const [sx, sy] = r.start.places[0] ?? [0, 0];
  for (const biome of biomes) {
    const island = r.islands
      .filter((i) => i.biome === biome && Math.hypot(i.x - sx, i.y - sy) > i.across / 2)
      .sort((a, b) => b.across - a.across)[0];
    test(`a ${biome} island @long`, async ({ page }) => {
      test.skip(island === undefined, `no ${biome} island in seed 1`);
      const i = island as Records['islands'][number];
      const l = Math.hypot(i.x, i.y) || 1;
      const off = i.across / 2 + 200;
      const p = { x: i.x - (i.x / l) * off, y: i.y - (i.y / l) * off };
      await openScene(page, 'world=1&wind=6,90');
      await page.evaluate(
        ([e, n, h]) => {
          const k = globalThis.keel;
          k.placeBoat(e ?? 0, n ?? 0, h);
          k.freezeTick(3000);
          k.setSky(12);
          k.render();
        },
        [p.x, p.y, Math.atan2(i.x - p.x, i.y - p.y)],
      );
      await landed(page);
      await page.evaluate(async () => {
        const k = globalThis.keel;
        k.render();
        k.camera({ azimuth: 0, elevation: 0.12, distance: 25 });
        await k.show();
      });
      await expect
        .soft(page.locator('canvas.scene'))
        .toHaveScreenshot(`features-island-${biome}.png`);
    });
  }
  test('Port Royal’s woods @long', async ({ page }) => {
    // From the start's mooring, the island across the basin.
    const [e, n] = r.start.places[0] ?? [0, 0];
    await openScene(page, 'world=1&wind=6,90');
    await page.evaluate(
      ([e, n]) => {
        const k = globalThis.keel;
        k.placeBoat(e ?? 0, n ?? 0, 3.6);
        k.freezeTick(3000);
        k.setSky(12);
        k.render();
      },
      [e, n],
    );
    await landed(page);
    await page.evaluate(async () => {
      const k = globalThis.keel;
      k.render();
      k.camera({ azimuth: 0, elevation: 0.12, distance: 25 });
      await k.show();
    });
    await expect.soft(page.locator('canvas.scene')).toHaveScreenshot('features-woods.png');
  });
});
