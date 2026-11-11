// SPDX-License-Identifier: AGPL-3.0-only

// What the cameras may not go into: the land's solids, over the grids the
// page holds. The land's columns, each hexagon of land standing from below
// the sea to its top, by the elevation grid, at the drawn terrace where
// that is higher; the roofs, an arch's span or a cave's roof, a hexagon
// from its underside to its top; the buildings, each a box turned by its
// heading, from its plot's level to its top and its chimney; and the
// lighthouses' towers. Trees, bushes, props, boats and sailors are not
// solid: a camera passes through them, as a game's camera passes through
// foliage. Where no grids are held, the open sea: nothing is solid.
//
// The lookup is asked hundreds of times a frame (a camera's line marched
// in metre steps), so each chunk's grids are indexed when they arrive: the
// chunk is cut into blocks 16 m square, each holding the highest top of
// anything solid that comes within PAD of it and the buildings that do. A
// point above its block's highest is clear at once; below it, the hexagon
// under the point and those beside it within the radius are read from the
// elevation grid, and the block's roofs and buildings measured. Nothing is
// allocated by a lookup.

import { GROUND } from '../predict/layout.gen';
import { drawnHeight } from '../workers/mesh/build';
import type { ChunkGrids, ChunkRoof } from '../workers/mesh/chunk';

/** The widest radius a lookup may ask about, m: what each block takes in beyond its edges. */
export const PAD = 1;
/** The blocks' side, m. */
const BLOCK = 16;

/** A hexagon's width across its flats, its centre to a corner, and the step between columns, m. */
const HEX_ACROSS = 4;
const INRADIUS = HEX_ACROSS / 2;
const HEX_RADIUS = HEX_ACROSS / Math.sqrt(3);
const HEX_STEP = 1.5 * HEX_RADIUS;
const COLUMNS = GROUND.chunkColumns;
const ROWS = GROUND.chunkRows;
const SIDE = GROUND.chunkSide;
const COLUMN_ZERO = (SIDE * COLUMNS) / 2;
const ROW_ZERO = (SIDE * ROWS) / 2;
/** The normals of a hexagon's three pairs of edges (its corners point east and west). */
const N1E = Math.sqrt(3) / 2;
const N1N = 0.5;
/** The six neighbours: axial offsets, and their centres' offsets, m east and north. */
const NEIGHBOUR_Q = [1, 0, -1, -1, 0, 1] as const;
const NEIGHBOUR_R = [0, 1, 1, 0, -1, -1] as const;
const NEIGHBOUR_E = [HEX_STEP, 0, -HEX_STEP, -HEX_STEP, 0, HEX_STEP] as const;
const NEIGHBOUR_N = [2, 4, 2, -2, -4, -2] as const;

/**
 * A lighthouse's tower as render/lights.ts draws it, in its height: its
 * widest (the gallery), the top of its cupola, and how far it stands sunk
 * into its ground, m.
 */
const TOWER_RADIUS = 0.12;
const TOWER_TOP = 1.1;
const TOWER_SUNK = 0.3;
/** A chimney stands this far above a building's top, m (render/town.ts). */
const CHIMNEY = 0.6;
/** A building's walls are at least this high, m, and its eaves reach this much beyond them, of its size, as the far town draws it. */
const LEAST_WALLS = 2;
const EAVES = 1.1;

/** A tower's site: where it stands, its ground's height and its own, m. */
export interface TowerSite {
  east: number;
  north: number;
  ground: number;
  tower: number;
}

/** Where the towers come from: the lighthouses known, and a count of their changes. */
export interface TowerSource {
  readonly sites: ReadonlyMap<number, TowerSite>;
  readonly sitesVersion: number;
}

/** What a camera asks of the solids. */
export interface SolidLookup {
  /** Nothing solid stands higher than this, m above the sea; −∞ with nothing held. */
  readonly ceiling: number;
  /** Whether a ball of this radius about (east, north, up), m, is clear of every solid. */
  clear(east: number, north: number, up: number, radius: number): boolean;
  /** The highest top of anything solid within radius across of (east, north), m; −∞ for none. Roofs are not counted. */
  highest(east: number, north: number, radius: number): number;
  /**
   * Whether a roof within radius across of (east, north) has up in its band,
   * from radius below its underside to over above its top; if so, band
   * holds its underside and top.
   */
  roofAt(east: number, north: number, up: number, radius: number, over: number): boolean;
  /** The last roof roofAt found. */
  readonly band: { under: number; top: number };
}

