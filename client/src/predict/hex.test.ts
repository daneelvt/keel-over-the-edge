// SPDX-License-Identifier: AGPL-3.0-only

// The lattice in the module, which grounding reads, against the drawing's
// own hexAt and against the server's: the same hexagon for every point off
// an edge, and on the edges and corners the server's own choice.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { hexAt, hexCentre } from '../ocean/hex';
import { fromHex } from './golden';
import { loadPhysics, type Physics } from './physics';

const wasm = new URL('./physics.wasm', import.meta.url);
const testdata = new URL('../../../internal/physics/testdata/', import.meta.url);

let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
});

describe('the lattice', () => {
  test("the drawing's hexAt and the module's agree off the edges", () => {
    // A fixed linear congruential sequence, so the points are the same
    // every run.
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const drawn = { q: 0, r: 0 };
    const centre = { x: 0, y: 0 };
    const other = { x: 0, y: 0 };
    const got = [0, 0];
    let differ = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const x = (next() - 0.5) * 17000;
      const y = (next() - 0.5) * 17000;
      hexAt(x, y, drawn);
      physics.hexAt(x, y, got);
      if (got[0] === drawn.q && got[1] === drawn.r) {
        continue;
      }
      // Differing, the point must lie on the edge between the two.
      hexCentre(drawn.q, drawn.r, centre);
      hexCentre(got[0] ?? 0, got[1] ?? 0, other);
      const a = Math.hypot(x - centre.x, y - centre.y);
      const b = Math.hypot(x - other.x, y - other.y);
      if (Math.abs(a - b) > 1e-9) {
        differ++;
      }
    }
    expect(differ).toBe(0);
  });

  test("on edges and corners the module chooses the server's hexagon", () => {
    const points = JSON.parse(readFileSync(new URL('hex.json', testdata), 'utf8')) as {
      X: string;
      Y: string;
      Q: number;
      R: number;
    }[];
    expect(points.length).toBeGreaterThan(50);
    const got = [0, 0];
    for (const p of points) {
      physics.hexAt(fromHex(p.X), fromHex(p.Y), got);
      expect(got).toEqual([p.Q, p.R]);
    }
  });
});
