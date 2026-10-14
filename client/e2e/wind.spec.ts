// SPDX-License-Identifier: AGPL-3.0-only

// The wind in a real browser, on each back end: the gust field the GPU
// draws on the tiles is the one Go computes for the boats, at the world's
// centre and at its rim, now and after 2³¹ ticks, in a spell and through a
// change of spell; a tile under a gust is rougher and darker than one in a
// lull, by day and by night; and the instruments read the wind at the boat.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { fromHex, type RecordValues } from '../src/predict/golden';
import { openScene } from './helpers';

/** The wind as Go computed it: internal/physics/testdata/wind.json. */
interface WindCase {
  name: string;
  spells: RecordValues[];
  tick: number;
  origin: number[];
  points: number[][];
  /** Speed, direction, mean speed, mean direction, gust field, gust factor, as bits. */
  values: string[][];
}
const windFile = JSON.parse(
  readFileSync(new URL('../../internal/physics/testdata/wind.json', import.meta.url), 'utf8'),
) as { cases: WindCase[] };

/** How far the GPU's field may be from Go's: its 32-bit floats carry a tile's metres, not the world's. */
const TOLERANCE = 1e-4;

test.describe('the GPU’s gust field', () => {
  // Go wrote each case's wind at points about a place; the same spells,
  // tick and place are given to the page, whose GPU must find the same
  // gusts. A frame is of one tick, so the cases between ticks are the
  // module's alone (wind.test.ts).
  for (const c of windFile.cases.filter((c) => Number.isInteger(c.tick))) {
    test(`is the server’s: ${c.name}`, async ({ page }) => {
      await openScene(page);
      const got = await page.evaluate(async (c) => {
        const k = globalThis.keel;
        k.placeBoat(c.origin[0] ?? 0, c.origin[1] ?? 0);
        k.freezeTick(c.tick);
        k.setSpells(c.spells);
        k.render();
        const o = k.info().origin;
        const scene = c.points.flatMap((p) => [
          (c.origin[0] ?? 0) + (p[0] ?? 0) - o.east,
          -((c.origin[1] ?? 0) + (p[1] ?? 0) - o.north),
        ]);
        return { ...(await k.gusts(scene)), tiles: await k.tileGusts() };
      }, c);
      let gpu = 0;
      let module = 0;
      let strongest = 0;
      for (const [i, v] of c.values.entries()) {
        const want = fromHex(v[4] ?? '');
        strongest = Math.max(strongest, Math.abs(want));
        gpu = Math.max(gpu, Math.abs((got.gpu[i] ?? Number.NaN) - want));
        // The module in the page, at the points as float32 holds them.
        module = Math.max(module, Math.abs((got.module[i] ?? Number.NaN) - want));
      }
      expect(module).toBeLessThan(TOLERANCE);
      expect(gpu).toBeLessThan(TOLERANCE);
      // And on the tiles: what the pass wrote for each is the module's field
      // at its centre.
      let tiles = 0;
      for (const [i, g] of got.tiles.gpu.entries()) {
        tiles = Math.max(tiles, Math.abs(g - (got.tiles.module[i] ?? Number.NaN)));
      }
      expect(got.tiles.count).toBe(5101);
      expect(tiles).toBeLessThan(TOLERANCE);
      // A steady wind has no gusts; the others have strong ones among the points.
      if (c.name.startsWith('steady')) {
        expect(strongest).toBe(0);
        expect(Math.max(...got.tiles.gpu.map(Math.abs))).toBe(0);
      } else {
        expect(strongest).toBeGreaterThan(0.5);
      }
    });
  }

  // The gusts' rows are drawn only while there is a field, so a steady
  // wind's page never builds their shader; when the field goes, they are
  // drawn once more, to nothing.
  test('leaves nothing on the tiles once the wind is steady again', async ({ page }) => {
    const c = windFile.cases.find((k) => k.name === 'trade');
    if (c === undefined) {
      throw new Error('wind.json has no trade case');
    }
    await openScene(page);
    const got = await page.evaluate(async (c) => {
      const k = globalThis.keel;
      const most = (v: number[]) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      k.placeBoat(c.origin[0] ?? 0, c.origin[1] ?? 0);
      k.freezeTick(c.tick);
      k.render();
      const before = most((await k.tileGusts()).gpu);
      k.setSpells(c.spells);
      k.render();
      const gusty = most((await k.tileGusts()).gpu);
      k.setWind(12, 0);
      k.render();
      const after = most((await k.tileGusts()).gpu);
      k.render();
      return { before, gusty, after, later: most((await k.tileGusts()).gpu) };
    }, c);
    expect(got.before).toBe(0);
    expect(got.gusty).toBeGreaterThan(0.5);
    expect(got.after).toBe(0);
    expect(got.later).toBe(0);
  });
});

