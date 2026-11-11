// SPDX-License-Identifier: AGPL-3.0-only

// The chase camera keeps out of the land, in the sandbox on seed 1's world
// (the file go run ./tools/dev -world 1 writes), at the camera scenes
// (?camera=…): swung round the boat in 10° steps at its lowest, resting
// and highest elevations and at 5, 16 and 80 m, its eye is clear of every
// solid by the clearance and its line to the boat clear, by a lookup of the
// test's own over the grids read back (each column by its hexagon's
// outline); sailing past the stack, it comes back out to its view
// steadily, within a second; on the open sea it stands where it stands
// without the land, to the millimetre; and the free camera, flown at the
// stack's side and into a house, stops clear.

import { existsSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { CAMERA_SCENE, CAMERA_SCENES, type CameraScene } from '../src/sandbox/camerascenes';
import { openScene } from './helpers';

const world = new URL('../../.dev/worlds/1.world', import.meta.url);

test.skip(!existsSync(world), 'no world file for seed 1: run go run ./tools/dev -world 1');

// The camera is placed on the CPU, whichever back end draws: one project is enough.
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the camera is placed alike on every back end');
});

// Small pages: what is measured is the camera, not the picture.
test.use({ viewport: { width: 320, height: 200 } });

/** The camera's clearance, m, as the game keeps it. */
const CLEARANCE = 0.5;
const HEX_RADIUS = 4 / Math.sqrt(3);

/** Renders until the land about the boat is had, and some of it drawn. */
async function landed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const k = globalThis.keel;
      k.render();
      const l = k.land();
      return l !== null && l.stats.inFlight === 0 && l.ready && l.drawn.length > 0;
    },
    null,
    { timeout: 60_000, polling: 250 },
  );
}

/** Puts the boat at a place, in the calm, and waits for the land about it. */
async function moveTo(page: Page, east: number, north: number, heading: number): Promise<void> {
  await page.evaluate(
    ([e, n, h]) => {
      globalThis.keel.placeBoat(e ?? 0, n ?? 0, h);
    },
    [east, north, heading],
  );
  // The sandbox hands the land again every half second.
  await page.waitForTimeout(800);
  await landed(page);
}

type Solids = Awaited<ReturnType<typeof readSolids>>;

/** The solids within reach of a place as the page's grids hold them. */
async function readSolids(page: Page, east: number, north: number, reach: number) {
  return page.evaluate(
    ([e, n, r]) => globalThis.keel.solidsNear(e ?? 0, n ?? 0, r ?? 0),
    [east, north, reach],
  );
}

/** A height drawn in terraces, m, from decimetres: land lower than one terrace at its own height. */
function drawn(e: number, terrace: number): number {
  const m = e / 10;
  return m < terrace ? m : Math.round(m / terrace) * terrace;
}

