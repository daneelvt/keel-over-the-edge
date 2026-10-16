// SPDX-License-Identifier: AGPL-3.0-only

// The ground the page holds, put where it is read. The physics module steps
// the boat on the nine chunks about it, it and its eight neighbours, as the
// server's own chunks have it, so a boat runs aground and is pushed off on
// the same tick on both; a chunk not yet held is deep water and open wind,
// and the server corrects whatever differs. The sea's shaders read the
// ground window: a texture of the hexagons about the camera, a texel each,
// with the water's depth, whether it is land, and the bed's surface, from
// which the tiles take their depth, the shallows' colour and the waves'
// cap.

import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from 'three';
import type { World } from '../catalog/types.gen';
import { GROUND, RECORDS } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { chunkCorner } from '../workers/mesh/build';
import type { ChunkGrids } from '../workers/mesh/chunk';

/** The grid's size in hexagons, and the column and row of the world's centre's. */
const COLUMNS = GROUND.chunkSide * GROUND.chunkColumns;
const ROWS = GROUND.chunkSide * GROUND.chunkRows;
const COLUMN_ZERO = COLUMNS / 2;
const ROW_ZERO = ROWS / 2;
const HEX_STEP = 1.5 * (4 / Math.sqrt(3));

/** Writes the catalog's grounding into the module's groundParams record, as the server reads it. */
export function writeGroundParams(view: Float64Array, world: World): void {
  const G = RECORDS.groundParams;
  view.fill(0);
  world.surfaces.forEach((s, i) => {
    if (i < GROUND.surfaces) {
      view[G.friction + i] = s.friction;
    }
  });
  const g = world.grounding;
  view[G.stillSpeed] = g.stillSpeed;
  view[G.stillTime] = g.stillTime;
  view[G.pushDepth] = g.pushDepth;
  view[G.pushReach] = g.pushReach;
  view[G.restitution] = g.restitution;
  view[G.landFriction] = g.friction;
}

/** The column and row on the grid of the hexagon nearest (east, north). */
export function cellAt(east: number, north: number): [number, number] {
  // Axial coordinates by cube rounding (Red Blob Games, "Hexagonal Grids").
  const qf = east / HEX_STEP;
  const rf = north / 4 - qf / 2;
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
  return [q + COLUMN_ZERO, r + (q >> 1) + ROW_ZERO];
}

/** The chunk that holds (east, north), or −1 off the grid. */
export function chunkAt(east: number, north: number): number {
  const [c, j] = cellAt(east, north);
  if (c < 0 || j < 0 || c >= COLUMNS || j >= ROWS) {
    return -1;
  }
  return Math.floor(j / GROUND.chunkRows) * GROUND.chunkSide + Math.floor(c / GROUND.chunkColumns);
}

/**
 * The nine chunks of the module: the one that holds the boat and its eight
 * neighbours, each in a slot, written from the chunks held as the boat
 * crosses into another chunk or a chunk it needs arrives.
 */
export class ModuleSlots {
  readonly #physics: Physics;
  /** The chunk each slot holds, or −1; and whether it was written from held grids. */
  readonly #slot = new Int32Array(GROUND.slots).fill(-1);
  readonly #filled = new Uint8Array(GROUND.slots);
  #centre = -2;
  #version = -1;

  constructor(physics: Physics, world: World) {
    this.#physics = physics;
    writeGroundParams(physics.records.groundParams, world);
    physics.prepareGround();
    physics.groundUse(true);
    physics.shelterUse(true);
  }

  /** The chunk each slot holds (the tests, the panel). */
  get chunks(): number[] {
    return Array.from(this.#slot);
  }

  /** Lets the module go back to the open sea. */
  release(): void {
    const p = this.#physics;
    for (let s = 0; s < GROUND.slots; s++) {
      p.groundChunk(s, GROUND.chunkSide * GROUND.chunkSide);
      p.shelterChunk(s, GROUND.chunkSide * GROUND.chunkSide);
    }
    this.#slot.fill(-1);
    this.#filled.fill(0);
    p.groundUse(false);
    p.shelterUse(false);
    this.#centre = -2;
  }

  /**
   * Follows the boat at (east, north): the nine chunks about it, from the
   * grids held (version counts their changes). Returns whether a slot was
   * written.
   */
  follow(
    east: number,
    north: number,
    held: ReadonlyMap<number, ChunkGrids>,
    version: number,
  ): boolean {
    const centre = chunkAt(east, north);
    if (centre === this.#centre && version === this.#version) {
      return false;
    }
    this.#centre = centre;
    this.#version = version;
    const want: number[] = [];
    if (centre >= 0) {
      const cx = centre % GROUND.chunkSide;
      const cy = Math.floor(centre / GROUND.chunkSide);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < GROUND.chunkSide && y < GROUND.chunkSide) {
            want.push(y * GROUND.chunkSide + x);
          }
        }
      }
    }
    let wrote = false;
    // Slots already holding a wanted chunk keep it; written again only if
    // its grids have come since.
    const free: number[] = [];
    for (let s = 0; s < GROUND.slots; s++) {
      const n = this.#slot[s] ?? -1;
      const i = want.indexOf(n);
      if (i < 0) {
        free.push(s);
        continue;
      }
      want.splice(i, 1);
      if (this.#filled[s] === 0 && held.has(n)) {
        wrote = this.#write(s, n, held.get(n) as ChunkGrids) || wrote;
      }
    }
    for (const n of want) {
      const s = free.shift();
      if (s === undefined) {
        break;
      }
      const g = held.get(n);
      if (g === undefined) {
        this.#drop(s);
        this.#slot[s] = n;
        this.#filled[s] = 0;
      } else {
        wrote = this.#write(s, n, g) || wrote;
      }
    }
    for (const s of free) {
      this.#drop(s);
    }
    return wrote;
  }

  /** Writes chunk n's grids into slot s: a chunk with no ground or no shelter leaves that slot empty, as the server's holds none. */
  #write(s: number, n: number, g: ChunkGrids): boolean {
    const p = this.#physics;
    const none = GROUND.chunkSide * GROUND.chunkSide;
    if (g.elevation !== null && g.surface !== null) {
      const into = p.groundChunk(s, n);
      into.elevation.set(g.elevation);
      into.surface.set(g.surface);
    } else {
      p.groundChunk(s, none);
    }
    if (g.shelter !== null) {
      p.shelterChunk(s, n).set(g.shelter);
    } else {
      p.shelterChunk(s, none);
    }
    this.#slot[s] = n;
    this.#filled[s] = 1;
    return true;
  }

  #drop(s: number): void {
    const p = this.#physics;
    const none = GROUND.chunkSide * GROUND.chunkSide;
    p.groundChunk(s, none);
    p.shelterChunk(s, none);
    this.#slot[s] = -1;
    this.#filled[s] = 0;
  }
}

