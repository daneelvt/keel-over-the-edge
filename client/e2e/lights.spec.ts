// SPDX-License-Identifier: AGPL-3.0-only

// The lighthouses and wrecks in a real browser, in the sandbox on seed 1's
// world (the file go run ./tools/dev -world 1 writes), which hands them as
// a server would: the places with their chunks, the lights by range. By
// night a port's light flashes its character by world time, the same
// schedule the server keeps; beyond its tower's horizon it is a loom at its
// true bearing; by day its tower stands on its point, unlit; and a wreck
// near the boat is drawn.

import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { lightOn } from '../src/lights/character';
import { openScene, type Picture, picture } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

interface Records {
  places: { number: number; kind: string; x: number; y: number }[];
  lights: {
    number: number;
    place: number;
    role: string;
    x: number;
    y: number;
    focal: number;
    phase: number;
    notation: string;
  }[];
}

/** The world file's records, read as the page reads them. */
function records(): Records {
  const b = readFileSync(world);
  const n = b.readUInt32LE(8);
  return JSON.parse(b.subarray(12, 12 + n).toString('utf8')) as Records;
}

/** The catalog's steps of a character, by notation, from the catalog the page is built with. */
function steps(notation: string): number[] {
  const cat = JSON.parse(
    readFileSync(new URL('../src/catalog/catalog.gen.json', import.meta.url), 'utf8'),
  ) as {
    world: { lights: { characters: { notation: string; steps: number[] }[] } };
  };
  const ch = cat.world.lights.characters.find((c) => c.notation === notation);
  if (ch === undefined) {
    throw new Error(`no character ${notation}`);
  }
  return ch.steps;
}

/** The brightest of a picture's pixels within 6 pixels of a point, the sum of its channels. */
function brightness(a: Picture, at: { x: number; y: number }): number {
  let best = 0;
  const scale = a.width / 960;
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const x = Math.round(at.x * scale) + dx;
      const y = Math.round(at.y * scale) + dy;
      if (x < 0 || y < 0 || x >= a.width || y >= a.height) {
        continue;
      }
      const i = (y * a.width + x) * 4;
      best = Math.max(best, (a.data[i] ?? 0) + (a.data[i + 1] ?? 0) + (a.data[i + 2] ?? 0));
    }
  }
  return best;
}

/** Puts the boat d metres from (east, north), facing it, at the hour given, and waits for the sandbox to hand what is near. */
async function facing(
  page: Page,
  east: number,
  north: number,
  d: number,
  hour: number,
): Promise<void> {
  const [x, y] = [east + d * 0.6, north + d * 0.8];
  await page.evaluate(
    ([px, py, h, hr]) => {
      globalThis.keel.placeBoat(px ?? 0, py ?? 0, h);
      globalThis.keel.setSky(hr ?? 12);
      globalThis.keel.render();
    },
    [x, y, Math.atan2(east - x, north - y), hour],
  );
  // The sandbox looks again every half second.
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    for (let i = 0; i < 4; i++) {
      globalThis.keel.sailFrames(1, 2);
    }
  });
}

/** The first port light, or the first whose character is the class given. */
const port = (prefix = ''): Records['lights'][number] => {
  const l = records().lights.find((x) => x.role === 'port' && x.notation.startsWith(prefix));
  if (l === undefined) {
    throw new Error('no port light');
  }
  return l;
};

test('Port Royal’s light comes with the Welcome, and lighthouses with their chunks', async ({
  page,
}) => {
  await openScene(page, 'world=1&wind=0,0');
  await page.waitForTimeout(1200);
  const r = records();
  const l = await page.evaluate(() => globalThis.keel.lights());
  const main = r.lights.find((x) => x.role === 'main');
  expect(l.lights.map((x) => x.number)).toContain(main?.number);
  // Port Royal's lighthouse stands in a chunk the boat at the start has.
  expect(l.sites.map((s) => s.number)).toContain(main?.place);
  // Not every light: the edge's are out of range of the start.
  expect(l.lights.length).toBeGreaterThan(0);
  expect(l.lights.length).toBeLessThan(r.lights.length);
});

