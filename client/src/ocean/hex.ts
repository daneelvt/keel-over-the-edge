// SPDX-License-Identifier: AGPL-3.0-only

// The sea's hexagonal lattice, fixed in the world: hexagons 4 m across the
// flats with corners pointing east and west, one of them centred on the
// disk's centre. A tile is named by its axial coordinates (q, r), as in
// Red Blob Games' "Hexagonal Grids" (flat-top orientation):
// https://www.redblobgames.com/grids/hexagons/
//
// Positions here are world positions: x east, y north, in metres.

/** Distance across a tile's flats, in metres. */
export const TILE_ACROSS = 4;
/** Distance from a tile's centre to a corner (its circumradius). */
export const TILE_RADIUS = TILE_ACROSS / Math.sqrt(3);
/** Distance from a tile's centre to the middle of an edge (its apothem). */
export const TILE_APOTHEM = TILE_ACROSS / 2;
/** Every tile whose centre lies within this distance of the centre tile's is drawn. */
export const FIELD_RADIUS = 150;

const SQRT3 = Math.sqrt(3);

export interface Hex {
  q: number;
  r: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Writes the world position of tile (q, r)'s centre into out. */
export function hexCentre(q: number, r: number, out: Point): Point {
  out.x = 1.5 * TILE_RADIUS * q;
  out.y = TILE_ACROSS * (r + q / 2);
  return out;
}

/** Writes the tile that contains the world point (x, y) into out, by cube rounding. */
export function hexAt(x: number, y: number, out: Hex): Hex {
  const fq = (2 / 3) * (x / TILE_RADIUS);
  const fr = (-x / 3 + (SQRT3 / 3) * y) / TILE_RADIUS;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) {
    q = -r - s;
  } else if (dr > ds) {
    r = -q - s;
  }
  // Math.round can return -0; tile identities are plain integers.
  out.q = q + 0;
  out.r = r + 0;
  return out;
}

/** The six neighbours' offsets, counter-clockwise from the one to the north-east. */
export const NEIGHBOURS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
  { q: 1, r: -1 },
];

/** The number of tiles between two tiles. */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/**
 * The tile field: every tile whose centre lies within FIELD_RADIUS of the
 * centre tile's, in a fixed order (nearest first, so the instance index of
 * the centre tile is 0). Each entry is the tile's offset from the centre
 * tile, in tiles and in metres.
 */
export interface Field {
  count: number;
  /** dq, dr of each tile. */
  hex: Int16Array;
  /** East and north offset of each tile's centre, in metres. */
  offset: Float64Array;
}

export function makeField(radius = FIELD_RADIUS): Field {
  const span = Math.ceil(radius / (1.5 * TILE_RADIUS)) + 1;
  const tiles: { q: number; r: number; x: number; y: number; d: number }[] = [];
  const p = { x: 0, y: 0 };
  for (let q = -span; q <= span; q++) {
    for (let r = -2 * span; r <= 2 * span; r++) {
      hexCentre(q, r, p);
      const d = Math.hypot(p.x, p.y);
      if (d <= radius) {
        tiles.push({ q, r, x: p.x, y: p.y, d });
      }
    }
  }
  tiles.sort((a, b) => a.d - b.d || a.q - b.q || a.r - b.r);
  const field: Field = {
    count: tiles.length,
    hex: new Int16Array(tiles.length * 2),
    offset: new Float64Array(tiles.length * 2),
  };
  tiles.forEach((t, i) => {
    field.hex[i * 2] = t.q;
    field.hex[i * 2 + 1] = t.r;
    field.offset[i * 2] = t.x;
    field.offset[i * 2 + 1] = t.y;
  });
  return field;
}

/**
 * A tile's hash: an integer of 24 bits from its (q, r), the same here and on
 * the GPU (tileHash in seamaterial.ts). The mixing is Chris Wellons's
 * "lowbias32" (https://nullprogram.com/blog/2018/07/31/). Every tile within
 * the disk has |q|, |r| < 32768, so the pair packs into one 32-bit word.
 */
export function tileHash(q: number, r: number): number {
  let x = (((q + 32768) & 0xffff) | (((r + 32768) & 0xffff) << 16)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 8;
}
