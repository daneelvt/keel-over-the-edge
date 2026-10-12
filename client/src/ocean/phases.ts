// SPDX-License-Identifier: AGPL-3.0-only

// The boat band as it is drawn: the waves long enough to move a boat, which
// the physics module holds (the server's own code, so the boat rides exactly
// the sea the tiles show). The band is a sum of waves with fixed directions
// and wavenumbers,
//   h(p) = Σ a sin(φ + k d·p − ωt),
// whose amplitudes a come from the wind of each sea area and are blended
// between the four areas about a point. Here the module's waves and the
// amplitudes of the window of areas about the boat are laid out for the GPU,
// and each wave's phase at the floating origin is computed.
//
// At the rim and after years of world time, k d·p and ωt reach hundreds of
// millions of radians, which float32 cannot hold to a useful fraction of a
// wave. So the phase at the floating origin O, φ + k d·O − ωt, is computed
// here in float64 each frame and reduced modulo 2π, and the GPU adds only
// k d·(p − O) (wave.ts). (Tessendorf, "Simulating Ocean Water", 2001, for the
// sum.)

import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2, Vector4 } from 'three';
import { RECORDS, SEA } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';

/** The most waves the band draws: all the sea's. */
export const COMPONENTS = SEA.components;
/** The waves are summed four at a time. */
export const GROUPS = COMPONENTS / 4;
/** The most sea areas in the window drawn. */
export const AREAS = SEA.window * SEA.window;

// 2π in three parts (Cody and Waite, "Software Manual for the Elementary
// Functions", 1980): the first two have 29 significant bits, so n times
// either is exact for any n below 2²⁴, about a hundred million radians.
const TWO_PI_1 = 6.283185303211212;
const TWO_PI_2 = 3.968374309715195e-9;
const TWO_PI_3 = 9.00696709662487e-18;
const TWO_PI = 2 * Math.PI;
const INV_TWO_PI = 1 / TWO_PI;

/** x reduced to [0, 2π). Accurate to about 10⁻¹⁵ rad for |x| up to 10⁸. */
export function reducePhase(x: number): number {
  const n = Math.floor(x * INV_TWO_PI);
  let r = x - n * TWO_PI_1 - n * TWO_PI_2 - n * TWO_PI_3;
  // The rounding of n can leave r just outside the range.
  if (r < 0) {
    r += TWO_PI;
  }
  if (r >= TWO_PI) {
    r -= TWO_PI;
  }
  return r < TWO_PI ? r : 0;
}

/** a·b as an unevaluated sum hi + lo, exactly (Dekker, 1971). */
function twoProduct(a: number, b: number, out: Float64Array): void {
  const p = a * b;
  const sa = 134217729 * a; // 2²⁷ + 1
  const ah = sa - (sa - a);
  const al = a - ah;
  const sb = 134217729 * b;
  const bh = sb - (sb - b);
  const bl = b - bh;
  out[0] = p;
  out[1] = ah * bh - p + ah * bl + al * bh + al * bl;
}

/**
 * The phase of a wave at a world point and a tick: φ + k d·O less the turns
 * it has made, reduced to [0, 2π). ωt, the largest term (hundreds of
 * millions of radians), is taken exactly, as turns, and only its fraction
 * kept, as the physics module takes it.
 */
export function phaseAt(
  phase0: number,
  kEast: number,
  kNorth: number,
  turns: number,
  east: number,
  north: number,
  tick: number,
  scratch: Float64Array,
): number {
  twoProduct(turns, tick, scratch);
  const hi = scratch[0] ?? 0;
  const turned = (hi - Math.floor(hi) + (scratch[1] ?? 0)) * TWO_PI;
  return reducePhase(reducePhase(phase0 + kEast * east + kNorth * north) - turned);
}