/** How far (de, dn) from a hexagon's centre is from its outline, m: 0 inside; its corners point east and west. */
function hexAcross(de: number, dn: number): number {
  const corners: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    corners.push([
      HEX_RADIUS * Math.cos((k * Math.PI) / 3),
      HEX_RADIUS * Math.sin((k * Math.PI) / 3),
    ]);
  }
  let inside = true;
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 6; k++) {
    const [ax, ay] = corners[k] as [number, number];
    const [bx, by] = corners[(k + 1) % 6] as [number, number];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(0, Math.min(1, ((de - ax) * ex + (dn - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(de - ax - t * ex, dn - ay - t * ey));
    if (ex * (dn - ay) - ey * (de - ax) < 0) {
      inside = false;
    }
  }
  return inside ? 0 : best;
}

/**
 * The test's own lookup: how far a point is from the nearest solid, m (0
 * inside one), up to `most`: the columns to their tops as drawn, the roofs
 * from their undersides to their tops, the buildings' boxes and eaves, and
 * the towers.
 */
function lookup(s: Solids, most = 4): (east: number, north: number, up: number) => number {
  const CELL = 8;
  const cells = new Map<string, number[]>();
  const put = (e: number, n: number, i: number) => {
    const key = `${Math.floor(e / CELL)},${Math.floor(n / CELL)}`;
    const at = cells.get(key);
    if (at === undefined) {
      cells.set(key, [i]);
    } else {
      at.push(i);
    }
  };
  for (let i = 0; i < s.hexes.length; i += 3) {
    put(s.hexes[i] ?? 0, s.hexes[i + 1] ?? 0, i);
  }
  return (east, north, up) => {
    let best = most;
    const cx = Math.floor(east / CELL);
    const cy = Math.floor(north / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const i of cells.get(`${x},${y}`) ?? []) {
          const top = Math.max((s.hexes[i + 2] ?? 0) / 10, drawn(s.hexes[i + 2] ?? 0, s.terrace));
          const across = hexAcross(east - (s.hexes[i] ?? 0), north - (s.hexes[i + 1] ?? 0));
          best = Math.min(best, Math.hypot(across, Math.max(up - top, 0)));
        }
      }
    }
    for (let i = 0; i < s.roofs.length; i += 4) {
      const across = hexAcross(east - (s.roofs[i] ?? 0), north - (s.roofs[i + 1] ?? 0));
      const v = Math.max((s.roofs[i + 2] ?? 0) - up, 0, up - (s.roofs[i + 3] ?? 0));
      best = Math.min(best, Math.hypot(across, v));
    }
    for (let i = 0; i < s.buildings.length; i += 7) {
      const [be, bn, h, frontage, depth, level, top] = s.buildings.slice(i, i + 7) as number[];
      const de = east - (be ?? 0);
      const dn = north - (bn ?? 0);
      const c = Math.cos(h ?? 0);
      const sn = Math.sin(h ?? 0);
      // Its walls and eaves, a tenth beyond them, to the ridge.
      const x = Math.max(Math.abs(de * c - dn * sn) - 0.55 * (frontage ?? 0), 0);
      const y = Math.max(Math.abs(de * sn + dn * c) - 0.55 * (depth ?? 0), 0);
      const v = Math.max((level ?? 0) - up, 0, up - Math.max(top ?? 0, (level ?? 0) + 2));
      best = Math.min(best, Math.hypot(x, y, v));
    }
    for (let i = 0; i < s.towers.length; i += 4) {
      const [te, tn, ground, height] = s.towers.slice(i, i + 4) as number[];
      const across = Math.max(
        Math.hypot(east - (te ?? 0), north - (tn ?? 0)) - 0.115 * (height ?? 0),
        0,
      );
      const foot = (ground ?? 0) - 0.3;
      const v = Math.max(foot - up, 0, up - (foot + 1.094 * (height ?? 0)));
      best = Math.min(best, Math.hypot(across, v));
    }
    return best;
  };
}

/** Every view of the sweep: 36 azimuths at the lowest, resting and highest elevations, at 5, 16 and 80 m. */
function sweep(): { azimuth: number; elevation: number; distance: number }[] {
  const views = [];
  for (const elevation of [0.03, 0.3, 1.45]) {
    for (const distance of [5, 16, 80]) {
      for (let k = 0; k < 36; k++) {
        views.push({ azimuth: (k * 10 * Math.PI) / 180 - Math.PI, elevation, distance });
      }
    }
  }
  return views;
}

/** Places the camera at each view and reads back its eye and the point it looks at, in the world. */
async function placeAll(
  page: Page,
  views: { azimuth: number; elevation: number; distance: number }[],
): Promise<number[][]> {
  return page.evaluate((vs) => {
    const k = globalThis.keel;
    return vs.map((v) => {
      k.camera(v);
      const a = k.arm();
      return [a.eye.east, a.eye.north, a.eye.up, a.look.east, a.look.north, a.look.up];
    });
  }, views);
}

