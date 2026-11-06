// SPDX-License-Identifier: AGPL-3.0-only

// The wake's waves on the CPU, in float64: the reference the GPU's field is
// checked against, and the physics' checks run on it.
//
// The wake's waves are a small square of water that follows the boat, on
// which every hull in it is a pressure, and whose waves run by deep water's
// own law. It is Tessendorf's eWave ("eWave: Using an Exponential Solver on
// the iWave Problem", 2014), as Grapeshot's Atlas drew its wakes (Mihelich
// and Tcheblokov, "Wakes, Explosions and Lighting: Interactive Water
// Simulation in Atlas", GDC 2019). The surface's height h and its velocity
// potential φ obey, for each wave vector k of the square's Fourier
// transform, linearised deep water:
//
//   ∂h/∂t = |k| φ,   ∂φ/∂t = −g h − p/ρ
//
// With the pressure under a hull ρg times its immersion d there (the
// thin-ship pressure of the Kelvin literature), u = h + d turns at deep
// water's frequency ω = √(g|k|) while the pressure holds, so a step of any
// length is exact:
//
//   u' = u cos ωΔt + (|k|/ω) φ sin ωΔt,   φ' = φ cos ωΔt − (g/ω) u sin ωΔt
//
// and h' = u' − d. A hull at rest sits in a dent of its own shape and makes
// no waves; under way, Kelvin's pattern follows (Thomson, "On ship waves",
// 1887): the V's edge at arcsin ⅓ whatever the speed, the waves across the
// track 2πU²/g long, the V narrowing above a Froude number of about a half
// (Rabaud and Moisy, "Ship wakes: Kelvin or Mach angle?", 2013; Darmon,
// Benzaquen and Raphaël, "Kelvin wake pattern at large Froude numbers",
// 2014), the curve of a turn and the waves running on after a stop, none of
// them drawn by hand.
//
// The square's solution is periodic, so its outer eighth is damped, as
// Atlas's is, and waves that reach it die there rather than come in at the
// other side. The height is kept as the surface, the potential as its
// transform: a step
//
//   1  the last step's height, moved by however many whole texels the
//      square moved (and the water drifted), damped toward the rim; u = h + d
//      under the hulls' new pressure
//   2  the transform of u
//   3  the potential moved likewise (a turn of each wave's phase), each wave
//      turned by ωΔt, and faded a little (the finest the most)
//   4  the inverse transform of u', the two slopes and the convergence of
//      the horizontal shift (|k| u, from which the surface's folding comes,
//      as the detail band's), two real fields to each complex one:
//      (1 − k_e) u' and i (k_n + |k|) u', as field.ts packs the detail band
//
// Damping the height alone at the rim takes the waves' energy there as
// surely as damping both, since each wave's energy passes between them.
//
// Index row · size + column, the column counting east and the row north.

import { Transform } from './field';
import { GRAVITY } from './spectrum';

/** A hull's shape for its pressure: stations from the transom forward, each [z aft, half-beam, depth], and its sections' exponent (hulls.ts). */
export interface PressureShape {
  stations: number[][];
  bilge: number;
}

/** A hull on the square: where its origin is, its heading clockwise from north, and how deep it sits beside its static draught, metres. */
export interface WakeHull {
  east: number;
  north: number;
  heading: number;
  /** Added to every station's depth: the hull sitting deeper than at rest (positive) or lifted. */
  sink: number;
}

/** How the square's waves are damped. */
export interface WakeDamping {
  /** Over its outer share of each half side, the square damps waves at up to rate per second. */
  rim: number;
  rimRate: number;
  /** Every wave fades at this rate per second, and the finest at this much more (by (k/k_max)⁴). */
  rate: number;
  fine: number;
}

/**
 * The immersion of a hull at a point of its own frame, on the water's plane
 * (x to starboard, z aft): the depth of its bottom there below its
 * waterline, from the stations, its sections narrowing as a superellipse.
 * Softened at the ends by a fraction of a station's spacing so that a
 * square of finite texels reads it without a step.
 */