test.describe('a gust on the water', () => {
  for (const [name, hour, moon] of [
    ['at noon', 12, 0.5],
    ['under a full moon', 0, 0.5],
  ] as const) {
    test(`darkens and roughens its tiles ${name}`, async ({ page }) => {
      await openScene(page, 'sea=breeze');
      const trade = windFile.cases.find((c) => c.name === 'trade');
      if (trade === undefined) {
        throw new Error('wind.json has no trade case');
      }
      const got = await page.evaluate(
        async ({ c, hour, moon }) => {
          const k = globalThis.keel;
          k.setSky(hour, moon);
          k.placeBoat(c.origin[0] ?? 0, c.origin[1] ?? 0);
          k.freezeTick(c.tick);
          k.setSpells(c.spells);
          k.render();
          return k.gustSurface();
        },
        { c: trade, hour, moon },
      );
      // How much darker the gusts make the water, pixel by pixel: its
      // brightness with them drawn over its brightness without, on the
      // tiles under a gust and on those in a lull.
      const ratio = (pick: (g: number) => boolean): number => {
        let sum = 0;
        let n = 0;
        for (const [i, g] of got.gust.entries()) {
          const plain = got.hidden[i] ?? 0;
          if (plain > 0 && pick(g)) {
            sum += (got.shown[i] ?? 0) / plain;
            n++;
          }
        }
        expect(n).toBeGreaterThan(200);
        return sum / n;
      };
      const gusty = ratio((g) => g > 0.4);
      const lull = ratio((g) => g < -0.2);
      const between = ratio((g) => Math.abs(g) < 0.02);
      test.info().annotations.push({
        type: 'gusts',
        description: `under a gust the water is ${gusty.toFixed(3)} as bright, in a lull ${lull.toFixed(3)}, between them ${between.toFixed(3)}`,
      });
      // A tile under a gust is darker by a tenth and more than the same
      // tile without it; one in a lull is not darker; one between is as it was.
      expect(gusty).toBeLessThan(0.9);
      expect(lull).toBeGreaterThan(0.97);
      expect(gusty).toBeLessThan(0.9 * lull);
      expect(Math.abs(between - 1)).toBeLessThan(0.02);
      // The gusts fade out at the tile field's rim: none shows beyond it.
      expect(Math.max(...got.gust.map(Math.abs))).toBeLessThanOrEqual(1.5);
    });
  }

  test('is not drawn in a steady wind', async ({ page }) => {
    await openScene(page, 'sea=breeze');
    const got = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.render();
      return k.gustSurface(96, 120);
    });
    expect(Math.max(...got.gust.map(Math.abs))).toBe(0);
    for (const [i, v] of got.shown.entries()) {
      expect(Math.abs(v - (got.hidden[i] ?? 0))).toBeLessThan(1e-6);
    }
  });
});

