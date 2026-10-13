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