/** The least clearance of the eyes, and of the lines to the look points, by the test's own lookup. */
function clearances(placed: number[][], distance: (e: number, n: number, u: number) => number) {
  let eye = Number.POSITIVE_INFINITY;
  let line = Number.POSITIVE_INFINITY;
  let worstView = -1;
  placed.forEach((p, i) => {
    const [ee, en, eu, le, ln, lu] = p as [number, number, number, number, number, number];
    const d = distance(ee, en, eu);
    if (d < eye) {
      eye = d;
      worstView = i;
    }
    const length = Math.hypot(ee - le, en - ln, eu - lu);
    const steps = Math.max(1, Math.ceil(length / 0.05));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      line = Math.min(line, distance(le + (ee - le) * u, ln + (en - ln) * u, lu + (eu - lu) * u));
    }
  });
  return { eye, line, worstView };
}

test('swung round at every scene, the camera is clear of the land and so is its line to the boat', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openScene(page, 'world=1&wind=0,0');
  const views = sweep();
  const lines: string[] = [];
  let frames = 0;
  for (const name of CAMERA_SCENES) {
    const s: CameraScene = CAMERA_SCENE[name];
    await moveTo(page, s.east, s.north, s.heading);
    const solids = await readSolids(page, s.east, s.north, 260);
    expect(solids.hexes.length + solids.roofs.length, name).toBeGreaterThan(0);
    const distance = lookup(solids);
    // Without the arm the views go into the land; with it, never.
    await page.evaluate(() => globalThis.keel.cameraSolids(false));
    const before = clearances(await placeAll(page, views), distance);
    expect(before.eye, `${name}: some view goes into the land without the arm`).toBe(0);
    await page.evaluate(() => globalThis.keel.cameraSolids(true));
    const placed = await placeAll(page, views);
    const after = clearances(placed, distance);
    lines.push(
      `${name}: ${placed.length} views, nearest eye ${after.eye.toFixed(3)} m, nearest line ${after.line.toFixed(3)} m`,
    );
    expect(
      after.eye,
      `${name}: view ${JSON.stringify(views[after.worstView])}`,
    ).toBeGreaterThanOrEqual(CLEARANCE - 1e-3);
    expect(after.line, name).toBeGreaterThan(0);
    frames += placed.length;
  }
  test.info().annotations.push({
    type: 'measured',
    description: `${frames} views checked; ${lines.join('; ')}`,
  });
});

test('sailing past the stack, the camera comes back out to its view steadily, within a second', async ({
  page,
}) => {
  await openScene(page, 'world=1&wind=0,0');
  const s = CAMERA_SCENE.stack;
  // South of the scene's place, heading north past the stack at 3 m/s, the
  // camera to the east through it.
  await moveTo(page, s.east, s.north - 10, 0);
  await page.evaluate(() => {
    const k = globalThis.keel;
    k.camera({ azimuth: -Math.PI / 2, elevation: 0.15, distance: 30 });
    k.setState({ surge: 3, sway: 0, yawRate: 0, heading: 0 });
  });
  // A frame is a sixtieth of a second to the camera, two steps (0.2 m) to the boat.
  const reaches = await page.evaluate(() => {
    const k = globalThis.keel;
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      // Kept at 3 m/s in the calm.
      k.setState({ surge: 3 });
      k.sailFrames(1, 2);
      const a = k.arm();
      out.push(
        Math.hypot(a.eye.east - a.look.east, a.eye.north - a.look.north, a.eye.up - a.look.up),
      );
    }
    return out;
  });
  const view = reaches[0] === undefined ? 0 : Math.max(...reaches);
  const pulled = reaches.map((r) => r < view - 0.5);
  const first = pulled.indexOf(true);
  const last = pulled.lastIndexOf(true);
  expect(first, 'the stack came into the line').toBeGreaterThan(-1);
  expect(last).toBeLessThan(reaches.length - 61);
  // From the last frame it was pulled in: never nearer, and back within a second.
  let back = -1;
  for (let i = last + 1; i < reaches.length; i++) {
    expect(reaches[i] ?? 0).toBeGreaterThanOrEqual((reaches[i - 1] ?? 0) - 1e-6);
    if (back < 0 && Math.abs((reaches[i] ?? 0) - view) < 0.01) {
      back = i;
    }
  }
  expect(back).toBeGreaterThan(last);
  expect((back - last) / 60).toBeLessThanOrEqual(1);
  test.info().annotations.push({
    type: 'measured',
    description: `pulled in for ${((last - first + 1) / 60).toFixed(2)} s of camera time, nearest ${Math.min(...reaches).toFixed(2)} m; back out in ${((back - last) / 60).toFixed(2)} s`,
  });
});

