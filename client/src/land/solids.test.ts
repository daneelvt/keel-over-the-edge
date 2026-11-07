// SPDX-License-Identifier: AGPL-3.0-only

// The solids the cameras keep out of, over grids made here: a column, and
// beside it within the radius and beyond; a roof's band and under it; a
// building's turned box and just outside it; a tower; the open sea; no
// grids at all; and, over an island of random columns, never a point said
// clear that a hexagon comes within the radius of.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { GROUND } from '../predict/layout.gen';
import { cellHex, cellOf, chunkCorner, drawnHeight, hexCentre } from '../workers/mesh/build';
import type { ChunkBuilding, ChunkGrids, ChunkRoof } from '../workers/mesh/chunk';
import { Solids, type TowerSite } from './solids';

/** The chunk that holds the world's centre. */
const N = 136;
const TERRACE = catalog.world.look.terrace;
const SEA = -40;

/** Chunk N, each hexagon's elevation, decimetres, from its centre; with buildings and roofs. */
function chunk(
  f: (east: number, north: number) => number,
  buildings: Partial<ChunkBuilding>[] = [],
  roofs: ChunkRoof[] = [],
): ChunkGrids {
  const [c0, j0] = chunkCorner(N);
  const e = new Int16Array(GROUND.chunkHexes);
  for (let i = 0; i < e.length; i++) {
    const [q, r] = cellHex(c0 + Math.floor(i / GROUND.chunkRows), j0 + (i % GROUND.chunkRows));
    const [x, y] = hexCentre(q, r);
    e[i] = f(x, y);
  }
  return {
    number: N,
    elevation: e,
    surface: new Uint8Array(GROUND.chunkHexes),
    shelter: null,
    town: {
      buildings: buildings.map((b) => ({
        kind: 0,
        kit: 0,
        east: 0,
        north: 0,
        heading: 0,
        level: 0,
        top: 0,
        storeys: 1,
        seed: 0,
        wall: 0,
        roof: 0,
        shutter: 0,
        flag: 0,
        frontage: 6,
        depth: 6,
        town: 0,
        ...b,
      })),
      harbour: [],
    },
    features: { roofs, parts: [] },
  };
}

/** Whether (east, north) is in the hexagon centred at (ce, cn). */
function inHex(east: number, north: number, ce: number, cn: number): boolean {
  const [c, j] = cellOf(east, north);
  const [d, k] = cellOf(ce, cn);
  return c === d && j === k;
}

/** The hexagon of (q, r)'s corners, m east and north. */
function corners(q: number, r: number): [number, number][] {
  const [ce, cn] = hexCentre(q, r);
  const R = 4 / Math.sqrt(3);
  return [0, 1, 2, 3, 4, 5].map((k) => [
    ce + R * Math.cos((k * Math.PI) / 3),
    cn + R * Math.sin((k * Math.PI) / 3),
  ]);
}

/** How far (east, north) is from a polygon, m: 0 inside. */
function polygonDistance(east: number, north: number, poly: [number, number][]): number {
  let inside = true;
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k] as [number, number];
    const [bx, by] = poly[(k + 1) % poly.length] as [number, number];
    const ex = bx - ax;
    const ey = by - ay;
    const t = Math.max(
      0,
      Math.min(1, ((east - ax) * ex + (north - ay) * ey) / (ex * ex + ey * ey)),
    );
    best = Math.min(best, Math.hypot(east - ax - t * ex, north - ay - t * ey));
    // Counter-clockwise: inside is on every edge's left.
    if (ex * (north - ay) - ey * (east - ax) < 0) {
      inside = false;
    }
  }
  return inside ? 0 : best;
}