/** A chunk's solids, indexed. */
interface Indexed {
  number: number;
  /** Its first column and row on the grid. */
  c0: number;
  j0: number;
  elevation: Int16Array | null;
  /** Its blocks: the first's south-western corner, m, how many across and up, each's highest top (−∞ for none). */
  east: number;
  north: number;
  across: number;
  up: number;
  tops: Float32Array;
  /** The block's bounds, m, east and north. */
  maxE: number;
  maxN: number;
  /** The buildings in each block: their indices, the block's from first[b] to first[b + 1]. */
  first: Int32Array;
  items: Int32Array;
  /** Each building: its middle, its axes' cosine and sine, half its frontage and depth, its foot and top. */
  buildings: Float64Array;
  /** The roofs by their hexagon's index in the chunk. */
  roofs: Map<number, ChunkRoof[]>;
  /** The highest top of anything in it, m. */
  highest: number;
}

/** Each building's numbers in Indexed.buildings. */
const B = 8;

export class Solids implements SolidLookup {
  readonly band = { under: 0, top: 0 };
  /** The towers' source; read again when it changes. */
  towers: TowerSource | null = null;

  readonly #terrace: number;
  readonly #chunks = new Map<number, Indexed>();
  /** The chunks indexed, as a list, which a lookup runs through without an iterator. */
  #list: Indexed[] = [];
  /** The towers: east, north, foot, top and radius each. */
  #towers = new Float64Array(0);
  #towerCount = 0;
  #towersSeen = -1;
  #towerTop = Number.NEGATIVE_INFINITY;
  #chunkTop = Number.NEGATIVE_INFINITY;
  /** The hexagon about the point last asked of: its axial position and centre, and the point's hexagonal norm from it. */
  #q = 0;
  #r = 0;
  #de = 0;
  #dn = 0;

  /** The land is drawn in terraces this high, m: a column's top is the higher of its elevation and its terrace. */
  constructor(terrace: number) {
    this.#terrace = terrace;
  }

  get ceiling(): number {
    this.#readTowers();
    return Math.max(this.#chunkTop, this.#towerTop);
  }

  /** The chunks held (the tests). */
  get held(): number {
    return this.#chunks.size;
  }

  /** Chunk n's grids have come: its solids are indexed. */
  add(n: number, g: ChunkGrids): void {
    this.#chunks.set(n, index(n, g, this.#terrace));
    this.#relist();
  }

  /** A chunk's grids are let go. */
  drop(n: number): void {
    if (this.#chunks.delete(n)) {
      this.#relist();
    }
  }

  /** Lets every chunk go. */
  dropAll(): void {
    this.#chunks.clear();
    this.#relist();
  }

  #relist(): void {
    this.#list = [...this.#chunks.values()];
    let top = Number.NEGATIVE_INFINITY;
    for (const c of this.#list) {
      top = Math.max(top, c.highest);
    }
    this.#chunkTop = top;
  }

