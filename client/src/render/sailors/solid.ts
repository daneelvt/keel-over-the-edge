// SPDX-License-Identifier: AGPL-3.0-only

// The dinghy as a solid a sailor is kept out of: the hull from its keel to
// its sheer, its sections the superellipses the model is built with, less
// the cockpit, open above its floor; and the daggerboard, a thin slab under
// the hull. Read from the model's `hull` node (its data `solid`) and its
// `board-root` node; in the model's frame (x to starboard, y up, z aft).

import type { Vector3 } from 'three';

export interface HullSolid {
  /** [z, half-beam at the sheer, the sheer's height, the keel's depth], transom to stem. */
  stations: number[][];
  exponent: number;
  cockpit: { fore: number; aft: number; halfWidth: number; floor: number };
  /** The daggerboard: its root under the hull, its span down, its chord and thickness. */
  board: { y: number; z: number; span: number; chord: number; thickness: number };
}

/** The solid from the model's data, or null if it has none. */
export function hullSolid(
  data: unknown,
  boardRoot: Vector3 | null,
  board: { span: number; chord: number },
): HullSolid | null {
  const s = (data as { solid?: Partial<HullSolid> } | undefined)?.solid;
  if (
    s === undefined ||
    !Array.isArray(s.stations) ||
    typeof s.exponent !== 'number' ||
    s.cockpit === undefined ||
    boardRoot === null
  ) {
    return null;
  }
  return {
    stations: s.stations,
    exponent: s.exponent,
    cockpit: s.cockpit,
    board: {
      y: boardRoot.y,
      z: boardRoot.z,
      span: board.span,
      chord: board.chord,
      thickness: 0.03,
    },
  };
}

/** The station's numbers at z, between the two nearest; null beyond the ends. */
function at(solid: HullSolid, z: number): [number, number, number] | null {
  const st = solid.stations;
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i] as number[];
    const b = st[i + 1] as number[];
    const za = a[0] as number;
    const zb = b[0] as number;
    if ((z <= za && z >= zb) || (z >= za && z <= zb)) {
      const f = za === zb ? 0 : (z - za) / (zb - za);
      const mix = (k: number): number =>
        (a[k] as number) + ((b[k] as number) - (a[k] as number)) * f;
      return [mix(1), mix(2), mix(3)];
    }
  }
  return null;
}

/** The hull's half-width at height y at a station, or -1 above its sheer or below its keel. */
function halfWidth(solid: HullSolid, z: number, y: number): number {
  const s = at(solid, z);
  if (s === null) {
    return -1;
  }
  const [beam, sheer, depth] = s;
  if (y > sheer || y < -depth || sheer + depth <= 0) {
    return -1;
  }
  // The section: x = b sin(a)^e, y = -d + (s + d)(1 - cos(a)^e), e = 2/n.
  const e = 2 / solid.exponent;
  const c = Math.max(0, 1 - (y + depth) / (sheer + depth)) ** (1 / e);
  const sin = Math.sqrt(Math.max(0, 1 - c * c));
  return beam * sin ** e;
}

/** Whether a point is inside the hull or the board. */
export function inside(solid: HullSolid, x: number, y: number, z: number): boolean {
  const b = solid.board;
  if (
    Math.abs(x) < b.thickness / 2 &&
    y < b.y &&
    y > b.y - b.span &&
    Math.abs(z - b.z) < b.chord / 2
  ) {
    return true;
  }
  const c = solid.cockpit;
  // The cockpit: open above its floor.
  if (Math.abs(x) < c.halfWidth && z > c.fore && z < c.aft && y > c.floor) {
    return false;
  }
  const w = halfWidth(solid, z, y);
  return w > 0 && Math.abs(x) < w;
}

/** Whether any of a few points round a ball at p of radius r is inside. */
export function ballInside(solid: HullSolid, x: number, y: number, z: number, r: number): boolean {
  if (inside(solid, x, y, z)) {
    return true;
  }
  for (const [dx, dy, dz] of DIRS) {
    if (inside(solid, x + dx * r, y + dy * r, z + dz * r)) {
      return true;
    }
  }
  return false;
}

const S = Math.SQRT1_2;
const DIRS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
  [S, S, 0],
  [-S, S, 0],
  [S, -S, 0],
  [-S, -S, 0],
  [0, S, S],
  [0, -S, S],
  [0, S, -S],
  [0, -S, -S],
];

/**
 * How far the hull reaches toward a side (x's sign, side) from its pivot
 * (a height on the centreline), in a frame turned by turn about the
 * fore-and-aft axis (a point (x, y) about the pivot is (x cos − y sin,
 * x sin + y cos) there), between two stations: the furthest of its
 * sections' outlines.
 */
export function reach(
  solid: HullSolid,
  side: number,
  turn: number,
  pivot: number,
  z0: number,
  z1: number,
): number {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  let most = -Infinity;
  const e = 2 / solid.exponent;
  for (let k = 0; k <= 6; k++) {
    const st = at(solid, z0 + ((z1 - z0) * k) / 6);
    if (st === null) {
      continue;
    }
    const [beam, sheer, depth] = st;
    for (let g = 0; g <= 16; g++) {
      const a = (g / 16) * (Math.PI / 2);
      const x = beam * Math.sin(a) ** e;
      const y = -depth + (sheer + depth) * (1 - Math.cos(a) ** e) - pivot;
      most = Math.max(most, side * (x * c - y * s), side * (-x * c - y * s));
    }
  }
  return most;
}