describe('the solids', () => {
  test('a column: over it and in it, beside it within the radius and beyond', () => {
    const s = new Solids(TERRACE);
    // A 9.6 m column, twelve terraces, on the hexagon at the centre, the
    // sea about it.
    s.add(
      N,
      chunk((e, n) => (inHex(e, n, 0, 0) ? 96 : SEA)),
    );
    expect(s.ceiling).toBeCloseTo(9.6, 9);
    expect(s.clear(0, 0, 10, 0.5)).toBe(false);
    expect(s.clear(0, 0, 10.2, 0.5)).toBe(true);
    expect(s.clear(0.5, 0.5, 3, 0.5)).toBe(false);
    // North of it, across its northern edge at 2 m: 0.3 m off it, and 0.7 m.
    expect(s.clear(0, 2.3, 5, 0.5)).toBe(false);
    expect(s.clear(0, 2.7, 5, 0.5)).toBe(true);
    // Off a corner, 2.31 m east: 0.4 m beyond it, and 0.6 m.
    const R = 4 / Math.sqrt(3);
    expect(s.clear(R + 0.4, 0, 5, 0.5)).toBe(false);
    expect(s.clear(R + 0.6, 0, 5, 0.5)).toBe(true);
    // The open sea about it.
    expect(s.clear(30, 30, 0.5, 0.5)).toBe(true);
    expect(s.highest(0, 2.3, 0.5)).toBeCloseTo(9.6, 9);
    expect(s.highest(0, 2.7, 0.5)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('a column stands to its elevation or its drawn terrace, whichever is higher', () => {
    const s = new Solids(TERRACE);
    s.add(
      N,
      chunk((e, n) => (inHex(e, n, 0, 0) ? 13 : inHex(e, n, 0, 8) ? 9 : SEA)),
    );
    expect(s.highest(0, 0, 0.1)).toBeCloseTo(Math.max(1.3, drawnHeight(13, TERRACE)), 9);
    expect(s.highest(0, 8, 0.1)).toBeCloseTo(Math.max(0.9, drawnHeight(9, TERRACE)), 9);
    expect(drawnHeight(13, TERRACE)).toBeGreaterThan(1.3);
  });

  test('a roof: in its band, under it, over it', () => {
    const s = new Solids(TERRACE);
    const [c, j] = cellOf(0, 20);
    s.add(
      N,
      chunk(() => SEA, [], [{ column: c, row: j, under: 6, top: 9 }]),
    );
    expect(s.clear(0, 20, 7.5, 0.5)).toBe(false);
    expect(s.clear(0, 20, 5.6, 0.5)).toBe(false);
    expect(s.clear(0, 20, 5.4, 0.5)).toBe(true);
    expect(s.clear(0, 20, 9.6, 0.5)).toBe(true);
    // Beside it, across its southern edge, in its band.
    expect(s.clear(0, 17.7, 7.5, 0.5)).toBe(false);
    expect(s.clear(0, 17.3, 7.5, 0.5)).toBe(true);
    expect(s.roofAt(0, 20, 7, 0.5, 2)).toBe(true);
    expect(s.band).toEqual({ under: 6, top: 9 });
    expect(s.roofAt(0, 20, 5, 0.5, 2)).toBe(false);
    expect(s.roofAt(0, 20, 11.5, 0.5, 2)).toBe(false);
    // Not counted in the highest.
    expect(s.highest(0, 20, 0.5)).toBe(Number.NEGATIVE_INFINITY);
  });

  test('a building: inside its turned box, and just outside it', () => {
    const s = new Solids(TERRACE);
    const heading = Math.PI / 6;
    s.add(
      N,
      chunk(() => SEA, [{ east: 40, north: 40, heading, level: 2, top: 8, frontage: 8, depth: 6 }]),
    );
    // Its front faces (sin h, cos h); its frontage runs (cos h, −sin h).
    const fe = Math.sin(heading);
    const fn = Math.cos(heading);
    const re = Math.cos(heading);
    const rn = -Math.sin(heading);
    expect(s.clear(40, 40, 5, 0.5)).toBe(false);
    // Its eaves reach a tenth beyond its walls: 3.3 m in front, 4.4 m to the side.
    expect(s.clear(40 + fe * 3.7, 40 + fn * 3.7, 5, 0.5)).toBe(false);
    expect(s.clear(40 + fe * 3.9, 40 + fn * 3.9, 5, 0.5)).toBe(true);
    expect(s.clear(40 + re * 4.8, 40 + rn * 4.8, 5, 0.5)).toBe(false);
    expect(s.clear(40 + re * 5.0, 40 + rn * 5.0, 5, 0.5)).toBe(true);
    // Its box unturned would hold this point: turned, it does not.
    expect(s.clear(40 + 4.3, 40 + 3.2, 5, 0.5)).toBe(true);
    // Over its chimney.
    expect(s.clear(40, 40, 8.6 + 0.4, 0.5)).toBe(false);
    expect(s.clear(40, 40, 8.6 + 0.6, 0.5)).toBe(true);
    expect(s.highest(40, 40, 0.5)).toBeCloseTo(8.6, 9);
  });

  test('a lighthouse tower, read again when the lighthouses change', () => {
    const s = new Solids(TERRACE);
    const sites = new Map<number, TowerSite>();
    const source = { sites, sitesVersion: 0 };
    s.towers = source;
    expect(s.clear(-50, -50, 10, 0.5)).toBe(true);
    sites.set(1, { east: -50, north: -50, ground: 3, tower: 20 });
    source.sitesVersion++;
    // 2.4 m across at its widest, 2.7 + 22 m to its cupola's top.
    expect(s.clear(-50, -50, 10, 0.5)).toBe(false);
    expect(s.clear(-50 + 2.8, -50, 10, 0.5)).toBe(false);
    expect(s.clear(-50 + 3, -50, 10, 0.5)).toBe(true);
    expect(s.clear(-50, -50, 3 - 0.3 + 22 + 0.6, 0.5)).toBe(true);
    expect(s.ceiling).toBeCloseTo(24.7, 9);
    expect(s.highest(-50, -50, 0.5)).toBeCloseTo(24.7, 9);
    sites.clear();
    source.sitesVersion++;
    expect(s.clear(-50, -50, 10, 0.5)).toBe(true);
  });

  test('where no grids are held, and when they are let go, it is the open sea', () => {
    const s = new Solids(TERRACE);
    expect(s.ceiling).toBe(Number.NEGATIVE_INFINITY);
    expect(s.clear(0, 0, 0, 0.5)).toBe(true);
    expect(s.highest(0, 0, 0.5)).toBe(Number.NEGATIVE_INFINITY);
    s.add(
      N,
      chunk((e, n) => (inHex(e, n, 0, 0) ? 100 : SEA)),
    );
    expect(s.clear(0, 0, 5, 0.5)).toBe(false);
    s.drop(N);
    expect(s.clear(0, 0, 5, 0.5)).toBe(true);
    s.add(
      N,
      chunk((e, n) => (inHex(e, n, 0, 0) ? 100 : SEA)),
    );
    s.dropAll();
    expect(s.clear(0, 0, 5, 0.5)).toBe(true);
    expect(s.held).toBe(0);
  });

  test('over an island of random columns, no point said clear has a column within the radius', () => {
    // An island 60 m across of columns 1 to 30 m high, at random.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const tops = new Map<string, number>();
    const s = new Solids(TERRACE);
    s.add(
      N,
      chunk((e, n) => {
        if (Math.hypot(e, n) > 30) {
          return SEA;
        }
        const h = 10 + Math.floor(random() * 290);
        const [c, j] = cellOf(e, n);
        tops.set(`${c},${j}`, Math.max(h / 10, drawnHeight(h, TERRACE)));
        return h;
      }),
    );
    let blocked = 0;
    let checked = 0;
    for (let k = 0; k < 20000; k++) {
      const e = (random() - 0.5) * 80;
      const n = (random() - 0.5) * 80;
      const u = random() * 35;
      const clear = s.clear(e, n, u, 0.5);
      // The truth: every column within 0.5 m of the point, by its outline.
      let truth = true;
      const [c0, j0] = cellOf(e, n);
      for (let dc = -2; dc <= 2; dc++) {
        for (let dj = -2; dj <= 2; dj++) {
          const [q, r] = cellHex(c0 + dc, j0 + dj);
          const top = tops.get(`${c0 + dc},${j0 + dj}`);
          if (top === undefined) {
            continue;
          }
          const across = polygonDistance(e, n, corners(q, r));
          const above = Math.max(u - top, 0);
          if (Math.hypot(across, above) < 0.5) {
            truth = false;
          }
        }
      }
      if (!truth) {
        expect(clear).toBe(false);
      }
      blocked += clear ? 0 : 1;
      checked++;
    }
    expect(checked).toBe(20000);
    expect(blocked).toBeGreaterThan(1000);
  });
});
