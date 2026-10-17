// SPDX-License-Identifier: AGPL-3.0-only

// A chunk's land as one mesh: each hexagon of land a column on the sea's
// own lattice, its top a flat hexagon of four triangles at its drawn
// height, its sides drawn only where its neighbour is drawn lower, down to
// the neighbour's top, or below the sea at the shore. Heights are drawn in
// terraces (land lower than one at its own height), which the physics never
// sees. Vertices are in the chunk's own coordinates, from the centre of its
// south-western hexagon, in the scene's axes (x east, y up, z south), so
// that they stay exact in 32-bit floats wherever the chunk lies; each
// carries its colour, sRGB, and in alpha whether it is a top (255) or a
// side (0), for the look's seams and bevels.

import { GROUND } from '../../predict/layout.gen';

/** A hexagon's width across its flats, m: the sea's tiles'. */
const HEX_ACROSS = 4;
/** Its centre to a corner, and the distance between neighbouring columns' centres. */
const HEX_RADIUS = HEX_ACROSS / Math.sqrt(3);
const HEX_STEP = 1.5 * HEX_RADIUS;
/** The column and row of the world's centre's hexagon on the grid. */
const COLUMN_ZERO = (GROUND.chunkSide * GROUND.chunkColumns) / 2;
const ROW_ZERO = (GROUND.chunkSide * GROUND.chunkRows) / 2;
/** The axial offsets of a hexagon's six neighbours, the k-th across the edge from corner k to corner k + 1. */
const NEIGHBOURS = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
] as const;

/** How a chunk's land is drawn: the catalog's world look and surfaces. */
export interface LandLook {
  /** Terraces' height, m. */
  terrace: number;
  /** How far below the sea a column's sides reach at the shore, m. */
  shore: number;
  /** Each surface's top and side colour, sRGB 0 … 255, three bytes each, by the surface's index. */
  top: Uint8Array;
  side: Uint8Array;
  /** The surface a pier's deck is, drawn as planking on piles, not a column; −1 for none. */
  deck: number;
}

/** How deep a deck's planking is, m, and how thick its piles. */
const DECK = 0.35;
const PILE = 0.32;

/**
 * The elevation, in decimetres, of the hexagon at column c and row j of the
 * grid, outside the chunk being built, or undefined where it is not known:
 * a side toward an unknown neighbour is drawn, as toward the sea.
 */
export type Outside = (c: number, j: number) => number | undefined;

/** A chunk's mesh, its buffers ready to hand to the GPU. */
export interface ChunkMesh {
  number: number;
  /** x, y, z of each vertex, m, from the chunk's origin. */
  positions: Float32Array;
  /** Each vertex's sRGB colour and whether it is a top, a byte each. */
  colours: Uint8Array;
  indices: Uint32Array;
  /** The chunk's origin: its south-western hexagon's centre, m east and north of the world's centre. */
  east: number;
  north: number;
  /** The highest drawn top, m; −∞ with no land. */
  highest: number;
  triangles: number;
  /** The sides drawn toward a neighbour outside the chunk not known. */
  blind: number;
}

/** Hexagon (q, r)'s centre on the world's lattice, m east and north. */
export function hexCentre(q: number, r: number): [number, number] {
  return [HEX_STEP * q, HEX_ACROSS * (r + q / 2)];
}

/** The axial (q, r) of the hexagon at column c and row j of the grid. */
export function cellHex(c: number, j: number): [number, number] {
  const q = c - COLUMN_ZERO;
  return [q, j - ROW_ZERO - (q >> 1)];
}

/** The column and row of hexagon (q, r). */
export function hexCell(q: number, r: number): [number, number] {
  return [q + COLUMN_ZERO, r + (q >> 1) + ROW_ZERO];
}

/** Chunk n's first column and row: its south-western hexagon. */
export function chunkCorner(n: number): [number, number] {
  return [
    (n % GROUND.chunkSide) * GROUND.chunkColumns,
    Math.floor(n / GROUND.chunkSide) * GROUND.chunkRows,
  ];
}

/**
 * A height as drawn, m, from an elevation in decimetres: in terraces, to
 * the nearest; land lower than one terrace at its own height.
 */
export function drawnHeight(e: number, terrace: number): number {
  const m = e / 10;
  return m < terrace ? m : Math.round(m / terrace) * terrace;
}

