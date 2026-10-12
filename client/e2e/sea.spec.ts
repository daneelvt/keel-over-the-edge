// SPDX-License-Identifier: AGPL-3.0-only

// The sea in a real browser, on each back end: the tiles are rigid and the
// lattice fixed, the GPU's waves are the server's, every material bends,
// a lost device comes back, and the pictures match their references.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { fromHex } from '../src/predict/golden';
import { openScene, picture, pictureDifference } from './helpers';

/** The sea as Go computed it: internal/physics/testdata/sea.json. */
interface SeaCase {
  name: string;
  sea: { tick: number; col: number; row: number; size: number; areas: number[][] };
  origin: number[];
  points: number[][];
  values: string[][];
}
const seaFile = JSON.parse(
  readFileSync(new URL('../../internal/physics/testdata/sea.json', import.meta.url), 'utf8'),
) as { cases: SeaCase[] };

test.describe('the GPU’s boat band', () => {
  // Go wrote each case's surface at points about a place; the same sea,
  // tick and place are given to the page, whose GPU must sum the same waves
  // to within what its sine is good for, at the world's centre and at its
  // rim, now and after 2³¹ ticks, in one sea and where two are blended.
  for (const c of seaFile.cases) {
    test(`is the server’s: ${c.name}`, async ({ page }) => {
      await openScene(page);
      const got = await page.evaluate(async (c) => {
        const k = globalThis.keel;
        k.placeBoat(c.origin[0] ?? 0, c.origin[1] ?? 0);
        k.freezeTick(c.sea.tick);
        k.setSeaWindow(c.sea.col, c.sea.row, c.sea.size, c.sea.areas);
        k.render();
        const o = k.info().origin;
        const scene = c.points.flatMap((p) => [
          (c.origin[0] ?? 0) + (p[0] ?? 0) - o.east,
          -((c.origin[1] ?? 0) + (p[1] ?? 0) - o.north),
        ]);
        return { ...(await k.band(scene)), tol: k.tolerance(), sea: k.sea() };
      }, c);
      expect(got.sea.waves).toBeGreaterThan(30);
      expect(got.sea.blended).toBe(c.name.startsWith('border'));
      let height = 0;
      let slope = 0;
      let hs = 0;
      let module = 0;
      for (const [i, v] of c.values.entries()) {
        // Height, slope eastward and northward, significant height; the
        // scene's z runs south.
        const want = [
          fromHex(v[0] ?? ''),
          fromHex(v[1] ?? ''),
          -fromHex(v[2] ?? ''),
          fromHex(v[3] ?? ''),
        ];
        const at = (from: number[], k: number): number =>
          Math.abs((from[i * 4 + k] ?? Number.NaN) - (want[k] ?? 0));
        height = Math.max(height, at(got.gpu, 0));
        slope = Math.max(slope, at(got.gpu, 1), at(got.gpu, 2));
        hs = Math.max(hs, at(got.gpu, 3));
        // The module in the page, at the points as float32 holds them.
        module = Math.max(module, at(got.module, 0), at(got.module, 1), at(got.module, 2));
      }
      expect(module).toBeLessThan(1e-4);
      expect(height).toBeLessThan(got.tol.height);
      expect(slope).toBeLessThan(got.tol.slope);
      expect(hs).toBeLessThan(1e-4);
      // The tolerance is a millimetre or two, not a wave.
      expect(got.tol.height).toBeLessThan(0.004);
    });
  }
});

