// SPDX-License-Identifier: AGPL-3.0-only

// The plants on a chunk's land, placed by rule from its surfaces and
// heights, as Horizon Zero Dawn places all its nature: a density for each
// kind of plant from the ground under it, discretised by a pattern scaled
// to the plant's footprint, deterministic and locally stable, nothing
// stored per plant (van Muijden, GPU-based procedural placement in Horizon
// Zero Dawn, GDC 2017). Here the pattern is a jittered grid in world
// metres, a cell as wide as the plant's crown: in each cell one candidate,
// at a place the cell's own numbers put it, kept with the chance that
// makes the plants' crowns cover the share of their ground the catalog
// gives (the FAO's canopy cover), and only where the ground suits it: its
// surface's cover lists it, at the height, distance from the shore and
// slope it takes, in a hollow if it wants one, on no building's plot. A
// shrub or a tuft is a clump: its cell is at least a few metres, its
// crowns' share kept as near as that allows. A kit with a garden plant
// sets one beside some of its houses. The numbers are hashes of the
// cell's and the plant's own, so every phone places the same plants, and
// a chunk built again places them again where they were.

import { GROUND } from '../../predict/layout.gen';
import { cellOf, chunkCorner, drawnHeight } from './build';
import type { ChunkTown } from './chunk';

/** A kind of plant as the worker places it. */
export interface PlantLook {
  /** Its height grown and its crown's width, m: the least and the most. */
  height: [number, number];
  crown: [number, number];
  /** The least a cell of its pattern is, m: its crown, or a clump's for a shrub or a tuft. */
  cell: number;
}

/** A plant that grows on a surface, and where on it. */
export interface CoverLook {
  plant: number;
  share: number;
  height: [number, number];
  shore: [number, number];
  /** Its steepest ground, degrees. */
  slope: number;
  hollow: boolean;
}

/** The flora as the worker places it: the plants, each surface's cover, each kit's garden plant (−1 for none). */
export interface FloraLook {
  plants: PlantLook[];
  cover: CoverLook[][];
  garden: number[];
}

/** A placed plant's floats: east and north, m; its base's height, m; its height and crown, m; its turn, rad; its kind; its own number. */
export const PLANT_STRIDE = 8;

/** A clump's least cell, m: a shrub's and a tuft's. */
export const CLUMP_CELL = 4;

/** How deep a hollow is, at least, below the mean of its neighbours, dm. */
const HOLLOW = 3;

/** How far a plant keeps from a building's walls, m. */
const BUILDING_CLEAR = 1;

/** A number in [0, 1) from integers: a hash, the same on every machine. */
export function unit(a: number, b: number, c: number, d: number): number {
  let x =
    Math.imul(a | 0, 0x27d4eb2d) ^
    Math.imul(b | 0, 0x165667b1) ^
    Math.imul(c | 0, 0x9e3779b1) ^
    Math.imul(d | 0, 0x85ebca77);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** The axial offsets of a hexagon's neighbours, and the same as offsets on the grid by its column's parity. */
const NEIGHBOURS_EVEN = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [-1, -1],
  [1, 0],
  [1, -1],
] as const;
const NEIGHBOURS_ODD = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [-1, 1],
  [1, 0],
  [1, 1],
] as const;