test.describe('the wind overlay’s gust ring', () => {
  // The rings are found on the CPU and only read here, never looked at: a
  // small picture keeps the many frames these tests draw cheap on a
  // software GPU, which otherwise queues them faster than it draws them.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 240, height: 150 });
  });
  test.afterEach(async ({ page }) => {
    // What was drawn is finished before the page closes.
    await page.evaluate(() => globalThis.keel.show());
  });

  test('is drawn round a gust heading for the boat, and travels with it', async ({ page }) => {
    await openScene(page, 'weather=trade', true);
    const got = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.settings({ windOverlay: true });
      k.setControls(0, 0.6);
      // Sail until a ring shows in full: a strong gust comes within minutes.
      let first = null;
      for (let i = 0; i < 1200 && first === null; i++) {
        k.advance(15);
        k.render();
        first = k.gustRings().find((r) => r.shown === 1) ?? null;
      }
      if (first === null) {
        return null;
      }
      // Two seconds on, the same ring, nearest where it was.
      const wind = k.boat().wind;
      k.advance(60);
      k.render();
      const rings = k.gustRings();
      const near = (r: { east: number; north: number }): number =>
        Math.hypot(r.east - first.east, r.north - first.north);
      const later = rings.sort((a, b) => near(a) - near(b))[0] ?? null;
      const off = await k.settings({ windOverlay: false });
      k.advance(30);
      k.render();
      return { first, later, wind, count: rings.length, after: k.gustRings().length, off };
    });
    expect(got, 'no gust headed for the boat in ten minutes').not.toBeNull();
    if (got === null || got.later === null) {
      return;
    }
    // A ring is round a gust: the gust factor at its middle is well over 1.
    expect(got.first.factor).toBeGreaterThan(1.1);
    expect(got.later.factor).toBeGreaterThan(1.05);
    expect(got.count).toBeLessThanOrEqual(3);
    // In two seconds it has travelled downwind, at about nine tenths of the
    // spell's wind: 4 to 16 m in a trade spell.
    const east = got.later.east - got.first.east;
    const north = got.later.north - got.first.north;
    const moved = Math.hypot(east, north);
    expect(moved).toBeGreaterThan(4);
    expect(moved).toBeLessThan(30);
    // Downwind: away from where the mean wind at the boat comes from.
    const downwind = -(east * Math.sin(got.wind.meanFrom) + north * Math.cos(got.wind.meanFrom));
    expect(downwind).toBeGreaterThan(0.7 * moved);
    // With the overlay off the rings fade out.
    expect(got.after).toBe(0);
  });

  test('is not drawn in a steady wind, nor without the overlay', async ({ page }) => {
    await openScene(page, 'weather=trade', true);
    const got = await page.evaluate(async () => {
      const k = globalThis.keel;
      k.setControls(0, 0.6);
      let most = 0;
      for (let i = 0; i < 40; i++) {
        k.advance(30);
        k.render();
        most = Math.max(most, k.gustRings().length);
      }
      k.settings({ windOverlay: true });
      k.setWind(12, 0);
      for (let i = 0; i < 20; i++) {
        k.advance(30);
        k.render();
        most = Math.max(most, k.gustRings().length);
      }
      return most;
    });
    expect(got).toBe(0);
  });
});

test.describe('the wind readout', () => {
  test('gives the wind at the boat and its Beaufort force', async ({ page }) => {
    await openScene(page, '', true);
    await page.evaluate(() => {
      const k = globalThis.keel;
      k.setWind(14, 247.5);
      k.advance(120);
      k.render();
    });
    await expect(page.locator('[data-readout=wind]')).toHaveText('WSW 14 kn · F4');
    // In a trade spell the knots move with the gusts; the force is the mean wind's.
    const mean = await page.evaluate(() => {
      const k = globalThis.keel;
      k.setWeather('trade');
      k.advance(300);
      k.render();
      return k.boat().wind.meanSpeed;
    });
    const knots = Math.round(mean / (1852 / 3600));
    const force = [0, 1, 4, 7, 11, 17, 22, 28].filter((from) => knots >= from).length - 1;
    await expect(page.locator('[data-readout=wind]')).toHaveText(
      new RegExp(`^[NESW]{1,3} \\d+ kn · F${force}$`),
    );
  });
});