export function immersion(shape: PressureShape, x: number, z: number, sink = 0): number {
  const s = shape.stations;
  const n = s.length;
  const aft = s[0]?.[0] ?? 0;
  const fore = s[n - 1]?.[0] ?? 0;
  if (!(z < aft && z > fore)) {
    return 0;
  }
  const t = ((aft - z) / (aft - fore)) * (n - 1);
  const i = Math.min(Math.floor(t), n - 2);
  const f = t - i;
  const a = s[i] as number[];
  const b = s[i + 1] as number[];
  const beam = (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * f;
  const depth = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f + sink;
  if (!(beam > 0) || !(depth > 0)) {
    return 0;
  }
  const across = Math.abs(x) / beam;
  if (across >= 1) {
    return 0;
  }
  // The transom's step taken over the last tenth of the waterline.
  const end = Math.min(t / (0.1 * (n - 1)), 1);
  const ease = end * end * (3 - 2 * end);
  return depth * (1 - across ** shape.bilge) ** (1 / shape.bilge) * ease;
}

/** The share of a step's waves the square keeps at a texel, by how near its rim it is. */
export function rimKept(
  col: number,
  row: number,
  size: number,
  damping: WakeDamping,
  dt: number,
): number {
  const half = size / 2;
  const x = Math.abs(col + 0.5 - half) / half;
  const y = Math.abs(row + 0.5 - half) / half;
  const from = 1 - damping.rim;
  const r = Math.max((Math.max(x, y) - from) / damping.rim, 0);
  return Math.exp(-dt * damping.rimRate * r * r);
}

/** A texel's pressure is the mean of its immersion at this many points a side. */
export const SAMPLES = 4;

/** The wake's waves over a square of size texels, span metres a side, in float64. */
export class WakeWavesReference {
  readonly size: number;
  readonly span: number;
  readonly texel: number;
  /** The square's centre in the world, on its texels' grid. */
  readonly centre = { east: 0, north: 0 };
  /** The surface's height, m: the state, with the potential's transform. */
  readonly h: Float64Array;
  /** The transform of the velocity potential, m²/s, real and imaginary. */
  readonly phiRe: Float64Array;
  readonly phiIm: Float64Array;
  /** What the last step made beside: the slopes east and north, and the convergence of the horizontal shift. */
  readonly east: Float64Array;
  readonly north: Float64Array;
  readonly convergence: Float64Array;
  /** The hulls' immersion at the last step, metres. */
  readonly pressure: Float64Array;
  damping: WakeDamping;

  readonly #transform: Transform;
  readonly #ar: Float64Array;
  readonly #ai: Float64Array;
  readonly #br: Float64Array;
  readonly #bi: Float64Array;
  #placed = false;

  constructor(size: number, span: number, damping: WakeDamping) {
    this.size = size;
    this.span = span;
    this.texel = span / size;
    this.damping = damping;
    const n = size * size;
    this.h = new Float64Array(n);
    this.phiRe = new Float64Array(n);
    this.phiIm = new Float64Array(n);
    this.east = new Float64Array(n);
    this.north = new Float64Array(n);
    this.convergence = new Float64Array(n);
    this.pressure = new Float64Array(n);
    this.#transform = new Transform(size);
    this.#ar = new Float64Array(n);
    this.#ai = new Float64Array(n);
    this.#br = new Float64Array(n);
    this.#bi = new Float64Array(n);
  }

  /** A texel's centre in the world. */
  at(col: number, row: number): { east: number; north: number } {
    const half = this.size / 2;
    return {
      east: this.centre.east + (col + 0.5 - half) * this.texel,
      north: this.centre.north + (row + 0.5 - half) * this.texel,
    };
  }

  /** Whether a step has been taken since the field was made or cleared. */
  get placed(): boolean {
    return this.#placed;
  }

  /** The hulls' immersion over the square about the centre (east, north), into pressure. */
  press(
    shape: PressureShape,
    hulls: readonly WakeHull[],
    east: number,
    north: number,
    count = hulls.length,
  ): void {
    const n = this.size;
    const p = this.pressure;
    p.fill(0);
    let reach = 0;
    for (const s of shape.stations) {
      reach = Math.max(reach, Math.hypot(s[0] ?? 0, s[1] ?? 0));
    }
    const half = n / 2;
    const texel = this.texel;
    for (let h = 0; h < count; h++) {
      const hull = hulls[h] as WakeHull;
      const s = Math.sin(hull.heading);
      const c = Math.cos(hull.heading);
      const c0 = Math.max(Math.floor((hull.east - reach - east) / texel + half), 0);
      const c1 = Math.min(Math.ceil((hull.east + reach - east) / texel + half), n);
      const r0 = Math.max(Math.floor((hull.north - reach - north) / texel + half), 0);
      const r1 = Math.min(Math.ceil((hull.north + reach - north) / texel + half), n);
      for (let row = r0; row < r1; row++) {
        for (let col = c0; col < c1; col++) {
          // The mean over the texel, so that a hull moving less than a
          // texel moves its pressure as smoothly: SAMPLES² points.
          let sum = 0;
          for (let a = 0; a < SAMPLES; a++) {
            const dn = north + (row + (a + 0.5) / SAMPLES - half) * texel - hull.north;
            for (let b = 0; b < SAMPLES; b++) {
              const de = east + (col + (b + 0.5) / SAMPLES - half) * texel - hull.east;
              // Into the hull's frame: x to starboard, z aft.
              const x = de * c - dn * s;
              const z = -(de * s + dn * c);
              sum += immersion(shape, x, z, hull.sink);
            }
          }
          p[row * n + col] = (p[row * n + col] as number) + sum / (SAMPLES * SAMPLES);
        }
      }
    }
  }

  /** Forgets every wave: the next step starts from still water, the hulls already floating. */
  clear(): void {
    this.#placed = false;
  }

  /**
   * A step of dt seconds, the square's centre now at (east, north) on its
   * texels' grid, with the pressure press last laid there. drift is how
   * many whole texels the water moved east and north since the last step,
   * which the waves move with.
   */
  step(dt: number, east: number, north: number, driftEast = 0, driftNorth = 0): void {
    const n = this.size;
    const texel = this.texel;
    const h = this.h;
    const d = this.pressure;
    const ar = this.#ar;
    const ai = this.#ai;
    const br = this.#br;
    const bi = this.#bi;
    const pr = this.phiRe;
    const pim = this.phiIm;
    if (!this.#placed) {
      // The hulls float in their dents from the first.
      for (let i = 0; i < n * n; i++) {
        h[i] = -(d[i] as number);
        pr[i] = 0;
        pim[i] = 0;
      }
      this.#placed = true;
      this.centre.east = east;
      this.centre.north = north;
    }
    const dx = Math.round((east - this.centre.east) / texel) - driftEast;
    const dy = Math.round((north - this.centre.north) / texel) - driftNorth;
    this.centre.east = east;
    this.centre.north = north;
    // 1: moved, damped at the rim, under the new pressure.
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const sc = col + dx;
        const sr = row + dy;
        const inside = sc >= 0 && sc < n && sr >= 0 && sr < n;
        const i = row * n + col;
        const kept = rimKept(col, row, n, this.damping, dt);
        ar[i] = (inside ? (h[sr * n + sc] as number) * kept : 0) + (d[i] as number);
        ai[i] = 0;
      }
    }
    // 2: the forward transform, as the inverse of the conjugate (the input is real).
    this.#transform.square(ar, ai);
    // 3: the potential moved, each wave turned, and the outputs:
    // A = (1 − k_e) u', B = i (k_n + |k|) u'.
    const dk = (2 * Math.PI) / this.span;
    const most = Math.PI / texel;
    const dm = this.damping;
    const scale = 1 / (n * n);
    for (let row = 0; row < n; row++) {
      const wn = row < n / 2 ? row : row - n;
      const kn = wn * dk;
      for (let col = 0; col < n; col++) {
        const we = col < n / 2 ? col : col - n;
        const ke = we * dk;
        const i = row * n + col;
        const k = Math.hypot(ke, kn);
        let ur = ar[i] as number;
        let ui = -(ai[i] as number);
        // y_j = x_(j+s) has the transform X(m) e^(2πi s·m/n).
        const turn = (2 * Math.PI * (dx * we + dy * wn)) / n;
        const tc = Math.cos(turn);
        const ts = Math.sin(turn);
        let fr = (pr[i] as number) * tc - (pim[i] as number) * ts;
        let fi = (pr[i] as number) * ts + (pim[i] as number) * tc;
        if (row === n / 2 || col === n / 2) {
          // The shortest waves, which have no partner of the opposite sign
          // to keep their slopes real, are left out: two texels long, finer
          // than the field can carry.
          ur = 0;
          ui = 0;
          fr = 0;
          fi = 0;
        } else if (k > 0) {
          const omega = Math.sqrt(GRAVITY * k);
          const c = Math.cos(omega * dt);
          const s = Math.sin(omega * dt);
          const fade = Math.exp(-dt * (dm.rate + dm.fine * (k / most) ** 4));
          const nur = (ur * c + (k / omega) * fr * s) * fade;
          const nui = (ui * c + (k / omega) * fi * s) * fade;
          const nfr = (fr * c - (GRAVITY / omega) * ur * s) * fade;
          const nfi = (fi * c - (GRAVITY / omega) * ui * s) * fade;
          ur = nur;
          ui = nui;
          fr = nfr;
          fi = nfi;
        } else {
          // The mean level stays; its potential is nothing anything reads.
          fr = 0;
          fi = 0;
        }
        pr[i] = fr;
        pim[i] = fi;
        ur *= scale;
        ui *= scale;
        const a = 1 - ke;
        const b = kn + k;
        ar[i] = a * ur;
        ai[i] = a * ui;
        br[i] = -b * ui;
        bi[i] = b * ur;
      }
    }
    // 4: back.
    this.#transform.square(ar, ai);
    this.#transform.square(br, bi);
    for (let i = 0; i < n * n; i++) {
      h[i] = (ar[i] as number) - (d[i] as number);
      this.east[i] = ai[i] as number;
      this.north[i] = br[i] as number;
      this.convergence[i] = bi[i] as number;
    }
  }
}
