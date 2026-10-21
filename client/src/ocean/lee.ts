// SPDX-License-Identifier: AGPL-3.0-only

// The waves' lee on the water: the share of the boat band the land's lee
// leaves, a texel for each of the shelter's cells (8 by 8 hexagons) about
// the camera, as the physics module works it out for each cell's centre
// from the chunks' lee bytes and the sea of the window drawn (leeGrid).
// The tiles' plane, the far sea and the surf read it, bilinear between
// cells' centres as the physics is: the shader interpolates the four texels
// itself, in floats, so that a tile rides the plane the boat on it feels
// (a texture's own filtering keeps only eight bits of the weights). It is
// asked for again once a second, when the sea drawn changes, or when the
// camera has moved to another part of the grid.

import { DataTexture, FloatType, NearestFilter, RedFormat } from 'three';
import { cellAt } from '../land/ground';
import type { Physics } from '../predict/physics';

/** The cells a side: the module's leeGrid's. */
export const LEE_SIDE = 64;
/** How often it is asked for again, ms. */
const EVERY = 1000;
/** The camera moves this many cells from the middle before the texture follows. */
const SLACK = 8;

export class LeeTexture {
  readonly texture: DataTexture;
  /** The cell at its first texel, on the whole grid of cells. */
  a0 = 0;
  b0 = 0;
  /** Counts the refills (the tests). */
  fills = 0;
  readonly #data: Float32Array;
  #at = Number.NEGATIVE_INFINITY;
  #slot = Number.NaN;
  #version = Number.NaN;

  constructor() {
    this.#data = new Float32Array(LEE_SIDE * LEE_SIDE).fill(1);
    this.texture = new DataTexture(this.#data, LEE_SIDE, LEE_SIDE, RedFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  /**
   * Brings the texture to the camera at (east, north) for the sea of the
   * module's window slot, whose areas the seas' version counts, at now
   * (ms); with no window it is all 1. force refills it.
   */
  update(
    physics: Physics,
    slot: number,
    version: number,
    east: number,
    north: number,
    now: number,
    force = false,
  ): boolean {
    const [c, j] = cellAt(east, north);
    const a = Math.floor(c / 8);
    const b = Math.floor(j / 8);
    const half = LEE_SIDE >> 1;
    const moved =
      Math.abs(a - (this.a0 + half)) > SLACK ||
      Math.abs(b - (this.b0 + half)) > SLACK ||
      this.fills === 0;
    const changed = slot !== this.#slot || version !== this.#version;
    if (!force && !moved && !changed && now - this.#at < EVERY) {
      return false;
    }
    if (moved) {
      this.a0 = a - half;
      this.b0 = b - half;
    }
    this.#at = now;
    this.#slot = slot;
    this.#version = version;
    if (slot < 0) {
      this.#data.fill(1);
    } else {
      this.#data.set(physics.leeGrid(slot, this.a0, this.b0));
    }
    this.texture.needsUpdate = true;
    this.fills++;
    return true;
  }

  /** The factor stored for cell (a, b), or null outside (the tests). */
  at(a: number, b: number): number | null {
    const u = a - this.a0;
    const v = b - this.b0;
    if (u < 0 || v < 0 || u >= LEE_SIDE || v >= LEE_SIDE) {
      return null;
    }
    return this.#data[v * LEE_SIDE + u] ?? 1;
  }
}