/** A hexagon's own slight shade, ±4%, from its column and row. */
function shade(c: number, j: number): number {
  let x = ((c & 0xffff) | ((j & 0xffff) << 16)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return 0.96 + 0.08 * ((x >>> 8) / 16777216);
}

/** How dark a side is at its foot, where it meets the sea or the column below. */
const FOOT = 0.62;

/**
 * Builds chunk n's mesh from its elevations and surfaces, as the look
 * draws them. A neighbour outside the chunk is as outside says, or the
 * sea's where it does not know.
 */
export function buildChunk(
  n: number,
  elevation: Int16Array,
  surface: Uint8Array,
  look: LandLook,
  outside: Outside = () => undefined,
): ChunkMesh {
  const cols = GROUND.chunkColumns;
  const rows = GROUND.chunkRows;
  const [c0, j0] = chunkCorner(n);
  const [q0, r0] = cellHex(c0, j0);
  const [ox, oy] = hexCentre(q0, r0);
  const drawn = new Float32Array(cols * rows);
  let tops = 0;
  for (let i = 0; i < drawn.length; i++) {
    const e = elevation[i] ?? 0;
    if (e > 0) {
      drawn[i] = drawnHeight(e, look.terrace);
      tops++;
    } else {
      drawn[i] = -look.shore;
    }
  }
  // The drawn height of the neighbour across edge k of the hexagon at
  // (c, j) in the chunk; blindly is set when it lies outside, not known.
  let blindly = false;
  const across = (c: number, j: number, k: number): number => {
    const [q, r] = cellHex(c0 + c, j0 + j);
    const d = NEIGHBOURS[k] as readonly [number, number];
    const [nc, nj] = hexCell(q + d[0], r + d[1]);
    const lc = nc - c0;
    const lj = nj - j0;
    blindly = false;
    if (lc >= 0 && lj >= 0 && lc < cols && lj < rows) {
      return drawn[lc * rows + lj] ?? 0;
    }
    const e = outside(nc, nj);
    if (e === undefined) {
      blindly = true;
      return -look.shore;
    }
    return e > 0 ? drawnHeight(e, look.terrace) : -look.shore;
  };
  let sides = 0;
  let piles = 0;
  let blind = 0;
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < rows; j++) {
      const i = c * rows + j;
      if ((elevation[i] ?? 0) <= 0) {
        continue;
      }
      const h = drawn[i] ?? 0;
      if ((surface[i] ?? 0) === look.deck) {
        piles++;
      }
      for (let k = 0; k < 6; k++) {
        if (across(c, j, k) < h) {
          sides++;
          if (blindly) {
            blind++;
          }
        }
      }
    }
  }
  sides += piles * 4;
  const vertices = tops * 6 + sides * 4;
  const positions = new Float32Array(vertices * 3);
  const colours = new Uint8Array(vertices * 4);
  const indices = new Uint32Array(tops * 12 + sides * 6);
  let v = 0;
  let x = 0;
  let highest = Number.NEGATIVE_INFINITY;
  const cx = new Float64Array(6);
  const cz = new Float64Array(6);
  for (let k = 0; k < 6; k++) {
    cx[k] = HEX_RADIUS * Math.cos((k * Math.PI) / 3);
    cz[k] = -HEX_RADIUS * Math.sin((k * Math.PI) / 3);
  }
  const put = (
    px: number,
    py: number,
    pz: number,
    rgb: Uint8Array,
    at: number,
    f: number,
    top: boolean,
  ) => {
    positions[v * 3] = px;
    positions[v * 3 + 1] = py;
    positions[v * 3 + 2] = pz;
    colours[v * 4] = Math.min(255, Math.round((rgb[at] ?? 0) * f));
    colours[v * 4 + 1] = Math.min(255, Math.round((rgb[at + 1] ?? 0) * f));
    colours[v * 4 + 2] = Math.min(255, Math.round((rgb[at + 2] ?? 0) * f));
    colours[v * 4 + 3] = top ? 255 : 0;
    v++;
  };
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < rows; j++) {
      const i = c * rows + j;
      if ((elevation[i] ?? 0) <= 0) {
        continue;
      }
      const h = drawn[i] ?? 0;
      highest = Math.max(highest, h);
      const [q, r] = cellHex(c0 + c, j0 + j);
      const [hx, hy] = hexCentre(q, r);
      const sx = hx - ox;
      const sz = -(hy - oy);
      const s = Math.min(surface[i] ?? 0, GROUND.surfaces - 1) * 3;
      const tint = shade(c0 + c, j0 + j);
      // The top: corners 0 … 5, a fan of four triangles from corner 0,
      // counter-clockwise seen from above.
      const first = v;
      for (let k = 0; k < 6; k++) {
        put(sx + (cx[k] ?? 0), h, sz + (cz[k] ?? 0), look.top, s, tint, true);
      }
      for (let k = 1; k < 5; k++) {
        indices[x++] = first;
        indices[x++] = first + k;
        indices[x++] = first + k + 1;
      }
      // The sides toward lower neighbours: a quad from this top down to
      // theirs, facing out; a deck's only its planking's depth, and a pile
      // under its middle down to the bed.
      const deck = (surface[i] ?? 0) === look.deck;
      const quad = (ax: number, az: number, bx: number, bz: number, top: number, low: number) => {
        const base = v;
        put(sx + ax, top, sz + az, look.side, s, tint, false);
        put(sx + bx, top, sz + bz, look.side, s, tint, false);
        put(sx + ax, low, sz + az, look.side, s, tint * FOOT, false);
        put(sx + bx, low, sz + bz, look.side, s, tint * FOOT, false);
        indices[x++] = base;
        indices[x++] = base + 2;
        indices[x++] = base + 1;
        indices[x++] = base + 1;
        indices[x++] = base + 2;
        indices[x++] = base + 3;
      };
      if (deck) {
        const p = PILE / 2;
        const corners = [
          [p, p],
          [p, -p],
          [-p, -p],
          [-p, p],
        ] as const;
        for (let k = 0; k < 4; k++) {
          const a = corners[k] as readonly [number, number];
          const b = corners[(k + 1) % 4] as readonly [number, number];
          quad(a[0], a[1], b[0], b[1], h - DECK, -look.shore);
        }
      }
      for (let k = 0; k < 6; k++) {
        let low = across(c, j, k);
        if (low >= h) {
          continue;
        }
        if (deck) {
          low = Math.max(low, h - DECK);
        }
        const a = k;
        const b = (k + 1) % 6;
        const base = v;
        put(sx + (cx[a] ?? 0), h, sz + (cz[a] ?? 0), look.side, s, tint, false);
        put(sx + (cx[b] ?? 0), h, sz + (cz[b] ?? 0), look.side, s, tint, false);
        put(sx + (cx[a] ?? 0), low, sz + (cz[a] ?? 0), look.side, s, tint * FOOT, false);
        put(sx + (cx[b] ?? 0), low, sz + (cz[b] ?? 0), look.side, s, tint * FOOT, false);
        // Counter-clockwise seen from outside: the corners run counter-
        // clockwise seen from above, so outside sees a to b left to right.
        indices[x++] = base;
        indices[x++] = base + 2;
        indices[x++] = base + 1;
        indices[x++] = base + 1;
        indices[x++] = base + 2;
        indices[x++] = base + 3;
      }
    }
  }
  return {
    number: n,
    positions,
    colours,
    indices,
    east: ox,
    north: oy,
    highest,
    triangles: indices.length / 3,
    blind,
  };
}

