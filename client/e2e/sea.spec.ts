// SPDX-License-Identifier: AGPL-3.0-only

// The sea in a real browser, on each back end: the tiles are rigid and the
// lattice fixed, the GPU's planes match the CPU's, every material bends,
// a lost device comes back, and the pictures match their references.

import { expect, test } from '@playwright/test';
import { openScene, picture, pictureDifference } from './helpers';

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
    // In calm water the steps vanish.
    expect(steps.calm).toBeLessThan(1e-3);
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
    // Every tile alike, so only the place differs.
    await page.evaluate(() => {
      globalThis.keel.setIdentity(false);
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

test('the frame allocates nothing that stays', async ({ page }) => {
  // What the heap keeps does not depend on the picture's size, and a small
  // one keeps SwiftShader's CPU rendering inside the time.
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 320, height: 200 });
  await openScene(page, 'sea=gale');
  const cdp = await page.context().newCDPSession(page);
  const used = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize;
  };
  await page.evaluate(async () => {
    const k = globalThis.keel;
    k.world.boatState.speed = 6;
    k.thaw();
    await k.frames(300);
  });
  const before = await used();
  await page.evaluate(() => globalThis.keel.frames(1000));
  const after = await used();
  // The boat sailed 100 m and more, through new tiles; the heap stayed put.
  expect(after - before).toBeLessThan(256 * 1024);
});