/** The ground window's size: columns and rows of hexagons, about ±775 m each way. */
export const WINDOW_COLUMNS = 448;
export const WINDOW_ROWS = 384;
/** It moves to the camera once the camera is this far from its middle, m. */
export const WINDOW_RECENTRE = 200;
/** A texel of open water: as deep as the window tells, no land. */
const DEEP = 255;

/**
 * The ground window: for each hexagon about the camera, a texel of red the
 * water's depth in decimetres (255 for 25.5 m or more, and for land), green
 * the land's height in steps of 0.4 m, blue the surface, alpha 255 for land.
 * A hexagon of a chunk not held is open water.
 */
export class GroundWindow {
  readonly texture: DataTexture;
  /** The column and row of the hexagon at its first texel. */
  col = 0;
  row = 0;
  /** Counts the window's refills (the tests). */
  fills = 0;
  readonly #data: Uint8Array;
  #east = Number.NaN;
  #north = Number.NaN;
  #version = -1;

  constructor() {
    this.#data = new Uint8Array(WINDOW_COLUMNS * WINDOW_ROWS * 4);
    this.#clear();
    this.texture = new DataTexture(
      this.#data,
      WINDOW_COLUMNS,
      WINDOW_ROWS,
      RGBAFormat,
      UnsignedByteType,
    );
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  #clear(): void {
    const d = this.#data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = DEEP;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 0;
    }
  }

  /** Whether a chunk's grids reach into the window. */
  covers(n: number): boolean {
    const [c0, j0] = chunkCorner(n);
    return (
      c0 + GROUND.chunkColumns > this.col &&
      c0 < this.col + WINDOW_COLUMNS &&
      j0 + GROUND.chunkRows > this.row &&
      j0 < this.row + WINDOW_ROWS
    );
  }

  /**
   * Brings the window to the camera at (east, north): moved there once the
   * camera has gone WINDOW_RECENTRE from its middle, and filled again then
   * or when the grids held have changed (version counts their changes).
   * Returns whether it was filled.
   */
  update(
    east: number,
    north: number,
    held: ReadonlyMap<number, ChunkGrids>,
    version: number,
  ): boolean {
    const moved =
      !(Math.hypot(east - this.#east, north - this.#north) < WINDOW_RECENTRE) ||
      Number.isNaN(this.#east);
    if (!moved && version === this.#version) {
      return false;
    }
    if (moved) {
      const [c, j] = cellAt(east, north);
      this.col = c - (WINDOW_COLUMNS >> 1);
      this.row = j - (WINDOW_ROWS >> 1);
      this.#east = east;
      this.#north = north;
    }
    this.#version = version;
    this.#fill(held);
    return true;
  }

  #fill(held: ReadonlyMap<number, ChunkGrids>): void {
    this.#clear();
    const d = this.#data;
    for (const [n, g] of held) {
      if (g.elevation === null || g.surface === null || !this.covers(n)) {
        continue;
      }
      const [c0, j0] = chunkCorner(n);
      const cFrom = Math.max(c0, this.col);
      const cTo = Math.min(c0 + GROUND.chunkColumns, this.col + WINDOW_COLUMNS);
      const jFrom = Math.max(j0, this.row);
      const jTo = Math.min(j0 + GROUND.chunkRows, this.row + WINDOW_ROWS);
      for (let c = cFrom; c < cTo; c++) {
        const base = (c - c0) * GROUND.chunkRows;
        for (let j = jFrom; j < jTo; j++) {
          const e = g.elevation[base + (j - j0)] ?? 0;
          const t = ((j - this.row) * WINDOW_COLUMNS + (c - this.col)) * 4;
          if (e > 0) {
            d[t] = 0;
            d[t + 1] = Math.min(255, Math.round(e / 4));
            d[t + 3] = 255;
          } else {
            d[t] = Math.min(DEEP, -e);
            d[t + 1] = 0;
            d[t + 3] = 0;
          }
          d[t + 2] = g.surface[base + (j - j0)] ?? 0;
        }
      }
    }
    this.texture.needsUpdate = true;
    this.fills++;
  }

  /** The texel at column c and row j of the grid, or null outside the window (the tests). */
  at(c: number, j: number): [number, number, number, number] | null {
    const u = c - this.col;
    const v = j - this.row;
    if (u < 0 || v < 0 || u >= WINDOW_COLUMNS || v >= WINDOW_ROWS) {
      return null;
    }
    const t = (v * WINDOW_COLUMNS + u) * 4;
    const d = this.#data;
    return [d[t] ?? 0, d[t + 1] ?? 0, d[t + 2] ?? 0, d[t + 3] ?? 0];
  }
}
