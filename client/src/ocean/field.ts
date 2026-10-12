// SPDX-License-Identifier: AGPL-3.0-only

// The detail band's fields on the CPU, in float64: the reference the GPU's
// transform is checked against, and what the low tier's loop is made from.
//
// With each wave a cos(k·x − ωt + φ), the surface is the inverse Fourier
// transform of H(k) = ½ (c(k) e^(−iωt) + c̄(−k) e^(iωt)), c = a e^(iφ), which
// is real because H(−k) is H(k)'s conjugate. Three more real fields have
// spectra that are H times something: the slope eastward, i k_e H; the slope
// northward, i k_n H; and the convergence of the horizontal shift that
// sharpens crests, |k| H (Tessendorf, "Simulating Ocean Water", 2001: the
// shift is D = Σ −i k/|k| H e^(ik·x), and its divergence Σ |k| H e^(ik·x),
// greatest on the crests the shift draws the water toward). Two real fields
// make one complex one, so two transforms give all four:
//
//   A = H + i (i k_e H) = (1 − k_e) H        →  height + i · slope east
//   B = i k_n H + i (|k| H) = i (k_n + |k|) H  →  slope north + i · convergence
//
// The transform is the radix-2 one of Cooley and Tukey (1965), rows then
// columns.

import type { WeatherSea } from '../catalog/types.gen';
import { amplitudes, type Modes, modesOf, type Patch, type SpectrumInputs } from './spectrum';

const TWO_PI = 2 * Math.PI;

/** The four fields over a patch: index row · size + column, the column counting east and the row north. */
export interface Fields {
  size: number;
  /** In metres. */
  height: Float64Array;
  /** The rise per metre eastward and northward. */
  east: Float64Array;
  north: Float64Array;
  /** The convergence of the horizontal shift, per unit of chop: 1/m × m. */
  convergence: Float64Array;
}

export function newFields(size: number): Fields {
  return {
    size,
    height: new Float64Array(size * size),
    east: new Float64Array(size * size),
    north: new Float64Array(size * size),
    convergence: new Float64Array(size * size),
  };
}

/** The inverse transform of a power-of-two length, in place and unscaled: out[j] = Σ in[n] e^(2πi jn/N). */
export class Transform {
  readonly size: number;
  readonly #reversed: Uint16Array;
  readonly #cos: Float64Array;
  readonly #sin: Float64Array;
  readonly #re: Float64Array;
  readonly #im: Float64Array;

  constructor(size: number) {
    const bits = Math.log2(size);
    if (!Number.isInteger(bits) || size < 2) {
      throw new Error(`a transform's length must be a power of two, not ${size}`);
    }
    this.size = size;
    this.#reversed = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r |= ((i >> b) & 1) << (bits - 1 - b);
      }
      this.#reversed[i] = r;
    }
    this.#cos = new Float64Array(size / 2);
    this.#sin = new Float64Array(size / 2);
    for (let j = 0; j < size / 2; j++) {
      this.#cos[j] = Math.cos((TWO_PI * j) / size);
      this.#sin[j] = Math.sin((TWO_PI * j) / size);
    }
    this.#re = new Float64Array(size);
    this.#im = new Float64Array(size);
  }

  /** Transforms the size values at offset, offset + stride, … of re and im. */
  line(re: Float64Array, im: Float64Array, offset: number, stride: number): void {
    const n = this.size;
    const tr = this.#re;
    const ti = this.#im;
    for (let i = 0; i < n; i++) {
      const k = offset + (this.#reversed[i] as number) * stride;
      tr[i] = re[k] as number;
      ti[i] = im[k] as number;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let s = 0; s < n; s += size) {
        for (let q = 0; q < half; q++) {
          const c = this.#cos[q * step] as number;
          const sn = this.#sin[q * step] as number;
          const a = s + q;
          const b = a + half;
          const xr = (tr[b] as number) * c - (ti[b] as number) * sn;
          const xi = (tr[b] as number) * sn + (ti[b] as number) * c;
          tr[b] = (tr[a] as number) - xr;
          ti[b] = (ti[a] as number) - xi;
          tr[a] = (tr[a] as number) + xr;
          ti[a] = (ti[a] as number) + xi;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      re[offset + i * stride] = tr[i] as number;
      im[offset + i * stride] = ti[i] as number;
    }
  }

  /** Transforms a square of size × size values: its rows, then its columns. */
  square(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let row = 0; row < n; row++) {
      this.line(re, im, row * n, 1);
    }
    for (let col = 0; col < n; col++) {
      this.line(re, im, col, n);
    }
  }
}

