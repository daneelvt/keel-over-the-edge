// SPDX-License-Identifier: AGPL-3.0-only

// The detail band's spectrum: the sea's own JONSWAP spectrum (Hasselmann
// and others 1973), with the boat band's spreading about the wind, for the
// waves shorter than the boat band's shortest. The two bands are one sea,
// cut at that wavelength.
//
// The band is drawn as Tessendorf's sea ("Simulating Ocean Water", 2001):
// a square patch of side L that repeats, holding the waves whose wave
// vectors are k = (2π/L)(n, m), n and m whole. The energy the spectrum has
// about each k, per unit area of the k plane, is
//
//   E(k) = S(ω) (g / 2ω) / k · D(θ),    ω² = g k,
//
// S the frequency spectrum and D the spreading: S(ω) D(θ) dω dθ carried over
// to k dk dθ. A wave's amplitude is √(2 E Δk²), Δk = 2π/L.
//
// Two things make the patch a function of world time that a shader can
// hold. Every frequency is rounded to a whole multiple of 2π/T, so the
// patch repeats every T seconds and only the time within that loop is
// needed (Tessendorf's own device for a sea that repeats). And every wave's
// phase at time 0 comes from a hash of (n, m), so every device draws the
// same sea.
//
// The lattice samples the k plane coarsely where the band begins: a
// handful of wave vectors hold a quarter of its height, and their sum
// would be a tenth higher or lower as the wind swings round. So the
// amplitudes are scaled together to carry exactly the variance the spectrum
// has over the band, as the boat band's are.

import type { WeatherSea } from '../catalog/types.gen';

/** Gravity, m/s², as the physics has it. */
export const GRAVITY = 9.81;
const TWO_PI = 2 * Math.PI;
const NAUTICAL_MILE = 1852;
/** A patch rolls off at this fraction of the wavenumber of the shortest wave its texels hold. */
export const ROLL_OFF = 0.8;

/**
 * The dimensionless fetch g F / U² at which the fetch-limited peak has come
 * down to the fully developed sea's (Pierson and Moskowitz 1964): the sea
 * grows no further.
 */
const FULL_FETCH = (22 / 0.877) ** 3;

/** A patch of the detail band: what it holds, and how it loops. */
export interface Patch {
  /** Texels a side, a power of two. */
  size: number;
  /** Its side, in metres. */
  length: number;
  /** It repeats every this many seconds. */
  period: number;
  /** Only waves shorter than this, in metres. */
  longest: number;
  /** Only waves at least this long, in metres; 0 for whatever the texels carry. */
  shortest: number;
  /** The roll-off's wavenumber: energy is weighted by exp(−(k/rollOff)²). */
  rollOff: number;
  /**
   * The roll-off of the coarser patch this one continues, or 0: its energy
   * is weighted by 1 − exp(−(k/above)²), so the two together are the
   * spectrum once.
   */
  above: number;
}

/** The wind that raises the waves, and the open water it has blown over. */
export interface WaveWind {
  /** 10 m up, m/s. */
  speed: number;
  /** The direction the waves travel toward: a unit vector's east and north parts. */
  east: number;
  north: number;
  /** In metres. */
  fetch: number;
}

/** The JONSWAP spectrum under a wind: S(ω) = level · ω⁻⁵ exp(−5/4 (peak/ω)⁴) γ^r. */
export interface Jonswap {
  /** α g², with α = 0.076 (g F / U²)^−0.22; 0 for no wind. */
  level: number;
  /** The peak's frequency, rad/s: 22 (g² / (U F))^⅓. */
  peak: number;
}

/** The spectrum's level and peak under a wind over a fetch, capped at full development and at the catalog's open water. */
export function jonswap(sea: WeatherSea, speed: number, fetch: number, out: Jonswap): Jonswap {
  const f = Math.min(fetch, sea.fetchCap * NAUTICAL_MILE);
  if (!(speed > 0) || !(f > 0)) {
    out.level = 0;
    out.peak = 1;
    return out;
  }
  const x = Math.min((GRAVITY * f) / (speed * speed), FULL_FETCH);
  out.level = 0.076 * x ** -0.22 * GRAVITY * GRAVITY;
  out.peak = ((22 * GRAVITY) / speed) * x ** (-1 / 3);
  return out;
}

/** S(ω), m² s. */
export function spectrumAt(sea: WeatherSea, j: Jonswap, omega: number): number {
  const sigma = omega < j.peak ? sea.sigmaBelow : sea.sigmaAbove;
  const d = (omega - j.peak) / (sigma * j.peak);
  const r = Math.exp(-0.5 * d * d);
  const q = (j.peak / omega) ** 4;
  return (j.level * Math.exp(-1.25 * q) * sea.gamma ** r) / omega ** 5;
}