test.describe('the tiles', () => {
  for (const pass of [true, false]) {
    test(`are rigid flat slabs under the gale, ${pass ? 'with the tile pass' : 'planes per vertex'}`, async ({
      page,
    }) => {
      await openScene(page, 'sea=gale');
      const [r, tol] = await page.evaluate(async (on) => {
        globalThis.keel.setPass(on);
        globalThis.keel.render();
        return [await globalThis.keel.rigidity(), globalThis.keel.tolerance()] as const;
      }, pass);
      expect(r.tiles).toBeGreaterThan(100);
      // From straight above every pixel is a tile's top: no gap, no skirt.
      expect(r.empty).toBe(0);
      expect(r.skirts).toBe(0);
      // Every fragment lies in its own tile's hexagon: the outline is exact.
      expect(r.outside).toBe(0);
      // Every tile's top lies on one plane, and it is the reference's.
      expect(r.worstResidual).toBeLessThan(1e-4);
      expect(r.worstHeight).toBeLessThan(tol.height);
      expect(r.worstSlope).toBeLessThan(tol.slope);
    });
  }

  test('the tile pass computes the reference planes', async ({ page }) => {
    await openScene(page, 'sea=gale');
    const [p, tol] = await page.evaluate(
      async () => [await globalThis.keel.planes(), globalThis.keel.tolerance()] as const,
    );
    let height = 0;
    let slope = 0;
    for (let i = 0; i < p.count; i++) {
      height = Math.max(height, Math.abs((p.gpu[i * 4] ?? 0) - (p.cpu[i * 4] ?? 0)));
      height = Math.max(height, Math.abs((p.gpu[i * 4 + 3] ?? 0) - (p.cpu[i * 4 + 3] ?? 0)));
      for (const k of [1, 2]) {
        slope = Math.max(slope, Math.abs((p.gpu[i * 4 + k] ?? 0) - (p.cpu[i * 4 + k] ?? 0)));
      }
    }
    expect(p.count).toBe(5101);
    expect(height).toBeLessThan(tol.height);
    expect(slope).toBeLessThan(tol.slope);
  });

  test('step at their edges with the sea, inside their skirts', async ({ page }) => {
    await openScene(page, 'sea=gale');
    const steps = await page.evaluate(async () => {
      const k = globalThis.keel;
      const out: Record<string, number> = {};
      for (const sea of ['gale', 'fresh', 'calm', 'flat']) {
        k.setSea(sea);
        k.render();
        out[sea] = (await k.steps()).largest;
      }
      return out;
    });
    expect(steps.gale).toBeLessThan(1.1);
    expect(steps.gale).toBeGreaterThan(steps.fresh ?? 0);
    expect(steps.fresh).toBeGreaterThan(0.05);
    // In calm water the tiles lie almost flat, and in flat water the steps vanish.
    expect(steps.calm).toBeLessThan(0.15);
    expect(steps.calm).toBeLessThan(steps.fresh ?? 0);
    expect(steps.flat).toBeLessThan(1e-3);
  });

  test('stay fixed in the world as the boat moves and the field re-centres', async ({ page }) => {
    await openScene(page);
    const maps = await page.evaluate(async () => {
      const k = globalThis.keel;
      const take = async (east: number) => {
        k.placeBoat(east, 0);
        k.render();
        return { map: await k.tileMap(0, 0), centre: k.info().centre };
      };
      // Where it starts; half a tile on, in the same tile; into the next tile.
      return [await take(0), await take(1), await take(3.5)];
    });
    const [a, b, c] = maps as [(typeof maps)[0], (typeof maps)[0], (typeof maps)[0]];
    expect(b.centre).toEqual(a.centre);
    expect(c.centre).not.toEqual(a.centre);
    for (const other of [b, c]) {
      expect(other.map.q).toEqual(a.map.q);
      expect(other.map.r).toEqual(a.map.r);
      let moved = 0;
      for (let i = 0; i < a.map.east.length; i++) {
        moved = Math.max(
          moved,
          Math.abs((other.map.east[i] ?? 0) - (a.map.east[i] ?? 0)),
          Math.abs((other.map.north[i] ?? 0) - (a.map.north[i] ?? 0)),
        );
      }
      expect(moved).toBeLessThan(1e-4);
    }
    expect(a.map.q.some(Number.isNaN)).toBe(false);
  });
});