/** The time within a patch's loop, as a fraction of it, for world time in seconds. */
export function loopFraction(time: number, period: number): number {
  const t = time % period;
  return (t < 0 ? t + period : t) / period;
}

/** Makes a patch's fields at a time, under a wind. */
export class FieldMaker {
  readonly modes: Modes;
  /** Each wave's amplitude under the wind last set, in metres. */
  readonly amplitude: Float64Array;
  readonly #transform: Transform;
  /** H at the time asked for. */
  readonly #hr: Float64Array;
  readonly #hi: Float64Array;

  constructor(patch: Patch) {
    this.modes = modesOf(patch);
    const n = patch.size * patch.size;
    this.amplitude = new Float64Array(n);
    this.#transform = new Transform(patch.size);
    this.#hr = new Float64Array(n);
    this.#hi = new Float64Array(n);
  }

  /** The sea to make fields of. */
  set(sea: WeatherSea, inputs: SpectrumInputs): void {
    amplitudes(sea, this.modes, inputs, this.amplitude);
  }

  /** H(k) at a time, in seconds, into the maker's own arrays. */
  #spectrum(time: number): void {
    const m = this.modes;
    const u = loopFraction(time, m.patch.period);
    const amp = this.amplitude;
    for (let i = 0; i < amp.length; i++) {
      const o = m.opposite[i] as number;
      const a = amp[i] as number;
      const b = amp[o] as number;
      if (a === 0 && b === 0) {
        this.#hr[i] = 0;
        this.#hi[i] = 0;
        continue;
      }
      // The wave's turns since the loop began: a whole number of steps times
      // the loop's fraction, of which only the fraction matters.
      const turned = (m.step[i] as number) * u;
      const here = TWO_PI * ((m.phase[i] as number) - turned);
      const there = TWO_PI * ((m.phase[o] as number) - turned);
      this.#hr[i] = 0.5 * (a * Math.cos(here) + b * Math.cos(there));
      this.#hi[i] = 0.5 * (a * Math.sin(here) - b * Math.sin(there));
    }
  }

  /** The four fields at a time, in seconds. */
  at(time: number, out: Fields): Fields {
    const m = this.modes;
    this.#spectrum(time);
    const hr = this.#hr;
    const hi = this.#hi;
    // A into (height, east), B into (north, convergence): the transforms'
    // real and imaginary parts are the fields.
    for (let i = 0; i < hr.length; i++) {
      const r = hr[i] as number;
      const im = hi[i] as number;
      const a = 1 - (m.east[i] as number);
      const b = (m.north[i] as number) + (m.k[i] as number);
      out.height[i] = a * r;
      out.east[i] = a * im;
      out.north[i] = -b * im;
      out.convergence[i] = b * r;
    }
    this.#transform.square(out.height, out.east);
    this.#transform.square(out.north, out.convergence);
    return out;
  }

  /**
   * The four fields at a point x metres east and y north of the patch's
   * first texel, at a time, by summing the waves one by one: height, slope
   * east, slope north, convergence. For checking the transform.
   */
  sumAt(x: number, y: number, time: number): [number, number, number, number] {
    const m = this.modes;
    const u = loopFraction(time, m.patch.period);
    let h = 0;
    let e = 0;
    let n = 0;
    let c = 0;
    for (let i = 0; i < this.amplitude.length; i++) {
      const a = this.amplitude[i] as number;
      if (a === 0) {
        continue;
      }
      const kx = m.east[i] as number;
      const ky = m.north[i] as number;
      const arg = kx * x + ky * y + TWO_PI * ((m.phase[i] as number) - (m.step[i] as number) * u);
      const cos = a * Math.cos(arg);
      const sin = a * Math.sin(arg);
      h += cos;
      e -= kx * sin;
      n -= ky * sin;
      c += (m.k[i] as number) * cos;
    }
    return [h, e, n, c];
  }
}