/** 1 / ∫ cos²ˢ(θ/2) dθ over a turn: 4ˢ s!² / (2π (2s)!). */
export function spreadNorm(s: number): number {
  let norm = 1 / TWO_PI;
  for (let j = 1; j <= s; j++) {
    norm *= (2 * j) / (2 * j - 1);
  }
  return norm;
}

/** The weight of a patch on the energy at wavenumber k: its roll-off, what the patch above it left, and its band. */
export function patchWeight(p: Patch, k: number): number {
  const wavelength = TWO_PI / k;
  if (!(wavelength < p.longest) || wavelength < p.shortest) {
    return 0;
  }
  const high = Math.exp(-((k / p.rollOff) ** 2));
  return p.above > 0 ? high * (1 - Math.exp(-((k / p.above) ** 2))) : high;
}

/** The lattice's step in k, rad/m. */
export function stepOf(p: Patch): number {
  return TWO_PI / p.length;
}

/** The whole number of the wave vector along a texel index: 0 … size/2 − 1, then −size/2 … −1. */
export function waveNumberOf(index: number, size: number): number {
  return index < size / 2 ? index : index - size;
}

/** A wave's frequency in whole steps of 2π / period: the nearest to √(g k). */
export function loopStep(k: number, period: number): number {
  return Math.round((Math.sqrt(GRAVITY * k) * period) / TWO_PI);
}

/** Mixes the bits of x (Wellons's lowbias32). */
function hash32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * The phase at time 0 of the wave (n, m), in turns, [0, 1): the same on
 * every device and for every size of patch that holds the wave.
 */
export function phaseOf(n: number, m: number): number {
  return hash32((((n + 32768) & 0xffff) | (((m + 32768) & 0xffff) << 16)) >>> 0) / 4294967296;
}

/**
 * The patch's waves, fixed for its size, length and period. Index i is
 * row · size + column; the column counts east and the row north.
 */
export interface Modes {
  readonly patch: Patch;
  /** Each wave's vector, rad/m, and its length. */
  readonly east: Float64Array;
  readonly north: Float64Array;
  readonly k: Float64Array;
  /** Its frequency, in whole steps of 2π / period. */
  readonly step: Int32Array;
  /** Its phase at time 0, in turns. */
  readonly phase: Float64Array;
  /** Where the opposite wave, −k, is. */
  readonly opposite: Int32Array;
  /** Its weight on the spectrum's energy (patchWeight); 0 for a wave the patch leaves out. */
  readonly weight: Float64Array;
}

export function modesOf(patch: Patch): Modes {
  const n = patch.size;
  const dk = stepOf(patch);
  const m: Modes = {
    patch,
    east: new Float64Array(n * n),
    north: new Float64Array(n * n),
    k: new Float64Array(n * n),
    step: new Int32Array(n * n),
    phase: new Float64Array(n * n),
    opposite: new Int32Array(n * n),
    weight: new Float64Array(n * n),
  };
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col;
      const a = waveNumberOf(col, n);
      const b = waveNumberOf(row, n);
      const k = Math.hypot(a, b) * dk;
      m.east[i] = a * dk;
      m.north[i] = b * dk;
      m.k[i] = k;
      m.opposite[i] = ((n - row) % n) * n + ((n - col) % n);
      m.phase[i] = phaseOf(a, b);
      // The texels' own shortest wave has no opposite to pair with, and the
      // corners beyond it would make the patch's finest ripples squarer than
      // round: both are left out.
      if (k === 0 || a === -n / 2 || b === -n / 2 || Math.hypot(a, b) > n / 2 - 1) {
        continue;
      }
      m.step[i] = loopStep(k, patch.period);
      m.weight[i] = patchWeight(patch, k);
    }
  }
  return m;
}

/** What a shader needs of the spectrum under a wind, beside the catalog's constants. */
export interface SpectrumInputs extends Jonswap {
  /** The direction the waves travel toward. */
  east: number;
  north: number;
  /** The scale that makes the patch's waves carry the band's variance. */
  fit: number;
  /** The band's variance, m², and with it its significant height, 4 √variance. */
  variance: number;
  /** The mean square of its slope. */
  slope: number;
}

/** Rings of the lattice summed one by one for the fit; beyond them the lattice is fine enough to integrate over. */
const FIT_RINGS = 24;
const RULE = 192;

/**
 * ∫ S(ω) w(k) ωᵖ… over the band from wavenumber from up, by the midpoint
 * rule in ln ω: the variance of the height (moment 0) or of the slope
 * (moment 2, weighting by k²).
 */