test('by night a port’s light flashes its character by world time', async ({ page }) => {
  await openScene(page, 'world=1&wind=0,0');
  const p = port();
  const s = steps(p.notation);
  await facing(page, p.x, p.y, 250, 22);
  let flashes = 0;
  let dark = 0;
  for (let k = 0; k < 24; k++) {
    const l = await page.evaluate(() => {
      globalThis.keel.sailFrames(1, 8);
      return globalThis.keel.lights();
    });
    const glow = l.glows.some((g) => g.mode === 'glow' && Math.abs(g.y - p.focal) < 0.5);
    const on = lightOn(s, p.phase, l.worldUs);
    if (glow) {
      flashes++;
      expect(on, `a glow at ${l.worldUs} µs`).toBe(true);
    } else {
      dark++;
    }
  }
  expect(flashes).toBeGreaterThan(0);
  expect(dark).toBeGreaterThan(0);
});

test('beyond its tower’s horizon, a light is its loom at its true bearing @long', async ({ page }) => {
  await openScene(page, 'world=1&wind=0,0');
  const p = port();
  const s = steps(p.notation);
  await facing(page, p.x, p.y, 1500, 22);
  let looms = 0;
  for (let k = 0; k < 40 && looms === 0; k++) {
    const l = await page.evaluate(() => {
      globalThis.keel.sailFrames(1, 5);
      return globalThis.keel.lights();
    });
    if (!lightOn(s, p.phase, l.worldUs)) {
      continue;
    }
    // From the boat, the light is to the south-south-west: x < 0, z > 0.
    const loom = l.glows.find(
      (g) => g.mode === 'loom' && Math.abs(Math.atan2(g.x, -g.z) - Math.atan2(-0.6, -0.8)) < 0.05,
    );
    if (loom !== undefined) {
      looms++;
    }
  }
  expect(looms).toBe(1);
});

test('a light’s flash shows in the picture by night, at its lantern @long', async ({ page }) => {
  await openScene(page, 'world=1&wind=0,0');
  // An occulting light: no beams turn from its lantern.
  const p = port('Oc');
  const s = steps(p.notation);
  await facing(page, p.x, p.y, 450, 22);
  // A frame mid-flash and one mid-eclipse: they differ where the light is.
  const shot = async (want: boolean): Promise<Awaited<ReturnType<typeof picture>>> => {
    for (let k = 0; k < 80; k++) {
      const us = await page.evaluate(() => {
        globalThis.keel.sailFrames(1, 3);
        return globalThis.keel.lights().worldUs;
      });
      if (lightOn(s, p.phase, us) === want && lightOn(s, p.phase, us + 150_000) === want) {
        return picture(page);
      }
    }
    throw new Error(`the light never ${want ? 'flashed' : 'went dark'}`);
  };
  const off = await shot(false);
  const on = await shot(true);
  const offAgain = await shot(false);
  // The flash brightens the picture where the light is; between two dark
  // frames it is as it was.
  const at = await page.evaluate(
    ([e, n, h]) => globalThis.keel.worldOnScreen(e ?? 0, n ?? 0, h ?? 0),
    [p.x, p.y, p.focal],
  );
  if (at === null) {
    throw new Error('no canvas');
  }
  const flash = brightness(on, at) - brightness(off, at);
  expect(flash).toBeGreaterThan(60);
  expect(flash).toBeGreaterThan(4 * Math.abs(brightness(offAgain, at) - brightness(off, at)));
  const l = await page.evaluate(() => globalThis.keel.lights());
  expect(l.towers).toBeGreaterThan(0);
});

test('a wreck near the boat is drawn @long', async ({ page }) => {
  await openScene(page, 'world=1&wind=0,0');
  const w = records().places.find((x) => x.kind === 'wreck');
  if (w === undefined) {
    throw new Error('no wreck');
  }
  await facing(page, w.x, w.y, 80, 12);
  await page.waitForFunction(
    (n) => {
      globalThis.keel.render();
      const l = globalThis.keel.lights();
      return l.wrecks.some((x) => x.number === n && !Number.isNaN(x.depth)) && l.wreckVertices > 0;
    },
    w.number,
    { timeout: 30_000 },
  );
});