/** A patch's fields at a time, as one call. */
export function fieldsAt(
  sea: WeatherSea,
  patch: Patch,
  inputs: SpectrumInputs,
  time: number,
  out: Fields,
): Fields {
  const maker = new FieldMaker(patch);
  maker.set(sea, inputs);
  return maker.at(time, out);
}

/** The root mean square of a field. */
export function rms(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += (v[i] as number) * (v[i] as number);
  }
  return Math.sqrt(sum / v.length);
}

/** How much of a fold shows as foam: nothing at the threshold, all of it a third below. */
export function foldFoam(threshold: number, chop: number, convergence: number): number {
  // The Jacobian of the shifted surface, to first order: 1 − chop × convergence.
  return Math.min(Math.max((threshold - (1 - chop * convergence)) * 3, 0), 1);
}

/** A texel holds a height within this many standard deviations, and a slope within this many of the slope's. */
export const HEIGHT_RANGE = 4;
export const SLOPE_RANGE = 4;

/** A value within ±range as a byte, 128 for nothing. */
export function toByte(v: number, range: number): number {
  return Math.min(Math.max(Math.round(128 + (127 * v) / range), 1), 255);
}

/** A byte as toByte wrote it, back to a value within ±range. */
export function fromByte(b: number, range: number): number {
  return ((b - 128) / 127) * range;
}

/**
 * A loop of the detail band for one wind, as texels: the fields at evenly
 * spaced times over the patch's period, which every wave in it divides. The
 * waves travel east; whoever draws it turns it to the wind.
 */
export interface Loop {
  /** Texels a side, of the loop and of its average for a tile as a whole. */
  size: number;
  coarse: number;
  frames: number;
  /**
   * Frame after frame, RGBA: the slope eastward and northward, the foam,
   * the height. The slopes are within ±slopeRange and the height within
   * ±HEIGHT_RANGE standard deviations.
   */
  texels: Uint8Array;
  coarseTexels: Uint8Array;
  slopeRange: number;
  /** The height's standard deviation, in metres. */
  sigma: number;
}

/** Makes a loop a few frames at a time, so the frame that is drawing meanwhile is not held up. */
export class LoopBaker {
  readonly loop: Loop;
  /** Frames made, of those to make: with folding foam the loop is run once more first, for the foam it starts with. */
  made = 0;
  readonly total: number;
  /** Milliseconds spent making it. */
  spent = 0;

  readonly #maker: FieldMaker;
  readonly #fields: Fields;
  readonly #foam: Float64Array;
  readonly #next: Float64Array;
  readonly #threshold: number;
  readonly #chop: number;
  readonly #decay: number;
  readonly #spread: number;
  readonly #warm: number;

  /**
   * foam is what the foam does at the loop's wind: where the surface folds,
   * how long the foam lasts; spread is how fast it disperses, m²/s. steepen
   * scales the convergence before the fold is judged: a loop that leaves the
   * shortest waves out is less steep than the band it stands for, and would
   * hardly fold.
   */
  constructor(
    sea: WeatherSea,
    patch: Patch,
    inputs: SpectrumInputs,
    frames: number,
    coarse: number,
    foam: { folding: number; threshold: number; chop: number; decay: number },
    spread: number,
    steepen = 1,
  ) {
    const n = patch.size;
    this.#maker = new FieldMaker(patch);
    this.#maker.set(sea, inputs);
    this.#fields = newFields(n);
    this.#foam = new Float64Array(n * n);
    this.#next = new Float64Array(n * n);
    this.#threshold = foam.threshold;
    this.#chop = foam.chop * steepen;
    const dt = patch.period / frames;
    this.#decay = Math.exp(-dt / foam.decay);
    const cell = patch.length / n;
    this.#spread = Math.min((spread * dt) / (cell * cell), 0.2);
    this.#warm = foam.folding > 0 ? frames : 0;
    this.total = this.#warm + frames;
    this.loop = {
      size: n,
      coarse,
      frames,
      texels: new Uint8Array(frames * n * n * 4),
      coarseTexels: new Uint8Array(frames * coarse * coarse * 4),
      // Down the wind the slope is nearly the whole of it.
      slopeRange: SLOPE_RANGE * Math.sqrt(Math.max(inputs.slope, 1e-12)),
      sigma: Math.sqrt(Math.max(inputs.variance, 1e-12)),
    };
  }