function bandIntegral(sea: WeatherSea, j: Jonswap, p: Patch, from: number, slope: boolean): number {
  // The roll-off leaves nothing past four times its wavenumber.
  let to = 4 * p.rollOff;
  if (p.shortest > 0) {
    to = Math.min(to, TWO_PI / p.shortest);
  }
  const start = Math.max(from, TWO_PI / p.longest);
  if (!(to > start) || j.level === 0) {
    return 0;
  }
  const lo = Math.sqrt(GRAVITY * start);
  const span = Math.log(Math.sqrt(GRAVITY * to) / lo);
  let sum = 0;
  for (let i = 0; i < RULE; i++) {
    const omega = lo * Math.exp(((i + 0.5) * span) / RULE);
    const k = (omega * omega) / GRAVITY;
    const s = spectrumAt(sea, j, omega) * omega * patchWeight(p, k);
    sum += slope ? s * k * k : s;
  }
  return (sum * span) / RULE;
}

/** The energy of the wave at k, travelling at cosine c of the angle off the waves' direction, times Δk²: half its amplitude squared, before the fit. */
function energyAt(
  sea: WeatherSea,
  j: Jonswap,
  norm: number,
  dk: number,
  k: number,
  c: number,
  weight: number,
): number {
  if (weight === 0 || j.level === 0) {
    return 0;
  }
  const omega = Math.sqrt(GRAVITY * k);
  // cos²(θ/2) = (1 + cos θ) / 2.
  const spread = norm * (0.5 * (1 + c)) ** sea.spreading;
  return ((spectrumAt(sea, j, omega) * GRAVITY) / (2 * omega) / k) * spread * weight * dk * dk;
}

/**
 * The spectrum under a wind, for a patch: its level and peak, the waves'
 * direction, and the fit. The fit is the band's variance over the lattice's
 * own sum: ring by ring where the lattice is coarse, and by the integral
 * beyond, where it is fine.
 */
export function spectrumInputs(
  sea: WeatherSea,
  p: Patch,
  wind: WaveWind,
  out: SpectrumInputs,
): SpectrumInputs {
  jonswap(sea, wind.speed, wind.fetch, out);
  const d = Math.hypot(wind.east, wind.north) || 1;
  out.east = wind.east / d;
  out.north = wind.north / d;
  const dk = stepOf(p);
  const norm = spreadNorm(sea.spreading);
  const rings = Math.min(FIT_RINGS, p.size / 2 - 1);
  let sum = 0;
  for (let b = -rings; b <= rings; b++) {
    for (let a = -rings; a <= rings; a++) {
      const r = Math.hypot(a, b);
      if (r === 0 || r > rings) {
        continue;
      }
      const k = r * dk;
      const c = (a * out.east + b * out.north) / r;
      sum += energyAt(sea, out, norm, dk, k, c, patchWeight(p, k));
    }
  }
  const all = bandIntegral(sea, out, p, 0, false);
  const beyond = bandIntegral(sea, out, p, rings * dk, false);
  out.variance = all;
  out.slope = bandIntegral(sea, out, p, 0, true);
  out.fit = sum + beyond > 0 ? all / (sum + beyond) : 0;
  return out;
}

export function newSpectrumInputs(): SpectrumInputs {
  return { level: 0, peak: 1, east: 1, north: 0, fit: 0, variance: 0, slope: 0 };
}

/**
 * Each wave's amplitude under a wind, in metres, into out: √(2 E Δk² · fit).
 * The surface is the sum of a cos(k·x − ω t + phase) over the waves.
 */
export function amplitudes(
  sea: WeatherSea,
  modes: Modes,
  inputs: SpectrumInputs,
  out: Float64Array,
): Float64Array {
  const dk = stepOf(modes.patch);
  const norm = spreadNorm(sea.spreading);
  for (let i = 0; i < out.length; i++) {
    const k = modes.k[i] as number;
    const w = modes.weight[i] as number;
    if (w === 0) {
      out[i] = 0;
      continue;
    }
    const c =
      ((modes.east[i] as number) * inputs.east + (modes.north[i] as number) * inputs.north) / k;
    out[i] = Math.sqrt(2 * energyAt(sea, inputs, norm, dk, k, c, w) * inputs.fit);
  }
  return out;
}

/** The band's variance over a patch under a wind and a fetch, m²: its significant height is 4 √ of it. */
export function bandVariance(sea: WeatherSea, p: Patch, speed: number, fetch: number): number {
  return bandIntegral(sea, jonswap(sea, speed, fetch, { level: 0, peak: 1 }), p, 0, false);
}

/** The detail band's patch at a size: the waves from the boat band's shortest down to what its texels carry. */
export function detailPatch(sea: WeatherSea, size: number, length: number, period: number): Patch {
  return {
    size,
    length,
    period,
    longest: sea.shortest,
    shortest: 0,
    rollOff: (ROLL_OFF * Math.PI * size) / length,
    above: 0,
  };
}

/** The finer patch that continues one: what that one rolls off, down to what its own texels carry. */
export function finerPatch(first: Patch, length: number, longest: number): Patch {
  return {
    size: first.size,
    length,
    period: first.period,
    longest,
    shortest: 0,
    rollOff: (ROLL_OFF * Math.PI * first.size) / length,
    above: first.rollOff,
  };
}