test.describe('no water shows in a hull', () => {
  // Looking straight down on the hull at the sea as drawn about it: no sea
  // inside the hull's volume, no hole in the sea outside it, and the sea
  // drawn right up to the planking. From above every fragment of the sea is
  // seen, so what holds from there holds from astern and from the cockpit.
  const STEPS = 300;

  // Tagged @long: each look is a frame drawn and a target read back, which
  // takes most of a second on CI's SwiftShader. The boat is sailed for ten
  // seconds and looked at after every third step.
  test(`sailing in the gale, over ${STEPS} steps`, { tag: '@long' }, async ({ page }) => {
    test.setTimeout(300_000);
    await openScene(page, 'sea=gale');
    const r = await page.evaluate(async (steps) => {
      const k = globalThis.keel;
      k.setControls(0, 0.9);
      const sum = { inside: 0, holes: 0, beside: Infinity, left: Infinity, looks: 0 };
      let heave = 0;
      let pitch = 0;
      for (let i = 0; i < steps; i += 3) {
        k.advance(3);
        k.render();
        const c = await k.hull();
        sum.inside += c.inside;
        sum.holes += c.holes;
        sum.beside = Math.min(sum.beside, c.beside);
        sum.left = Math.min(sum.left, c.left);
        sum.looks++;
        const s = k.boat().state;
        heave = Math.max(heave, Math.abs(s.heave));
        pitch = Math.max(pitch, Math.abs(s.pitch));
      }
      return { ...sum, heave, pitch };
    }, STEPS);
    expect(r.looks).toBe(STEPS / 3);
    // The boat rode the gale's waves while it was watched.
    expect(r.heave).toBeGreaterThan(0.2);
    expect(r.pitch).toBeGreaterThan(0.03);
    expect(r.inside).toBe(0);
    expect(r.holes).toBe(0);
    // In every look the hull kept some sea out, and the sea was drawn beside it.
    expect(r.left).toBeGreaterThan(500);
    expect(r.beside).toBeGreaterThan(50);
  });

  for (const heel of [0, 30]) {
    test(`lying in the gale, heeled ${heel}°`, async ({ page }) => {
      await openScene(page, 'sea=gale');
      const r = await page.evaluate(async (heel) => {
        const k = globalThis.keel;
        const sum = { inside: 0, holes: 0, beside: Infinity, left: Infinity };
        for (let i = 0; i < 60; i++) {
          // A third of a second on each time, and the boat laid on the sea of that time.
          k.freeze(100 + i / 3);
          k.setState({ heel: (heel * Math.PI) / 180, heading: 0.7 + i / 10 });
          k.render();
          const c = await k.hull();
          sum.inside += c.inside;
          sum.holes += c.holes;
          sum.beside = Math.min(sum.beside, c.beside);
          sum.left = Math.min(sum.left, c.left);
        }
        return sum;
      }, heel);
      expect(r.inside).toBe(0);
      expect(r.holes).toBe(0);
      expect(r.left).toBeGreaterThan(300);
      expect(r.beside).toBeGreaterThan(30);
    });
  }

  test('nor in a boat 100 m away, nor in eight at once', async ({ page }) => {
    await openScene(page, 'sea=gale');
    const r = await page.evaluate(async () => {
      const k = globalThis.keel;
      // Seven other boats about the player's, the furthest 100 m off, and
      // an eighth, which is left to the sea: only the nearest seven are kept dry.
      const others = Array.from({ length: 8 }, (_, i) => ({
        east: (20 + 12 * i) * Math.cos(i * 0.9),
        north: (20 + 12 * i) * Math.sin(i * 0.9),
        heading: i * 0.9,
        heel: i % 2 === 0 ? 0.3 : -0.1,
      }));
      others[6] = { east: 80, north: 60, heading: 2, heel: 0.25 };
      others[7] = { east: -70, north: -110, heading: 1, heel: 0 };
      k.setFleet(others);
      k.render();
      const out = [];
      for (let i = 0; i < others.length; i++) {
        out.push(await k.hull(i));
      }
      return out;
    });
    for (const c of r.slice(0, 7)) {
      expect(c.inside).toBe(0);
      expect(c.holes).toBe(0);
      expect(c.left).toBeGreaterThan(300);
    }
    // The eighth, 130 m off, is the furthest: the sea runs through it.
    expect(r[7]?.left).toBe(0);
    expect(r[7]?.inside).toBeGreaterThan(300);
  });
});

