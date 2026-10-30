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
import { openScene, type Picture, picture, softwareGPU } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

interface Records {
  places: { number: number; kind: string; x: number; y: number }[];
  towns: { kind: string; x: number; y: number; heading: number }[];
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

/**
 * Puts the boat d metres from (east, north), the way from says (north-north-east),
 * facing it but off radians, at the hour given, and waits for the sandbox to
 * hand what is near.
 */
async function facing(
  page: Page,
  east: number,
  north: number,
  d: number,
  hour: number,
  from: [number, number] = [0.6, 0.8],
  off = 0,
): Promise<void> {
  const [x, y] = [east + d * from[0], north + d * from[1]];
  await page.evaluate(
    ([px, py, h, hr]) => {
      globalThis.keel.placeBoat(px ?? 0, py ?? 0, h);
      globalThis.keel.setSky(hr ?? 12);
      globalThis.keel.render();
    },
    [x, y, Math.atan2(east - x, north - y) + off, hour],
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

test('beyond its tower’s horizon, a light is its loom at its true bearing @long', async ({
  page,
}) => {
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

test('a loom fades to nothing at its sides: no box on the horizon @long', async ({ page }) => {
  test.slow(softwareGPU);
  await openScene(page, 'world=1&wind=0,0');
  const p = port();
  // The boat 1500 m from it, facing it, with the lights handed.
  await facing(page, p.x, p.y, 1500, 22);
  const [x, y] = [p.x + 1500 * 0.6, p.y + 1500 * 0.8];
  // Time held where the light is lit, the chase camera behind the boat, and
  // where its loom is on the screen.
  let at: { x: number; y: number } | null = null;
  for (let k = 0; k < 60 && at === null; k++) {
    at = await page.evaluate(
      ({ t, east, north, heading }) => {
        const k = globalThis.keel;
        k.freeze(t);
        k.placeBoat(east, north, heading);
        k.render();
        k.camera('chase');
        k.setSky(22);
        const loom = k.lights().glows.find((g) => g.mode === 'loom' && g.strength > 0.2);
        if (loom === undefined) {
          return null;
        }
        // Its scene place, dropped by the dome as its vertices are, on the screen.
        const camera = k.world.stage.camera;
        const f = k.world.focusScene;
        const d2 = (loom.x - f.x) ** 2 + (loom.z - f.z) ** 2;
        const v = camera.position
          .clone()
          .set(loom.x, loom.y - d2 / 5000, loom.z)
          .project(camera);
        return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
      },
      { t: k * 0.25, east: x, north: y, heading: Math.atan2(p.x - x, p.y - y) + 0.4 },
    );
  }
  if (at === null) {
    throw new Error('no loom drawn');
  }
  // The same frame with its glows and without: the difference is the loom.
  const shown = await picture(page);
  await page.evaluate(() => {
    (globalThis.keel.world.lighthouses.glows.material as { visible: boolean }).visible = false;
  });
  const hidden = await picture(page);
  await page.evaluate(() => {
    (globalThis.keel.world.lighthouses.glows.material as { visible: boolean }).visible = true;
  });
  const scale = shown.width / 960;
  const cx = Math.round(at.x * scale);
  const cy = Math.round(at.y * scale);
  const added = (x: number, y: number): number => {
    const i = (y * shown.width + x) * 4;
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      sum += (shown.data[i + c] ?? 0) - (hidden.data[i + c] ?? 0);
    }
    return Math.max(sum, 0);
  };
  // In each row through the loom, the run of pixels it lights about its
  // middle has faded to nothing at both ends: a glow cut off at its
  // square's sides, or the fog's colour added over the square, ends in a
  // step, a straight side. Nothing is two levels a channel: WebGL 2 holds
  // the picture in 8 bits of linear light, whose least step in the dark is
  // that.
  let rows = 0;
  const ends: string[] = [];
  for (let y = Math.max(cy - 40, 0); y < Math.min(cy + 40, shown.height); y++) {
    if (added(cx, y) < 12) {
      continue;
    }
    rows++;
    let first = cx;
    while (first > 0 && added(first - 1, y) > 0) {
      first--;
    }
    let last = cx;
    while (last < shown.width - 1 && added(last + 1, y) > 0) {
      last++;
    }
    const peak = Math.max(
      ...Array.from({ length: last - first + 1 }, (_, i) => added(first + i, y)),
    );
    for (const x of [first, last]) {
      if (added(x, y) > Math.max(6, 0.15 * peak)) {
        ends.push(`row ${y}, column ${x}: ${added(x, y)} of ${peak}`);
      }
    }
  }
  expect(rows).toBeGreaterThan(0);
  expect(ends).toEqual([]);
});

test('a light’s flash shows in the picture by night, at its lantern @long', async ({ page }) => {
  // Three pictures, each waiting for the frames sailed before it to be drawn.
  test.slow(softwareGPU);
  await openScene(page, 'world=1&wind=0,0');
  // An occulting light: no beams turn from its lantern.
  const p = port('Oc');
  const s = steps(p.notation);
  // From the port's own water, where its town looks out: no land between.
  const town = records()
    .towns.filter((t) => t.kind === 'port')
    .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
  const h = town?.heading ?? 0;
  // Its bow a little off the light, so that the sail does not hide it.
  await facing(page, p.x, p.y, 450, 22, [Math.sin(h), Math.cos(h)], 0.45);
  // A frame mid-flash and one mid-eclipse: they differ where the light is.
  // Each picture with where the light is in it: the chase camera turns
  // with the boat as it lies to the swell.
  const shot = async (want: boolean): Promise<{ pic: Picture; at: { x: number; y: number } }> => {
    for (let k = 0; k < 80; k++) {
      const us = await page.evaluate(() => {
        globalThis.keel.sailFrames(1, 3);
        return globalThis.keel.lights().worldUs;
      });
      if (lightOn(s, p.phase, us) === want && lightOn(s, p.phase, us + 150_000) === want) {
        const pic = await picture(page);
        const at = await page.evaluate(
          ([e, n, h]) => globalThis.keel.worldOnScreen(e ?? 0, n ?? 0, h ?? 0),
          [p.x, p.y, p.focal],
        );
        if (at === null) {
          throw new Error('no canvas');
        }
        return { pic, at };
      }
    }
    throw new Error(`the light never ${want ? 'flashed' : 'went dark'}`);
  };
  const off = await shot(false);
  const on = await shot(true);
  const offAgain = await shot(false);
  // The flash brightens the picture where the light is; between two dark
  // frames it is as it was.
  const flash = brightness(on.pic, on.at) - brightness(off.pic, off.at);
  expect(flash).toBeGreaterThan(60);
  expect(flash).toBeGreaterThan(
    4 * Math.abs(brightness(offAgain.pic, offAgain.at) - brightness(off.pic, off.at)),
  );
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