/** Places chunk n's plants, from its elevations and surfaces and the town on it. */
export function placePlants(
  n: number,
  elevation: Int16Array,
  surface: Uint8Array,
  town: ChunkTown | null,
  look: FloraLook,
  terrace: number,
): Float32Array {
  const cols = GROUND.chunkColumns;
  const rows = GROUND.chunkRows;
  const total = cols * rows;
  const [c0, j0] = chunkCorner(n);
  const neighbour = (c: number, j: number, k: number): number => {
    const d = ((c0 + c) & 1) === 1 ? NEIGHBOURS_ODD[k] : NEIGHBOURS_EVEN[k];
    const nc = c + (d?.[0] ?? 0);
    const nj = j + (d?.[1] ?? 0);
    return nc < 0 || nj < 0 || nc >= cols || nj >= rows ? -1 : nc * rows + nj;
  };
  // Which kinds grow on the chunk at all; none, nothing to do.
  const covers = look.plants.map(() => new Map<number, CoverLook>());
  const present = new Uint8Array(look.cover.length);
  for (let i = 0; i < total; i++) {
    if ((elevation[i] ?? 0) > 0) {
      present[surface[i] ?? 0] = 1;
    }
  }
  let any = false;
  look.cover.forEach((list, s) => {
    if (present[s] === 1) {
      for (const cv of list) {
        covers[cv.plant]?.set(s, cv);
        any = true;
      }
    }
  });
  const gardens = town?.buildings.some((b) => (look.garden[b.kit] ?? -1) >= 0) ?? false;
  if (!any && !gardens) {
    return new Float32Array(0);
  }
  // Each hexagon's distance from the shore, by the steps to the nearest
  // water within the chunk; its steepest slope; whether it is a hollow;
  // whether a building stands on it.
  const shore = new Int16Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < total; i++) {
    if ((elevation[i] ?? 0) <= 0) {
      shore[i] = 0;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++] as number;
    const c = Math.floor(i / rows);
    const j = i % rows;
    for (let k = 0; k < 6; k++) {
      const o = neighbour(c, j, k);
      if (o >= 0 && shore[o] === -1) {
        shore[o] = (shore[i] as number) + 1;
        queue[tail++] = o;
      }
    }
  }
  const blocked = new Uint8Array(total);
  for (const b of town?.buildings ?? []) {
    const reach = Math.hypot(b.frontage, b.depth) / 2 + BUILDING_CLEAR + 4;
    const sh = Math.sin(b.heading);
    const ch = Math.cos(b.heading);
    for (let e = b.east - reach; e <= b.east + reach; e += 2) {
      for (let no = b.north - reach; no <= b.north + reach; no += 2) {
        const dx = e - b.east;
        const dy = no - b.north;
        if (
          Math.abs(dx * sh + dy * ch) > b.depth / 2 + BUILDING_CLEAR ||
          Math.abs(dx * ch - dy * sh) > b.frontage / 2 + BUILDING_CLEAR
        ) {
          continue;
        }
        const [c, j] = cellOf(e, no);
        const lc = c - c0;
        const lj = j - j0;
        if (lc >= 0 && lj >= 0 && lc < cols && lj < rows) {
          blocked[lc * rows + lj] = 1;
        }
      }
    }
  }
  const out: number[] = [];
  const put = (
    e: number,
    no: number,
    y: number,
    h: number,
    crown: number,
    turn: number,
    plant: number,
    seed: number,
  ) => {
    out.push(e, no, y, h, crown, turn, plant, seed);
  };
  // The chunk's extent, m, with a hexagon's margin: a column's hexagons are
  // HEX_STEP apart east, a row's 4 m north, an odd column's 2 m up.
  const HEX_STEP = 1.5 * (4 / Math.sqrt(3));
  const COLUMN_ZERO = (GROUND.chunkSide * cols) / 2;
  const ROW_ZERO = (GROUND.chunkSide * rows) / 2;
  const east0 = (c0 - COLUMN_ZERO) * HEX_STEP - 4;
  const east1 = (c0 + cols - COLUMN_ZERO) * HEX_STEP + 4;
  const north0 = (j0 - ROW_ZERO) * 4 - 4;
  const north1 = (j0 + rows - ROW_ZERO) * 4 + 4;
  look.plants.forEach((p, k) => {
    const on = covers[k];
    if (on === undefined || on.size === 0) {
      return;
    }
    const crown = (p.crown[0] + p.crown[1]) / 2;
    const cell = Math.max(crown, p.cell);
    // Of a cell's area, the share one plant's crown covers.
    const one = (Math.PI * crown * crown) / 4 / (cell * cell);
    for (let gx = Math.floor(east0 / cell); gx * cell < east1; gx++) {
      for (let gy = Math.floor(north0 / cell); gy * cell < north1; gy++) {
        const e = (gx + unit(gx, gy, k, 1)) * cell;
        const no = (gy + unit(gx, gy, k, 2)) * cell;
        const [c, j] = cellOf(e, no);
        const lc = c - c0;
        const lj = j - j0;
        if (lc < 0 || lj < 0 || lc >= cols || lj >= rows) {
          continue;
        }
        const i = lc * rows + lj;
        const el = elevation[i] ?? 0;
        if (el <= 0 || blocked[i] === 1) {
          continue;
        }
        const cv = on.get(surface[i] ?? 0);
        if (cv === undefined || unit(gx, gy, k, 3) >= cv.share / one) {
          continue;
        }
        const m = el / 10;
        if (m < cv.height[0] || m > cv.height[1]) {
          continue;
        }
        const s = shore[i] ?? -1;
        const fromShore = s < 0 ? 1e9 : Math.max(s * 4 - 2, 0);
        if (fromShore < cv.shore[0] || fromShore > cv.shore[1]) {
          continue;
        }
        let steepest = 0;
        let sum = 0;
        let count = 0;
        for (let q = 0; q < 6; q++) {
          const o = neighbour(lc, lj, q);
          if (o < 0) {
            continue;
          }
          const oe = elevation[o] ?? 0;
          if (oe > 0) {
            steepest = Math.max(steepest, Math.abs(oe - el));
            sum += oe;
            count++;
          }
        }
        if ((Math.atan(steepest / 10 / 4) * 180) / Math.PI > cv.slope) {
          continue;
        }
        if (cv.hollow && !(count > 0 && sum / count - el >= HOLLOW)) {
          continue;
        }
        const t = unit(gx, gy, k, 4);
        put(
          e,
          no,
          drawnHeight(el, terrace),
          p.height[0] + (p.height[1] - p.height[0]) * t,
          p.crown[0] + (p.crown[1] - p.crown[0]) * unit(gx, gy, k, 5),
          unit(gx, gy, k, 6) * 2 * Math.PI,
          k,
          Math.floor(unit(gx, gy, k, 7) * 256),
        );
      }
    }
  });
  // A garden tree beside half the houses of a kit with one, at the
  // house's right.
  for (const b of town?.buildings ?? []) {
    const k = look.garden[b.kit] ?? -1;
    const p = look.plants[k];
    if (p === undefined || unit(b.seed, Math.round(b.east), Math.round(b.north), 8) >= 0.5) {
      continue;
    }
    const side = b.frontage / 2 + BUILDING_CLEAR + p.crown[1] / 2;
    const e = b.east + Math.cos(b.heading) * side;
    const no = b.north - Math.sin(b.heading) * side;
    const [c, j] = cellOf(e, no);
    const lc = c - c0;
    const lj = j - j0;
    if (
      lc < 0 ||
      lj < 0 ||
      lc >= cols ||
      lj >= rows ||
      (elevation[lc * rows + lj] ?? 0) <= 0 ||
      blocked[lc * rows + lj] === 1
    ) {
      continue;
    }
    const t = unit(b.seed, Math.round(e), Math.round(no), 9);
    put(
      e,
      no,
      b.level,
      p.height[0] + (p.height[1] - p.height[0]) * t,
      p.crown[0] + (p.crown[1] - p.crown[0]) * t,
      t * 2 * Math.PI,
      k,
      b.seed,
    );
  }
  return Float32Array.from(out);
}