/**
 * A chunk's edges as its neighbours' builds need them: the elevations of
 * its first and last column and row, or nothing for a chunk all deep sea.
 */
export interface ChunkEdges {
  west: Int16Array;
  east: Int16Array;
  south: Int16Array;
  north: Int16Array;
}

/** Chunk n's edges, from its elevations, or null for a chunk with no ground. */
export function edgesOf(elevation: Int16Array | null): ChunkEdges | null {
  if (elevation === null) {
    return null;
  }
  const cols = GROUND.chunkColumns;
  const rows = GROUND.chunkRows;
  const south = new Int16Array(cols);
  const north = new Int16Array(cols);
  for (let c = 0; c < cols; c++) {
    south[c] = elevation[c * rows] ?? 0;
    north[c] = elevation[c * rows + rows - 1] ?? 0;
  }
  return {
    west: elevation.slice(0, rows),
    east: elevation.slice((cols - 1) * rows, cols * rows),
    south,
    north,
  };
}

/**
 * Looks up the elevation of a hexagon outside a chunk in the edges known of
 * its neighbours, by chunk number: a chunk known to have no ground is deep
 * sea, one not known undefined.
 */
export function outsideOf(edges: Map<number, ChunkEdges | null>): Outside {
  const cols = GROUND.chunkColumns;
  const rows = GROUND.chunkRows;
  const side = GROUND.chunkSide;
  return (c, j) => {
    if (c < 0 || j < 0 || c >= side * cols || j >= side * rows) {
      return -400;
    }
    const n = Math.floor(j / rows) * side + Math.floor(c / cols);
    if (!edges.has(n)) {
      return undefined;
    }
    const e = edges.get(n);
    if (e === null || e === undefined) {
      return -400;
    }
    const lc = c % cols;
    const lj = j % rows;
    if (lc === 0) {
      return e.west[lj];
    }
    if (lc === cols - 1) {
      return e.east[lj];
    }
    if (lj === 0) {
      return e.south[lc];
    }
    if (lj === rows - 1) {
      return e.north[lc];
    }
    return undefined;
  };
}
