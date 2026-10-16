// SPDX-License-Identifier: AGPL-3.0-only

// The lee on the water: the land's shelter for the mean wind's direction,
// a texel for each of the shelter's cells (8 by 8 hexagons) about the
// camera, which the sea's shaders read to calm the water in the lee: its
// gust patches, the detail band's ripples and its whitecaps. It is the
// module's own shelter, the server's tables, so the water shows the wind the
// boat feels. It is asked for again once a second, or as soon as the wind
// has turned 5°, or the camera has moved to another part of the grid.

import { DataTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import type { Physics } from '../predict/physics';
import { cellAt } from './ground';

/** The cells a side: the module's shelterGrid's, about 1.8 by 2 km. */
export const SHELTER_SIDE = 64;
/** Factors are stored as a byte of factor × this, so that 1 is a whole byte: up to 2. */
export const SHELTER_SCALE = 127;
const SCALE = SHELTER_SCALE;
/** How often it is asked for again, ms, and how far the wind may turn first, rad. */
const EVERY = 1000;
const TURN = (5 * Math.PI) / 180;
/** The camera moves this many cells from the middle before the texture follows. */
const SLACK = 8;

export class ShelterTexture {
  readonly texture: DataTexture;
  /** The cell at its first texel, on the whole grid of cells. */
  a0 = 0;
  b0 = 0;
  /** Counts the refills (the tests). */
  fills = 0;
  readonly #data: Uint8Array;
  #at = Number.NEGATIVE_INFINITY;
  #from = Number.NaN;

  constructor() {
    this.#data = new Uint8Array(SHELTER_SIDE * SHELTER_SIDE * 4).fill(Math.round(SCALE));
    this.texture = new DataTexture(
      this.#data,
      SHELTER_SIDE,
      SHELTER_SIDE,
      RGBAFormat,
      UnsignedByteType,
    );
    // Bilinear between cells' centres, as the physics reads them.
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /** Brings the texture to the camera at (east, north) for a mean wind from from, at now (ms); force refills it. */
  update(
    physics: Physics,
    east: number,
    north: number,
    from: number,
    now: number,
    force = false,
  ): boolean {
    const [c, j] = cellAt(east, north);
    const a = Math.floor(c / 8);
    const b = Math.floor(j / 8);
    const half = SHELTER_SIDE >> 1;
    const moved =
      Math.abs(a - (this.a0 + half)) > SLACK ||
      Math.abs(b - (this.b0 + half)) > SLACK ||
      this.fills === 0;
    const turned = !(
      Math.abs(Math.atan2(Math.sin(from - this.#from), Math.cos(from - this.#from))) < TURN
    );
    if (!force && !moved && !turned && now - this.#at < EVERY) {
      return false;
    }
    if (moved) {
      this.a0 = a - half;
      this.b0 = b - half;
    }
    this.#at = now;
    this.#from = from;
    const grid = physics.shelterGrid(this.a0, this.b0, from);
    const d = this.#data;
    for (let i = 0; i < SHELTER_SIDE * SHELTER_SIDE; i++) {
      d[i * 4] = Math.min(255, Math.round((grid[i] ?? 1) * SCALE));
    }
    this.texture.needsUpdate = true;
    this.fills++;
    return true;
  }

  /** The factor stored for cell (a, b), or null outside (the tests). */
  at(a: number, b: number): number | null {
    const u = a - this.a0;
    const v = b - this.b0;
    if (u < 0 || v < 0 || u >= SHELTER_SIDE || v >= SHELTER_SIDE) {
      return null;
    }
    return (this.#data[(v * SHELTER_SIDE + u) * 4] ?? 0) / SCALE;
  }
}

/** A factor as the texture stores it (the tests). */
export function storedFactor(f: number): number {
  return Math.min(255, Math.round(f * SCALE)) / SCALE;
}
