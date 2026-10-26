// SPDX-License-Identifier: AGPL-3.0-only

// The gust ring is the server's: on every field of
// internal/lookout/testdata/gustring.json the same patches found and the
// same rings chosen, with the catalog's ring.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { chooseRings, findPatches, gridSize, ringGrid } from './gustring';

interface Patch {
  east: number;
  north: number;
  radius: number;
  peak: number;
}

interface GustFile {
  ring: typeof catalog.weather.ring;
  cases: {
    name: string;
    east: number;
    north: number;
    from: number;
    boatEast: number;
    boatNorth: number;
    driftEast: number;
    driftNorth: number;
    excess: number;
    blocks: { from: [number, number]; to: [number, number]; factor: number; slope: number }[];
    patches: Patch[] | null;
    rings: (Patch & { arrives: number; miss: number })[] | null;
    gusts: (Patch & { bearing: number })[] | null;
  }[];
}

const file = JSON.parse(
  readFileSync(
    new URL('../../../internal/lookout/testdata/gustring.json', import.meta.url),
    'utf8',
  ),
) as GustFile;

const ring = catalog.weather.ring;

/** Whether two numbers agree to within the last bits of the sines either side takes. */
const near = (a: number, b: number | undefined): boolean => Math.abs(a - (b ?? Number.NaN)) < 1e-9;

describe('the gust ring', () => {
  test('is the catalog’s', () => {
    expect(file.ring).toEqual(ring);
  });

  test('finds the server’s patches and rings the same ones', () => {
    expect(file.cases.length).toBeGreaterThan(5);
    const { rows, cols } = gridSize(ring);
    for (const c of file.cases) {
      const points = new Float64Array(rows * cols * 2);
      ringGrid(c.east, c.north, c.from, ring, points);
      const factor = new Float64Array(rows * cols);
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          let f = 1;
          for (const b of c.blocks) {
            if (i >= b.from[0] && i < b.to[0] && j >= b.from[1] && j < b.to[1]) {
              f = Math.max(f, b.factor + b.slope * (i - b.from[0]));
            }
          }
          factor[i * cols + j] = f;
        }
      }
      const patches = findPatches(factor, points, c.excess, ring);
      const want = c.patches ?? [];
      expect(patches.length, c.name).toBe(want.length);
      patches.forEach((p, k) => {
        const w = want[k];
        expect(near(p.east, w?.east) && near(p.north, w?.north), c.name).toBe(true);
        expect(near(p.radius, w?.radius), c.name).toBe(true);
        expect(p.peak, c.name).toBe(w?.peak);
      });
      const rings = chooseRings(
        patches,
        c.east,
        c.north,
        c.boatEast,
        c.boatNorth,
        c.driftEast,
        c.driftNorth,
        ring,
      );
      const wantRings = c.rings ?? [];
      expect(rings.length, c.name).toBe(wantRings.length);
      rings.forEach((r, k) => {
        const w = wantRings[k];
        expect(near(r.east, w?.east) && near(r.north, w?.north), c.name).toBe(true);
        expect(near(r.arrives, w?.arrives) && near(r.miss, w?.miss), c.name).toBe(true);
        // The ring's bearing from the boat, as the server tells it.
        const b = (Math.atan2(r.east - c.east, r.north - c.north) * 180) / Math.PI;
        const off = (((b - (c.gusts?.[k]?.bearing ?? Number.NaN)) % 360) + 540) % 360;
        expect(Math.abs(off - 180), c.name).toBeLessThan(1e-6);
      });
    }
  });
});