  /** Reads the towers again if they have changed. */
  #readTowers(): void {
    const t = this.towers;
    const seen = t === null ? -1 : t.sitesVersion;
    if (seen === this.#towersSeen) {
      return;
    }
    this.#towersSeen = seen;
    const sites = t?.sites;
    const n = sites?.size ?? 0;
    if (this.#towers.length < n * 5) {
      this.#towers = new Float64Array(n * 5);
    }
    let k = 0;
    let top = Number.NEGATIVE_INFINITY;
    for (const s of sites?.values() ?? []) {
      if (!(s.tower > 0)) {
        continue;
      }
      const at = k * 5;
      this.#towers[at] = s.east;
      this.#towers[at + 1] = s.north;
      this.#towers[at + 2] = s.ground - TOWER_SUNK;
      this.#towers[at + 3] = s.ground - TOWER_SUNK + TOWER_TOP * s.tower;
      this.#towers[at + 4] = TOWER_RADIUS * s.tower;
      top = Math.max(top, s.ground - TOWER_SUNK + TOWER_TOP * s.tower);
      k++;
    }
    this.#towerCount = k;
    this.#towerTop = top;
  }

  /** Finds the hexagon that holds (east, north): its axial position, and the point's offset from its centre. */
  #hexOf(east: number, north: number): void {
    // Cube rounding (Red Blob Games, "Hexagonal Grids"), as the mesh's cellOf.
    const qf = east / HEX_STEP;
    const rf = north / HEX_ACROSS - qf / 2;
    const sf = -qf - rf;
    let q = Math.round(qf);
    let r = Math.round(rf);
    const s = Math.round(sf);
    const dq = Math.abs(q - qf);
    const dr = Math.abs(r - rf);
    const ds = Math.abs(s - sf);
    if (dq > dr && dq > ds) {
      q = -r - s;
    } else if (dr > ds) {
      r = -q - s;
    }
    this.#q = q;
    this.#r = r;
    this.#de = east - HEX_STEP * q;
    this.#dn = north - HEX_ACROSS * (r + q / 2);
  }

  clear(east: number, north: number, up: number, radius: number): boolean {
    this.#readTowers();
    if (up >= this.#chunkTop + radius && up >= this.#towerTop + radius) {
      return true;
    }
    let found = false;
    const list = this.#list;
    for (let i = 0; i < list.length; i++) {
      const c = list[i] as Indexed;
      const b = blockOf(c, east, north);
      if (b < 0 || up >= (c.tops[b] ?? Number.NEGATIVE_INFINITY) + radius) {
        continue;
      }
      if (!found) {
        this.#hexOf(east, north);
        found = true;
      }
      if (this.#blocked(c, b, east, north, up, radius)) {
        return false;
      }
    }
    return !this.#nearTower(east, north, up, radius);
  }

  /** Whether anything of chunk c's in block b comes within radius of the point. */
  #blocked(
    c: Indexed,
    b: number,
    east: number,
    north: number,
    up: number,
    radius: number,
  ): boolean {
    const de = this.#de;
    const dn = this.#dn;
    // The hexagon under the point: across, nothing between.
    if (this.#hexBlocks(c, this.#q, this.#r, up, radius)) {
      return true;
    }
    // Those beside it, where the point is within radius of an edge.
    if (hexNorm(de, dn) > INRADIUS - radius) {
      for (let k = 0; k < 6; k++) {
        const off = hexNorm(de - (NEIGHBOUR_E[k] ?? 0), dn - (NEIGHBOUR_N[k] ?? 0)) - INRADIUS;
        if (
          off < radius &&
          this.#hexBlocks(
            c,
            this.#q + (NEIGHBOUR_Q[k] ?? 0),
            this.#r + (NEIGHBOUR_R[k] ?? 0),
            up,
            radius,
          )
        ) {
          return true;
        }
      }
    }
    // The buildings in the block.
    const bs = c.buildings;
    for (let k = c.first[b] ?? 0, end = c.first[b + 1] ?? 0; k < end; k++) {
      const at = (c.items[k] ?? 0) * B;
      if (boxDistance(bs, at, east, north, up) < radius) {
        return true;
      }
    }
    return false;
  }

  /** Whether hexagon (q, r), if chunk c's, has its column or a roof within radius of up (the point is within radius across). */
  #hexBlocks(c: Indexed, q: number, r: number, up: number, radius: number): boolean {
    const i = localIndex(c, q, r);
    if (i < 0) {
      return false;
    }
    if (c.elevation !== null && up < columnTop(c.elevation[i] ?? 0, this.#terrace) + radius) {
      return true;
    }
    if (c.roofs.size > 0) {
      const roofs = c.roofs.get(i);
      if (roofs !== undefined) {
        for (let k = 0; k < roofs.length; k++) {
          const f = roofs[k] as ChunkRoof;
          if (up > f.under - radius && up < f.top + radius) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Whether a tower is within radius of the point. */
  #nearTower(east: number, north: number, up: number, radius: number): boolean {
    const t = this.#towers;
    for (let k = 0; k < this.#towerCount; k++) {
      const at = k * 5;
      const h = Math.max(
        Math.hypot(east - (t[at] ?? 0), north - (t[at + 1] ?? 0)) - (t[at + 4] ?? 0),
        0,
      );
      const v = Math.max((t[at + 2] ?? 0) - up, 0, up - (t[at + 3] ?? 0));
      if (h * h + v * v < radius * radius) {
        return true;
      }
    }
    return false;
  }

  highest(east: number, north: number, radius: number): number {
    this.#readTowers();
    let top = Number.NEGATIVE_INFINITY;
    this.#hexOf(east, north);
    const near = hexNorm(this.#de, this.#dn) > INRADIUS - radius;
    const list = this.#list;
    for (let i = 0; i < list.length; i++) {
      const c = list[i] as Indexed;
      const b = blockOf(c, east, north);
      if (b < 0 || (c.tops[b] ?? Number.NEGATIVE_INFINITY) <= top) {
        continue;
      }
      if (c.elevation !== null) {
        top = Math.max(top, this.#columnAt(c, this.#q, this.#r));
        if (near) {
          for (let k = 0; k < 6; k++) {
            const off =
              hexNorm(this.#de - (NEIGHBOUR_E[k] ?? 0), this.#dn - (NEIGHBOUR_N[k] ?? 0)) -
              INRADIUS;
            if (off < radius) {
              top = Math.max(
                top,
                this.#columnAt(c, this.#q + (NEIGHBOUR_Q[k] ?? 0), this.#r + (NEIGHBOUR_R[k] ?? 0)),
              );
            }
          }
        }
      }
      const bs = c.buildings;
      for (let k = c.first[b] ?? 0, end = c.first[b + 1] ?? 0; k < end; k++) {
        const at = (c.items[k] ?? 0) * B;
        if (boxAcross(bs, at, east, north) < radius) {
          top = Math.max(top, bs[at + 7] ?? 0);
        }
      }
    }
    const t = this.#towers;
    for (let k = 0; k < this.#towerCount; k++) {
      const at = k * 5;
      const h = Math.hypot(east - (t[at] ?? 0), north - (t[at + 1] ?? 0)) - (t[at + 4] ?? 0);
      if (h < radius) {
        top = Math.max(top, t[at + 3] ?? 0);
      }
    }
    return top;
  }

  /** The top of hexagon (q, r)'s column, if chunk c holds it and it is land; −∞ otherwise. */
  #columnAt(c: Indexed, q: number, r: number): number {
    const i = localIndex(c, q, r);
    return i < 0 || c.elevation === null
      ? Number.NEGATIVE_INFINITY
      : columnTop(c.elevation[i] ?? 0, this.#terrace);
  }

  roofAt(east: number, north: number, up: number, radius: number, over: number): boolean {
    this.#hexOf(east, north);
    const near = hexNorm(this.#de, this.#dn) > INRADIUS - radius;
    const list = this.#list;
    for (let i = 0; i < list.length; i++) {
      const c = list[i] as Indexed;
      if (c.roofs.size === 0 || blockOf(c, east, north) < 0) {
        continue;
      }
      if (this.#roofIn(c, this.#q, this.#r, up, radius, over)) {
        return true;
      }
      if (near) {
        for (let k = 0; k < 6; k++) {
          const off =
            hexNorm(this.#de - (NEIGHBOUR_E[k] ?? 0), this.#dn - (NEIGHBOUR_N[k] ?? 0)) - INRADIUS;
          if (
            off < radius &&
            this.#roofIn(
              c,
              this.#q + (NEIGHBOUR_Q[k] ?? 0),
              this.#r + (NEIGHBOUR_R[k] ?? 0),
              up,
              radius,
              over,
            )
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  #roofIn(c: Indexed, q: number, r: number, up: number, radius: number, over: number): boolean {
    const i = localIndex(c, q, r);
    const roofs = i < 0 ? undefined : c.roofs.get(i);
    if (roofs === undefined) {
      return false;
    }
    for (let k = 0; k < roofs.length; k++) {
      const f = roofs[k] as ChunkRoof;
      if (up > f.under - radius && up < f.top + over) {
        this.band.under = f.under;
        this.band.top = f.top;
        return true;
      }
    }
    return false;
  }
}

/** A column's top, m, from its elevation in decimetres: the higher of the elevation and its drawn terrace; −∞ under the sea. */
function columnTop(e: number, terrace: number): number {
  return e > 0 ? Math.max(e / 10, drawnHeight(e, terrace)) : Number.NEGATIVE_INFINITY;
}

/** The hexagonal norm of an offset from a hexagon's centre: within INRADIUS is inside, and beyond it no nearer than its excess. */
function hexNorm(de: number, dn: number): number {
  const a = Math.abs(de * N1E + dn * N1N);
  const b = Math.abs(dn);
  const c = Math.abs(-de * N1E + dn * N1N);
  return Math.max(a, b, c);
}

/** The index in chunk c's grids of hexagon (q, r), or −1 if c does not hold it. */
function localIndex(c: Indexed, q: number, r: number): number {
  const lc = q + COLUMN_ZERO - c.c0;
  const lj = r + (q >> 1) + ROW_ZERO - c.j0;
  if (lc < 0 || lj < 0 || lc >= COLUMNS || lj >= ROWS) {
    return -1;
  }
  return lc * ROWS + lj;
}

/** Chunk c's block that holds (east, north), or −1 outside its blocks. */
function blockOf(c: Indexed, east: number, north: number): number {
  if (east < c.east || north < c.north || east >= c.maxE || north >= c.maxN) {
    return -1;
  }
  const x = Math.floor((east - c.east) / BLOCK);
  const y = Math.floor((north - c.north) / BLOCK);
  return y * c.across + x;
}

/** How far a point is from building at in bs, across only, m. */
function boxAcross(bs: Float64Array, at: number, east: number, north: number): number {
  const de = east - (bs[at] ?? 0);
  const dn = north - (bs[at + 1] ?? 0);
  const cos = bs[at + 2] ?? 1;
  const sin = bs[at + 3] ?? 0;
  // Along its frontage (to the right of its front) and its depth (forward).
  const x = Math.max(Math.abs(de * cos - dn * sin) - (bs[at + 4] ?? 0), 0);
  const y = Math.max(Math.abs(de * sin + dn * cos) - (bs[at + 5] ?? 0), 0);
  return Math.sqrt(x * x + y * y);
}

/** How far a point is from building at in bs, m: 0 inside. */
function boxDistance(
  bs: Float64Array,
  at: number,
  east: number,
  north: number,
  up: number,
): number {
  const h = boxAcross(bs, at, east, north);
  const v = Math.max((bs[at + 6] ?? 0) - up, 0, up - (bs[at + 7] ?? 0));
  return Math.sqrt(h * h + v * v);
}

/** Indexes a chunk's solids: its blocks' highest tops and their buildings. */
function index(n: number, g: ChunkGrids, terrace: number): Indexed {
  const c0 = (n % SIDE) * COLUMNS;
  const j0 = Math.floor(n / SIDE) * ROWS;
  // The chunk's outline, and each building's, widened by PAD.
  const q0 = c0 - COLUMN_ZERO;
  const e0 = HEX_STEP * q0;
  const n0 = HEX_ACROSS * (j0 - ROW_ZERO - (q0 >> 1) + q0 / 2);
  let minE = e0 - HEX_RADIUS;
  let maxE = e0 + (COLUMNS - 1) * HEX_STEP + HEX_RADIUS;
  let minN = n0 - HEX_ACROSS;
  let maxN = n0 + ROWS * HEX_ACROSS + INRADIUS;
  const list = g.town?.buildings ?? [];
  const buildings = new Float64Array(list.length * B);
  list.forEach((b, k) => {
    const at = k * B;
    const cos = Math.cos(b.heading);
    const sin = Math.sin(b.heading);
    buildings[at] = b.east;
    buildings[at + 1] = b.north;
    buildings[at + 2] = cos;
    buildings[at + 3] = sin;
    buildings[at + 4] = (EAVES * b.frontage) / 2;
    buildings[at + 5] = (EAVES * b.depth) / 2;
    // From below its plot, where its walls meet the ground, to its chimney.
    buildings[at + 6] = b.level - 1;
    buildings[at + 7] = Math.max(b.top, b.level + LEAST_WALLS) + CHIMNEY;
    const [we, wn] = boxReach(buildings, at);
    minE = Math.min(minE, b.east - we);
    maxE = Math.max(maxE, b.east + we);
    minN = Math.min(minN, b.north - wn);
    maxN = Math.max(maxN, b.north + wn);
  });
  minE -= PAD;
  minN -= PAD;
  maxE += PAD;
  maxN += PAD;
  const across = Math.ceil((maxE - minE) / BLOCK);
  const up = Math.ceil((maxN - minN) / BLOCK);
  const tops = new Float32Array(across * up).fill(Number.NEGATIVE_INFINITY);
  let highest = Number.NEGATIVE_INFINITY;
  // Raises every block a box from (e0, n0) to (e1, n1) touches, widened by PAD, to top.
  const raise = (e0: number, n0: number, e1: number, n1: number, top: number): void => {
    const x0 = Math.max(Math.floor((e0 - PAD - minE) / BLOCK), 0);
    const x1 = Math.min(Math.floor((e1 + PAD - minE) / BLOCK), across - 1);
    const y0 = Math.max(Math.floor((n0 - PAD - minN) / BLOCK), 0);
    const y1 = Math.min(Math.floor((n1 + PAD - minN) / BLOCK), up - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const b = y * across + x;
        if ((tops[b] ?? 0) < top) {
          tops[b] = top;
        }
      }
    }
    highest = Math.max(highest, top);
  };
  const el = g.elevation;
  if (el !== null) {
    for (let i = 0; i < el.length; i++) {
      const e = el[i] ?? 0;
      if (e <= 0) {
        continue;
      }
      const c = c0 + Math.floor(i / ROWS);
      const j = j0 + (i % ROWS);
      const q = c - COLUMN_ZERO;
      const r = j - ROW_ZERO - (q >> 1);
      const he = HEX_STEP * q;
      const hn = HEX_ACROSS * (r + q / 2);
      raise(he - HEX_RADIUS, hn - INRADIUS, he + HEX_RADIUS, hn + INRADIUS, columnTop(e, terrace));
    }
  }
  const roofs = new Map<number, ChunkRoof[]>();
  for (const f of g.features?.roofs ?? []) {
    const lc = f.column - c0;
    const lj = f.row - j0;
    if (lc < 0 || lj < 0 || lc >= COLUMNS || lj >= ROWS) {
      continue;
    }
    const i = lc * ROWS + lj;
    const at = roofs.get(i);
    if (at === undefined) {
      roofs.set(i, [f]);
    } else {
      at.push(f);
    }
    const q = f.column - COLUMN_ZERO;
    const r = f.row - ROW_ZERO - (q >> 1);
    const he = HEX_STEP * q;
    const hn = HEX_ACROSS * (r + q / 2);
    raise(he - HEX_RADIUS, hn - INRADIUS, he + HEX_RADIUS, hn + INRADIUS, f.top);
  }
  // The buildings by block: counted, then placed.
  const counts = new Int32Array(across * up + 1);
  const spans: [number, number, number, number][] = [];
  for (let k = 0; k < list.length; k++) {
    const at = k * B;
    const [we, wn] = boxReach(buildings, at);
    const e = buildings[at] ?? 0;
    const nn = buildings[at + 1] ?? 0;
    raise(e - we, nn - wn, e + we, nn + wn, buildings[at + 7] ?? 0);
    const x0 = Math.max(Math.floor((e - we - PAD - minE) / BLOCK), 0);
    const x1 = Math.min(Math.floor((e + we + PAD - minE) / BLOCK), across - 1);
    const y0 = Math.max(Math.floor((nn - wn - PAD - minN) / BLOCK), 0);
    const y1 = Math.min(Math.floor((nn + wn + PAD - minN) / BLOCK), up - 1);
    spans.push([x0, x1, y0, y1]);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        counts[y * across + x + 1] = (counts[y * across + x + 1] ?? 0) + 1;
      }
    }
  }
  const first = new Int32Array(across * up + 1);
  for (let b = 0; b < across * up; b++) {
    first[b + 1] = (first[b] ?? 0) + (counts[b + 1] ?? 0);
  }
  const items = new Int32Array(first[across * up] ?? 0);
  const fill = first.slice(0, across * up);
  spans.forEach(([x0, x1, y0, y1], k) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const b = y * across + x;
        items[fill[b] ?? 0] = k;
        fill[b] = (fill[b] ?? 0) + 1;
      }
    }
  });
  return {
    number: n,
    c0,
    j0,
    elevation: el,
    east: minE,
    north: minN,
    across,
    up,
    tops,
    maxE: minE + across * BLOCK,
    maxN: minN + up * BLOCK,
    first,
    items,
    buildings,
    roofs,
    highest,
  };
}

/** How far building at in bs reaches from its middle, east and north, m. */
function boxReach(bs: Float64Array, at: number): [number, number] {
  const cos = Math.abs(bs[at + 2] ?? 1);
  const sin = Math.abs(bs[at + 3] ?? 0);
  const hf = bs[at + 4] ?? 0;
  const hd = bs[at + 5] ?? 0;
  return [hf * cos + hd * sin, hf * sin + hd * cos];
}