test.describe('the floating origin', () => {
  test('moving it changes nothing on screen', async ({ page }) => {
    await openScene(page, 'sea=fresh');
    await page.evaluate(() => {
      globalThis.keel.placeBoat(480, 0);
      globalThis.keel.render();
      globalThis.keel.camera('sea');
    });
    const before = await picture(page);
    const moved = await page.evaluate(() => {
      const k = globalThis.keel;
      const o = k.info().origin;
      const c = k.info().centre;
      k.setOrigin(c.q, c.r);
      return k.info().origin.east !== o.east;
    });
    const after = await picture(page);
    expect(moved).toBe(true);
    expect(pictureDifference(before, after)).toBeLessThan(0.5);
  });

  test('the scene at the rim looks as it does at the centre', async ({ page }) => {
    await openScene(page);
    // Flat water and every tile alike, so only the place differs; the boat
    // heading 330°, as the views were chosen.
    await page.evaluate(() => {
      globalThis.keel.setSea('flat');
      globalThis.keel.setIdentity(false);
      globalThis.keel.setState({ heading: (330 * Math.PI) / 180 - 2 * Math.PI });
      globalThis.keel.render();
      globalThis.keel.camera('bands');
    });
    const centre = await picture(page);
    await page.evaluate(() => {
      globalThis.keel.placeBoat(8300, 0);
      globalThis.keel.render();
      globalThis.keel.camera('bands');
    });
    const rim = await picture(page);
    expect(pictureDifference(centre, rim)).toBeLessThan(0.5);
  });

  test('a different time gives a different picture (the comparisons can fail)', async ({
    page,
  }) => {
    await openScene(page, 'sea=fresh');
    const a = await picture(page);
    await page.evaluate(() => {
      globalThis.keel.freeze(101.5);
    });
    const b = await picture(page);
    expect(pictureDifference(a, b)).toBeGreaterThan(2);
  });
});

test.describe('every material', () => {
  test('is the factory’s and carries the bend, but the sky', async ({ page }) => {
    await openScene(page);
    const [clean, planted] = await page.evaluate(() => [
      globalThis.keel.checkScene(),
      globalThis.keel.checkScene(true),
    ]);
    expect(clean).toEqual([]);
    expect(planted).toEqual(['planted (MeshBasicMaterial): not made by the material factory']);
  });

  test('the GPU’s tile hash is the CPU’s', async ({ page }) => {
    await openScene(page);
    const h = await page.evaluate(() => globalThis.keel.hashes());
    expect(h.checked).toBe(4096);
    expect(h.differ).toEqual([]);
  });
});

test('a lost device comes back within 2 s with the same picture', async ({ page }) => {
  await openScene(page, 'sea=fresh');
  const before = await picture(page);
  const started = Date.now();
  await page.evaluate(() => globalThis.keel.loseDevice());
  await page.waitForFunction(() => globalThis.keel.info().recoveries === 1, null, {
    timeout: 2000,
  });
  const took = Date.now() - started;
  await page.evaluate(() => globalThis.keel.render());
  const after = await picture(page);
  expect(took).toBeLessThan(2000);
  expect(pictureDifference(before, after)).toBeLessThan(0.5);
});

test.describe('pictures', () => {
  for (const sea of ['calm', 'fresh', 'gale']) {
    test(sea, async ({ page }) => {
      await openScene(page, `sea=${sea}`);
      // The boat heading 330°, as the views were chosen to match the renderings.
      await page.evaluate(() => {
        globalThis.keel.setState({ heading: (330 * Math.PI) / 180 - 2 * Math.PI });
        globalThis.keel.render();
      });
      for (const view of ['sea', 'bands']) {
        await page.evaluate(async (v) => {
          globalThis.keel.camera(v);
          await globalThis.keel.show();
        }, view);
        await expect(page.locator('canvas.scene')).toHaveScreenshot(`${sea}-${view}.png`);
      }
    });
  }
});
