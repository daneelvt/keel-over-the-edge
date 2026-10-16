// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's copy of the server's handout hands, at each of 300 points,
// exactly the chunks Go's hands on the same world
// (internal/edge/testdata/handout.json).

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { FAR_MIN, farRadius } from '../ocean/far';
import { GROUND } from '../predict/layout.gen';
import { DOME_RADIUS, horizonDistance } from '../render/materials';
import { cellHex, chunkCorner, hexCentre } from '../workers/mesh/build';
import { Handout } from './handout';

const file = JSON.parse(
  readFileSync(new URL('../../../internal/edge/testdata/handout.json', import.meta.url), 'utf8'),
) as {
  islands: [number, number, number, number][];
  points: [number, number][];
  handed: number[][];
};

/** The file's islands as elevations, chunk by chunk, as Go makes them. */
function islands(): Map<number, Int16Array | null> {
  const out = new Map<number, Int16Array | null>();
  for (let n = 0; n < GROUND.chunkSide * GROUND.chunkSide; n++) {
    const [c0, j0] = chunkCorner(n);
    // A chunk no island or its shallows reaches is all deep water.
    const [x0, y0] = hexCentre(...cellHex(c0, j0));
    const reaches = file.islands.some(
      ([ix, iy, radius]) =>
        ix + radius + 160 > x0 &&
        ix - radius - 160 < x0 + GROUND.chunkColumns * 3.47 &&
        iy + radius + 160 > y0 - 4 &&
        iy - radius - 160 < y0 + GROUND.chunkRows * 4 + 4,
    );
    if (!reaches) {
      out.set(n, null);
      continue;
    }
    const e = new Int16Array(GROUND.chunkHexes);
    let any = false;
    for (let i = 0; i < GROUND.chunkHexes; i++) {
      const [q, r] = cellHex(c0 + Math.floor(i / GROUND.chunkRows), j0 + (i % GROUND.chunkRows));
      const [x, y] = hexCentre(q, r);
      let m = -40;
      for (const [ix, iy, radius, height] of file.islands) {
        const dx = x - ix;
        const dy = y - iy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius) {
          m = height;
          break;
        }
        if (d < radius + 150) {
          m = -3;
        }
      }
      e[i] = Math.max(Math.min(Math.round(m * 10), 800), -400);
      any = any || e[i] !== -400;
    }
    out.set(n, any ? e : null);
  }
  return out;
}

describe('the sandbox’s handout', () => {
  test('hands what the server’s hands', () => {
    const h = new Handout(catalog.world.handout, islands());
    expect(file.points.length).toBe(300);
    file.points.forEach(([x, y], i) => {
      expect(h.seen(x, y), `at (${x}, ${y})`).toEqual(file.handed[i]);
    });
    expect(file.handed.some((c) => c.length > 4)).toBe(true);
  });
});

describe('the handout’s numbers', () => {
  test('are the page’s: the dome, and how far the far sea reaches', () => {
    const h = catalog.world.handout;
    expect(h.dome).toBe(DOME_RADIUS);
    expect(h.farSeaLeast).toBe(FAR_MIN);
    for (const camera of [2, 6.5, 80, 300]) {
      expect(Math.max(h.farSeaLeast, h.farSeaHorizon * horizonDistance(camera))).toBeCloseTo(
        farRadius(camera),
        9,
      );
    }
  });
});