  get done(): boolean {
    return this.made >= this.total;
  }

  /** Makes frames until budget milliseconds have gone, and at least one. Returns whether the loop is whole. */
  work(budget: number, now: () => number = () => performance.now()): boolean {
    const start = now();
    while (!this.done) {
      this.frame();
      if (now() - start >= budget) {
        break;
      }
    }
    this.spent += now() - start;
    return this.done;
  }

  /** Makes the next frame. */
  frame(): void {
    const { size, frames } = this.loop;
    const at = this.made % frames;
    const period = this.#maker.modes.patch.period;
    const f = this.#maker.at((at * period) / frames, this.#fields);
    if (this.#warm > 0) {
      this.#fold(f.convergence);
    }
    if (this.made >= this.#warm) {
      this.#write(at, size);
    }
    this.made++;
  }

  /** The foam after one more frame: what folds now, or what was there, spread a little and faded. */
  #fold(convergence: Float64Array): void {
    const n = this.loop.size;
    const mask = n - 1;
    const prev = this.#foam;
    const next = this.#next;
    const w = this.#spread;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const i = row * n + col;
        const around =
          (prev[row * n + ((col + 1) & mask)] as number) +
          (prev[row * n + ((col - 1) & mask)] as number) +
          (prev[((row + 1) & mask) * n + col] as number) +
          (prev[((row - 1) & mask) * n + col] as number);
        const kept = ((prev[i] as number) * (1 - 4 * w) + around * w) * this.#decay;
        next[i] = Math.max(foldFoam(this.#threshold, this.#chop, convergence[i] as number), kept);
      }
    }
    prev.set(next);
  }

  #write(frame: number, n: number): void {
    const f = this.#fields;
    const { texels, coarseTexels, coarse, slopeRange, sigma } = this.loop;
    const height = HEIGHT_RANGE * sigma;
    const base = frame * n * n * 4;
    for (let i = 0; i < n * n; i++) {
      texels[base + i * 4] = toByte(f.east[i] as number, slopeRange);
      texels[base + i * 4 + 1] = toByte(f.north[i] as number, slopeRange);
      texels[base + i * 4 + 2] = Math.round(255 * (this.#foam[i] as number));
      texels[base + i * 4 + 3] = toByte(f.height[i] as number, height);
    }
    // The tile as a whole reads the loop averaged over squares of texels.
    const block = n / coarse;
    const cbase = frame * coarse * coarse * 4;
    for (let row = 0; row < coarse; row++) {
      for (let col = 0; col < coarse; col++) {
        let e = 0;
        let no = 0;
        let fo = 0;
        let h = 0;
        for (let y = 0; y < block; y++) {
          for (let x = 0; x < block; x++) {
            const i = (row * block + y) * n + col * block + x;
            e += f.east[i] as number;
            no += f.north[i] as number;
            fo += this.#foam[i] as number;
            h += f.height[i] as number;
          }
        }
        const k = 1 / (block * block);
        const at = cbase + (row * coarse + col) * 4;
        coarseTexels[at] = toByte(e * k, slopeRange);
        coarseTexels[at + 1] = toByte(no * k, slopeRange);
        coarseTexels[at + 2] = Math.round(255 * fo * k);
        coarseTexels[at + 3] = toByte(h * k, height);
      }
    }
  }
}
