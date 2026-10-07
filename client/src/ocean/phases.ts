// SPDX-License-Identifier: AGPL-3.0-only

// The boat band's components, and their phases at the floating origin.
//
// The boat band is a sum of 64 waves, each a direction, a wavenumber k and an
// amplitude a: its height at a point p of the world is
//   h(p) = Σ a sin(φ + k d·p − ωt),  ω = √(gk) (deep water).
// At the rim and after days of world time, k d·p and ωt reach millions of
// radians, which float32 cannot hold to a useful fraction of a wave. So the
// phase at the floating origin O, φ + k d·O − ωt, is computed here in float64
// each frame and reduced modulo 2π, and the GPU adds only k d·(p − O), which
// stays small. (Tessendorf, "Simulating Ocean Water", 2001, for the sum.)

import { Vector4 } from 'three';

/** Components in the boat band. */
export const COMPONENTS = 64;
/** Gravity, as the physics package has it, in m/s². */
export const GRAVITY = 9.81;

/** One wave of the boat band, in world terms. */
export interface SeaComponent {
  /** Direction the wave travels toward: east and north parts of a unit vector. */
  east: number;
  north: number;
  /** Wavenumber, in rad/m. */
  k: number;
  /** Amplitude, in metres. */
  a: number;
  /** Phase at the disk's centre at world time 0, in radians. */
  phase: number;
}

export interface TestSea {
  name: string;
  windKnots: number;
  fetchNM: number;
  /** Direction the wind blows from, clockwise from north, in degrees. */
  windFrom: number;
  components: SeaComponent[];
}

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
 * The boat band as the GPU reads it: for each component, its direction in
 * the scene (x east, z south), k and a; and its phase at the floating
 * origin, four to a vector. Calm sets every amplitude to zero.
 */
export class BoatBand {
  /** (dx, dz, k, a) of each component, in the scene's axes. */
  readonly waves: Vector4[] = Array.from({ length: COMPONENTS }, () => new Vector4());
  /** Phases at the origin, four components to each vector. */
  readonly phases: Vector4[] = Array.from({ length: COMPONENTS / 4 }, () => new Vector4());
  /** The phases at the origin, in float64, for the CPU's own sums. */
  readonly phase64 = new Float64Array(COMPONENTS);

  #sea: TestSea | null = null;
  readonly #omega = new Float64Array(COMPONENTS);
  readonly #wt = new Float64Array(2);

  get sea(): TestSea | null {
    return this.#sea;
  }

  /** Sets the components, or calm with null. */
  set(sea: TestSea | null): void {
    this.#sea = sea;
    for (let i = 0; i < COMPONENTS; i++) {
      const c = sea?.components[i];
      const w = this.waves[i] as Vector4;
      if (c === undefined) {
        w.set(1, 0, 1, 0);
        this.#omega[i] = 0;
        continue;
      }
      w.set(c.east, -c.north, c.k, c.a);
      this.#omega[i] = Math.sqrt(GRAVITY * c.k);
    }
  }

  /**
   * Computes every phase at the world point (east, north) at world time t,
   * in seconds. ωt, the largest term (a million radians after a week), is
   * taken exactly and reduced apart from the rest.
   */
  update(east: number, north: number, t: number): void {
    const comps = this.#sea?.components;
    const wt = this.#wt;
    for (let i = 0; i < COMPONENTS; i++) {
      const c = comps?.[i];
      let p = 0;
      if (c !== undefined) {
        twoProduct(this.#omega[i] ?? 0, t, wt);
        const space = reducePhase(c.phase + c.k * (c.east * east + c.north * north));
        p = reducePhase(space - reducePhase(wt[0] ?? 0) - (wt[1] ?? 0));
      }
      this.phase64[i] = p;
      const v = this.phases[i >> 2] as Vector4;
      v.setComponent(i & 3, p);
    }
  }

  /**
   * The band's height and slope at the scene point (x, z) relative to the
   * origin of the last update, in float64: [h, ∂h/∂x, ∂h/∂z]. The reference
   * the GPU's pass is tested against.
   */
  sample(x: number, z: number, out: Float64Array): Float64Array {
    let h = 0;
    let gx = 0;
    let gz = 0;
    for (let i = 0; i < COMPONENTS; i++) {
      const w = this.waves[i] as Vector4;
      const a = (this.phase64[i] ?? 0) + w.z * (w.x * x + w.y * z);
      const ak = w.w * w.z * Math.cos(a);
      h += w.w * Math.sin(a);
      gx += ak * w.x;
      gz += ak * w.y;
    }
    out[0] = h;
    out[1] = gx;
    out[2] = gz;
    return out;
  }
}
