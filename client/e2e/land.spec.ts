// SPDX-License-Identifier: AGPL-3.0-only

// The land in a real browser, in the sandbox on seed 1's world (the file go
// run ./tools/dev -world 1 writes): Port Royal is drawn from the start, in
// the factory's materials with the dome's bend; the GPU caps the waves on
// every tile of its coast as the physics module does, and draws no tile on
// its land; a chunk below the horizon is not drawn, and one far behind is
// let go and built again on return; a stack's top first shows over the
// sea where the dome says; and running onto its beach, the boat is aground,
// pushed off, and said to be.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { openScene, picture, softwareGPU } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);
const R = 2500;

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

/** Renders until the land has had every chunk within reach of the boat, and has some. */
async function landed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const k = globalThis.keel;
      k.render();
      const l = k.land();
      return l !== null && l.stats.handed > 0 && l.stats.inFlight === 0 && l.ready;
    },
    null,
    { timeout: 60_000, polling: 250 },
  );
}

/** Opens seed 1's world, on flat water, the boat at (east, north) heading heading. */
async function openWorld(page: Page, east: number, north: number, heading: number): Promise<void> {
  await openScene(page, 'world=1&wind=0,0');
  await page.evaluate(
    ([e, n, h]) => {
      globalThis.keel.placeBoat(e ?? 0, n ?? 0, h);
      globalThis.keel.setSky(12);
    },
    [east, north, heading],
  );
  // The sandbox looks again every half second.
  await page.waitForTimeout(800);
  await landed(page);
}

test('Port Royal is drawn from the start, in the factory’s materials', async ({ page }) => {
  await openScene(page, 'world=1');
  await landed(page);
  const l = await page.evaluate(() => globalThis.keel.land());
  expect(l?.stats.meshes).toBeGreaterThan(0);
  expect(l?.drawn.length).toBeGreaterThan(0);
  expect(l?.shore).toBe(1);
  expect(await page.evaluate(() => globalThis.keel.checkScene())).toEqual([]);
});

test('the GPU caps the waves on a coast’s tiles as the module does, and draws none on land', async ({
  page,
}) => {
  // Off Port Royal's eastern beach, in a fresh breeze's sea.
  await openWorld(page, 235, 300, -Math.PI / 2);
  await page.evaluate(() => {
    globalThis.keel.setSea('fresh');
    globalThis.keel.render();
    globalThis.keel.render();
  });
  const g = await page.evaluate(() => globalThis.keel.tileGround());
  let land = 0;
  let capped = 0;
  let worst = 0;
  for (let i = 0; i < g.count; i++) {
    const f = g.gpu[i] ?? Number.NaN;
    if ((g.land[i] ?? 0) > 0.5) {
      land++;
      expect(f).toBe(0);
      continue;
    }
    if (f < 1) {
      capped++;
    }
    worst = Math.max(worst, Math.abs(f - (g.module[i] ?? Number.NaN)));
  }
  expect(land).toBeGreaterThan(100);
  expect(capped).toBeGreaterThan(10);
  expect(worst).toBeLessThan(1e-4);
});

test('a chunk below the horizon is not drawn; one far behind is let go, and built again on return', async ({
  page,
}) => {
  await openWorld(page, 235, 300, Math.PI / 2);
  const port = 136;
  expect((await page.evaluate(() => globalThis.keel.land()))?.drawn).toContain(port);
  // 1.5 km east of its outline: held, but its 36 m are below the horizon
  // from the chase camera's 6.5 m (180 m + 424 m).
  await page.evaluate(() => globalThis.keel.placeBoat(2650, 300, Math.PI / 2));
  await page.evaluate(() => globalThis.keel.render());
  let l = await page.evaluate(() => globalThis.keel.land());
  expect(l?.drawn).not.toContain(port);
  expect(l?.stats.meshes).toBeGreaterThan(0);
  // Far away: let go.
  await page.evaluate(() => globalThis.keel.placeBoat(5000, 300, Math.PI / 2));
  await page.evaluate(() => globalThis.keel.render());
  l = await page.evaluate(() => globalThis.keel.land());
  expect(l?.grids).not.toContain(port);
  const built = l?.stats.meshes ?? 0;
  // Back: built again.
  await page.evaluate(() => globalThis.keel.placeBoat(235, 300, -Math.PI / 2));
  await landed(page);
  l = await page.evaluate(() => globalThis.keel.land());
  expect(l?.stats.meshes).toBeGreaterThan(built);
  expect(l?.drawn).toContain(port);
});