function floatTexture(width: number, height: number): DataTexture {
  const t = new DataTexture(
    new Float32Array(width * height * 4),
    width,
    height,
    RGBAFormat,
    FloatType,
  );
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * The boat band as the GPU reads it. Only the waves with an amplitude
 * somewhere in the window are drawn; they are numbered 0 … count − 1 here,
 * in the module's order.
 */
export class SeaBand {
  /**
   * For each wave drawn, at its number along the row: its direction in the
   * scene (x east, z south), its wavenumber, and its amplitude in the
   * window's first area, which is every area's when the window is one sea.
   */
  readonly waves = floatTexture(COMPONENTS, 1);
  /** For each area (a row) and wave drawn (along it), the wave's amplitude there, in red. */
  readonly amplitudes = floatTexture(COMPONENTS, AREAS);
  /** Phases at the origin, in [0, 2π), four waves to each vector. */
  readonly phases: Vector4[] = Array.from({ length: GROUPS }, () => new Vector4());
  /** The significant height of each area's waves, in metres. */
  readonly hs: number[] = new Array(AREAS).fill(0);
  /** Waves drawn, and the fours of them the GPU sums. */
  count = 0;
  groups = 0;
  /** Areas a side of the window. */
  size: number = SEA.window;
  /** Whether the window's areas differ, so that amplitudes must be blended between them. */
  blended = false;
  /** The floating origin in the window's own coordinates: areas east and north of its first area's centre. */
  readonly areaOrigin = new Vector2();

  /** The sea's waves, from the module, by their number here: turns a tick, phase at the centre at tick 0, and k d east and north. */
  readonly #turns = new Float64Array(COMPONENTS);
  readonly #phase0 = new Float64Array(COMPONENTS);
  readonly #kEast = new Float64Array(COMPONENTS);
  readonly #kNorth = new Float64Array(COMPONENTS);
  #col = 0;
  #row = 0;
  readonly #scratch = new Float64Array(2);

  /** No waves: flat water. */
  clear(): void {
    this.count = 0;
    this.groups = 0;
    this.blended = false;
    this.hs.fill(0);
  }

  /**
   * Lays out one of the module's windows of the sea: the waves with an
   * amplitude in it, and their amplitudes in each of its areas. The window's
   * first area is at column col and row row and it has size areas a side.
   */
  set(physics: Physics, slot: number, col: number, row: number, size: number): void {
    const c = physics.records.components;
    const R = RECORDS.components;
    const active = physics.seaActive(slot);
    const amp = physics.seaAmplitudes(slot);
    const hs = physics.seaHs(slot);
    const areas = size * size;
    this.count = active.length;
    this.groups = Math.ceil(active.length / 4);
    this.size = size;
    this.#col = col;
    this.#row = row;
    const waves = this.waves.image.data as Float32Array;
    const amps = this.amplitudes.image.data as Float32Array;
    amps.fill(0);
    let blended = false;
    for (let j = 0; j < this.groups * 4; j++) {
      const i = active[j];
      if (i === undefined) {
        // The last four's spare places: waves of no height.
        waves.set([1, 0, 0, 0], j * 4);
        continue;
      }
      const k = c[R.k + i] ?? 0;
      const east = c[R.east + i] ?? 0;
      const north = c[R.north + i] ?? 0;
      this.#turns[j] = c[R.turns + i] ?? 0;
      this.#phase0[j] = c[R.phase + i] ?? 0;
      this.#kEast[j] = k * east;
      this.#kNorth[j] = k * north;
      const first = amp[i] ?? 0;
      waves.set([east, -north, k, first], j * 4);
      for (let a = 0; a < areas; a++) {
        const v = amp[a * COMPONENTS + i] ?? 0;
        amps[(a * COMPONENTS + j) * 4] = v;
        blended = blended || v !== first;
      }
    }
    this.blended = blended;
    for (let a = 0; a < AREAS; a++) {
      this.hs[a] = a < areas ? (hs[a] ?? 0) : 0;
    }
    this.waves.needsUpdate = true;
    this.amplitudes.needsUpdate = true;
  }

  /**
   * Computes every phase at the world point (east, north) at world time
   * tick, in ticks, which need not be whole, and where that point is among
   * the window's areas.
   */
  update(east: number, north: number, tick: number): void {
    const half = SEA.areas >> 1;
    this.areaOrigin.set(
      east / SEA.areaSize + half - this.#col,
      north / SEA.areaSize + half - this.#row,
    );
    for (let j = 0; j < this.groups * 4; j++) {
      const phase =
        j < this.count
          ? phaseAt(
              this.#phase0[j] ?? 0,
              this.#kEast[j] ?? 0,
              this.#kNorth[j] ?? 0,
              this.#turns[j] ?? 0,
              east,
              north,
              tick,
              this.#scratch,
            )
          : 0;
      (this.phases[j >> 2] as Vector4).setComponent(j & 3, phase);
    }
  }
}