test('on the open sea the camera stands where it stands without the land, to the millimetre', async ({
  page,
}) => {
  await openScene(page, 'world=1&wind=0,0');
  // North of Port Royal's northern cliffs: its grids held, no land in reach.
  await moveTo(page, -60, 800, 0.3);
  const near = await readSolids(page, -60, 800, 250);
  expect(near.hexes.length + near.buildings.length + near.towers.length).toBe(0);
  expect((await readSolids(page, -60, 800, 1200)).hexes.length).toBeGreaterThan(0);
  const views = sweep();
  const withArm = await placeAll(page, views);
  await page.evaluate(() => globalThis.keel.cameraSolids(false));
  const without = await placeAll(page, views);
  await page.evaluate(() => globalThis.keel.cameraSolids(true));
  let worst = 0;
  withArm.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      worst = Math.max(worst, Math.abs((p[k] ?? 0) - (without[i]?.[k] ?? 0)));
    }
  });
  expect(worst).toBeLessThan(0.001);
});

test('the free camera, flown at the stack’s side and into a house, stops clear', async ({
  page,
}) => {
  await openScene(page, 'world=1&wind=0,0');
  const s = CAMERA_SCENE.stack;
  await moveTo(page, s.east, s.north, s.heading);
  const solids = await readSolids(page, s.east, s.north, 200);
  const distance = lookup(solids);
  // The stack's westernmost column, and a point just off its side, 8 m up.
  let west = { east: 0, north: 0 };
  for (let i = 0; i < solids.hexes.length; i += 3) {
    const e = solids.hexes[i] ?? 0;
    const n = solids.hexes[i + 1] ?? 0;
    if (Math.hypot(e - (s.east + 19), n - s.north) < 8 && (west.east === 0 || e < west.east)) {
      west = { east: e, north: n };
    }
  }
  expect(west.east).not.toBe(0);
  const at = [
    { east: west.east - HEX_RADIUS - 0.2, north: west.north, height: 8 },
    { east: west.east, north: west.north, height: 4 },
  ];
  // And the house nearest the harbour scene's place, at its middle, 1 m up.
  const h = CAMERA_SCENE.harbour;
  await moveTo(page, h.east, h.north, h.heading);
  const town = await readSolids(page, h.east, h.north, 60);
  expect(town.buildings.length).toBeGreaterThan(0);
  const house = { east: town.buildings[0] ?? 0, north: town.buildings[1] ?? 0, height: 1 };
  const houseDistance = lookup(town);
  for (const [i, p] of [...at, house].entries()) {
    const eye = await page.evaluate((p) => {
      const k = globalThis.keel;
      k.fly({ ...p, bearing: 90, pitch: -10 });
      const c = k.freeCam();
      k.landCamera();
      return { east: c.east, north: c.north, height: c.height };
    }, p);
    const d = (i < at.length ? distance : houseDistance)(eye.east, eye.north, eye.height);
    expect(d, JSON.stringify(p)).toBeGreaterThanOrEqual(CLEARANCE - 1e-3);
    expect(eye.height).toBeGreaterThan(p.height);
  }
});
