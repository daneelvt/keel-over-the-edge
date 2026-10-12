// SPDX-License-Identifier: AGPL-3.0-only

// The foam's pattern and the sea's noise, made once into one small texture
// that repeats: four channels a fragment reads with one lookup instead of
// searching cells and summing noise itself.
//
//   red    lace: the edges between the cells about scattered points, bright
//          on an edge (Worley, "A Cellular Texture Basis Function", 1996:
//          the difference of the distances to the two nearest points)
//   green  fine noise, half a metre across
//   blue   coarse noise in three octaves, three metres across: it breaks the
//          whitecaps into patches
//   alpha  fine noise again, of its own: with green, the shimmer's two slopes
//
// Every layer wraps at the texture's edge, so the pattern has no seam.

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
} from 'three';
import { FOAM } from './look';

/** Cells of each layer across the pattern: lace, fine noise, and the coarse noise's first octave. */
export const LACE_CELLS = 32;
export const FINE_CELLS = 84;
export const COARSE_CELLS = 15;

/** Mixes the bits of x (Wellons's lowbias32), to [0, 1). */
function hash(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A value for cell (i, j) of a layer with `cells` across, wrapping, from a seed. */
function cellValue(i: number, j: number, cells: number, seed: number): number {
  const a = ((i % cells) + cells) % cells;
  const b = ((j % cells) + cells) % cells;
  return hash((a + b * 1024 + seed * 1048576) >>> 0);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Value noise at (x, y) in cells, wrapping after `cells`. */
function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = cellValue(i, j, cells, seed);
  const b = cellValue(i + 1, j, cells, seed);
  const c = cellValue(i, j + 1, cells, seed);
  const d = cellValue(i + 1, j + 1, cells, seed);
  return a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uy;
}

/** The lace at (x, y) in cells: 1 on the edge between two cells, falling to 0 inside them. */
function lace(x: number, y: number, cells: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  let nearest = 9;
  let second = 9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      // Each cell's point, kept a little inside it.
      const px = i + di + 0.075 + 0.85 * cellValue(i + di, j + dj, cells, 1);
      const py = j + dj + 0.075 + 0.85 * cellValue(i + di, j + dj, cells, 2);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < nearest) {
        second = nearest;
        nearest = d;
      } else if (d < second) {
        second = d;
      }
    }
  }
  return 1 - smoothstep(0, 0.42, Math.sqrt(second) - Math.sqrt(nearest));
}

/** The pattern's texels, RGBA, 8 bits each, size × size. */
export function patternTexels(size: number = FOAM.patternSize): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const u = (col + 0.5) / size;
      const v = (row + 0.5) / size;
      const coarse =
        0.55 * valueNoise(u * COARSE_CELLS, v * COARSE_CELLS, COARSE_CELLS, 5) +
        0.3 * valueNoise(u * 2 * COARSE_CELLS, v * 2 * COARSE_CELLS, 2 * COARSE_CELLS, 6) +
        0.15 * valueNoise(u * 4 * COARSE_CELLS, v * 4 * COARSE_CELLS, 4 * COARSE_CELLS, 7);
      const at = (row * size + col) * 4;
      data[at] = Math.round(255 * lace(u * LACE_CELLS, v * LACE_CELLS, LACE_CELLS));
      data[at + 1] = Math.round(255 * valueNoise(u * FINE_CELLS, v * FINE_CELLS, FINE_CELLS, 3));
      data[at + 2] = Math.round(255 * coarse);
      data[at + 3] = Math.round(255 * valueNoise(u * FINE_CELLS, v * FINE_CELLS, FINE_CELLS, 4));
    }
  }
  return data;
}

/** The pattern as a texture that repeats, with mipmaps. */
export function patternTexture(): DataTexture {
  const size = FOAM.patternSize;
  const t = new DataTexture(patternTexels(size), size, size, RGBAFormat);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.name = 'sea pattern';
  t.needsUpdate = true;
  return t;
}