test('a stack’s top first shows over the sea where the dome says @long', async ({ page }) => {
  test.slow(softwareGPU);
  // Seed 1's tallest stack, off Port Royal's northern shore, with open water
  // east of it for a kilometre: nothing stands between it and the eye.
  await openWorld(page, 300, 468, -Math.PI / 2);
  const top = await page.evaluate(() =>
    globalThis.keel.landSummit({ east: -41.6, north: 468, reach: 20 }),
  );
  if (top === null) {
    throw new Error('no stack');
  }
  expect(top.height).toBeGreaterThan(15);
  // The eye 2 m above the sea, 10 m behind the boat: the stack's top shows
  // from √(2R·2) + √(2R·H) away.
  const expected = Math.sqrt(2 * R * 2) + Math.sqrt(2 * R * top.height);
  // The stack alone is marked, all of it: its top shows first.
  await page.evaluate((t) => {
    globalThis.keel.landFlat(-10, { ...t, reach: 15 });
    // The boat's mast would stand in front of it.
    globalThis.keel.showOwnBoat(false);
  }, top);
  let eye = { east: 0, north: 0, height: 0 };
  const shows = async (d: number): Promise<boolean> => {
    // The boat d − 10 m from the stack, heading toward it, on the line from
    // it to the east.
    await page.evaluate(
      ([e, n, dist]) => {
        const k = globalThis.keel;
        k.placeBoat((e ?? 0) + (dist ?? 0) - 10, n ?? 0, -Math.PI / 2);
        // The camera is placed about the boat as drawn: drawn first.
        k.render();
        k.camera({ azimuth: 0, elevation: Math.asin(0.2 / 10), distance: 10 });
        k.render();
      },
      [top.east, top.north, d],
    );
    await page.waitForTimeout(700);
    await landed(page);
    const png = await picture(page);
    eye = await page.evaluate(() => globalThis.keel.eye());
    let magenta = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if ((png.data[i] ?? 0) > 200 && (png.data[i + 1] ?? 0) < 60 && (png.data[i + 2] ?? 0) > 200) {
        magenta++;
      }
    }
    return magenta > 0;
  };
  // Bisect between a distance it shows from and one it does not.
  let near = expected * 0.7;
  let far = expected * 1.3;
  expect(await shows(near)).toBe(true);
  expect(await shows(far)).toBe(false);
  for (let i = 0; i < 6; i++) {
    const mid = (near + far) / 2;
    if (await shows(mid)) {
      near = mid;
    } else {
      far = mid;
    }
  }
  const first = (near + far) / 2;
  // The eye where the test put it: 2 m up, 10 m behind the boat.
  expect(eye.height).toBeCloseTo(2, 2);
  test.info().annotations.push({
    type: 'horizon',
    description: `the ${top.height.toFixed(1)} m stack first shows at ${first.toFixed(0)} m; the dome says ${expected.toFixed(0)} m`,
  });
  expect(Math.abs(first - expected) / expected).toBeLessThan(0.05);
});

test('a boat sailed onto the beach is aground, pushed off, and told so @long', async ({ page }) => {
  // 25 m off Port Royal's eastern beach in a metre of water, running onto
  // it before a fresh easterly with the sheet eased.
  test.setTimeout(180_000);
  await openWorld(page, 180, 300, -Math.PI / 2);
  // A minute of sailing with time held, five frames to each second of it,
  // however slowly the machine draws; the screen's words written each frame.
  const a = await page.evaluate(async () => {
    const k = globalThis.keel;
    k.setWind(16, 90);
    k.setControls(0, 0.9);
    let aground = -1;
    let pushed = -1;
    for (let f = 0; f < 300 && pushed < 0; f++) {
      k.game.hud.flush();
      k.sailFrames(1, 6);
      const g = k.aground();
      if (aground < 0 && g.sailor === 'Aground') {
        aground = f;
      }
      if (aground >= 0 && g.line === 'Pushed off') {
        pushed = f;
      }
      // The land's handout and the mesh worker's answers.
      await new Promise((r) => setTimeout(r, 0));
    }
    const b = k.boat().state;
    return { ...k.aground(), aground, pushed, at: [b.x, b.y] };
  });
  expect(a.aground, `aground: ${JSON.stringify(a)}`).toBeGreaterThanOrEqual(0);
  expect(a.pushed, `pushed off: ${JSON.stringify(a)}`).toBeGreaterThan(a.aground);
  expect(a.groundings).toBeGreaterThan(0);
  expect(a.sound).not.toBeNull();
  expect(a.pushes).toBeGreaterThan(0);
});

test.describe('pictures', () => {
  // Seed 1's coasts at noon, each from the sea view and from above:
  // Port Royal's eastern beach in a breeze, Lime Cay's reef, 80 m off its
  // eastern shore with a lagoon behind, in a fresh wind, Port Royal's eastern cliffs in a gale, and the lee west of
  // Port Royal in a trade wind from the east.
  const places: {
    name: string;
    east: number;
    north: number;
    heading: number;
    sea: string;
    wind?: [number, number];
  }[] = [
    { name: 'beach-breeze', east: 230, north: 300, heading: -Math.PI / 2, sea: 'breeze' },
    { name: 'reef-fresh', east: 1830, north: -1191, heading: -Math.PI / 2, sea: 'fresh' },
    { name: 'cliff-gale', east: 260, north: 71, heading: -Math.PI / 2, sea: 'gale' },
    {
      name: 'lee-trade',
      east: -520,
      north: 71,
      heading: Math.PI / 2,
      sea: 'fresh',
      wind: [18, 90],
    },
  ];
  for (const p of places) {
    test(`${p.name} @long`, async ({ page }) => {
      await openWorld(page, p.east, p.north, p.heading);
      await page.evaluate((p) => {
        const k = globalThis.keel;
        k.setSea(p.sea);
        if (p.wind !== undefined) {
          k.setWind(p.wind[0], p.wind[1]);
        }
        k.setSky(12);
        k.render();
      }, p);
      await landed(page);
      for (const view of ['sea', 'high']) {
        await page.evaluate(async (v) => {
          globalThis.keel.camera(v);
          await globalThis.keel.show();
        }, view);
        await expect
          .soft(page.locator('canvas.scene'))
          .toHaveScreenshot(`land-${p.name}-${view}.png`);
      }
    });
  }
});
