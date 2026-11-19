// SPDX-License-Identifier: AGPL-3.0-only

// A loudness meter after ITU-R BS.1770-4 and EBU R 128, for what the sound
// engine renders offline: the K-weighted power of 400 ms blocks overlapping
// by three quarters, gated absolutely at −70 LUFS and then 10 LU under the
// blocks' mean (integrated loudness); the most of the 400 ms (momentary)
// and 3 s (short-term) windows; the loudness range of EBU Tech 3342, the
// spread from the 10th to the 95th percentile of the short-term loudness
// gated at −70 LUFS and 20 LU under its mean; the sample peak, and the true
// peak, four times oversampled. Channels are weighted alike (left and
// right). It also gives the share of the energy above a frequency, which
// is what made the bed sound harsh.
//
// The K-weighting's two filters, a shelf of about +4 dB above 1.5 kHz and
// a high-pass at 38 Hz, are made for any sample rate from their analogue
// prototypes' parameters (as libebur128 does): at 48 kHz they are
// BS.1770-4's own coefficients.

/** What the meter measures of a stretch of sound. */
export interface Loudness {
  /** Integrated loudness, LUFS; −Infinity when every block is gated out. */
  integrated: number;
  /** The loudest momentary (400 ms) and short-term (3 s) windows, LUFS. */
  momentaryMax: number;
  shortTermMax: number;
  /** The loudness range, LU. */
  range: number;
  /** The highest sample, dBFS, and the true peak, dBTP. */
  samplePeak: number;
  truePeak: number;
}

/**
 * BS.1770's constant: it takes off the K-weighting's gain at 1 kHz, so a
 * 1 kHz sine of peak A in both channels reads 20 log A LUFS.
 */
const OFFSET = -0.691;

/** A power, as loudness: LUFS. */
export function lufs(power: number): number {
  return power > 0 ? OFFSET + 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
}

/** A biquad's coefficients, a0 taken as 1. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The K-weighting's two stages at a sample rate, Hz. */
export function kFilters(rate: number): [Biquad, Biquad] {
  // The shelf.
  let f0 = 1681.974450955533;
  const g = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / rate);
  const vh = 10 ** (g / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // The high-pass.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + k / q + k * k;
  const high: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  return [shelf, high];
}

/** The segments the powers are kept in, s: a quarter of a momentary block. */
export const SEGMENT = 0.1;

/**
 * The K-weighted power of each 100 ms segment, summed over the channels:
 * the stuff every window is made of. A last part segment is dropped.
 */
export function segmentPowers(channels: readonly Float32Array[], rate: number): Float64Array {
  const step = Math.round(rate * SEGMENT);
  const length = channels[0]?.length ?? 0;
  const out = new Float64Array(Math.floor(length / step));
  const [s, h] = kFilters(rate);
  for (const x of channels) {
    // Direct form I, both stages, in doubles.
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let z1 = 0;
    let z2 = 0;
    let sum = 0;
    let n = 0;
    let seg = 0;
    for (let i = 0; i < length && seg < out.length; i++) {
      const x0 = x[i] ?? 0;
      const y0 = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x0;
      const z0 = h.b0 * y0 + h.b1 * y1 + h.b2 * y2 - h.a1 * z1 - h.a2 * z2;
      y2 = y1;
      y1 = y0;
      z2 = z1;
      z1 = z0;
      sum += z0 * z0;
      if (++n === step) {
        out[seg] = (out[seg] ?? 0) + sum / step;
        seg++;
        sum = 0;
        n = 0;
      }
    }
  }
  return out;
}

/** The power of each window of width segments, stepped by one: 400 ms windows are four. */
export function windowPowers(segments: Float64Array, width: number): Float64Array {
  const n = segments.length - width + 1;
  if (n <= 0) {
    return new Float64Array(0);
  }
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < width; i++) {
    sum += segments[i] ?? 0;
  }
  out[0] = sum / width;
  for (let i = 1; i < n; i++) {
    sum += (segments[i + width - 1] ?? 0) - (segments[i - 1] ?? 0);
    out[i] = Math.max(0, sum) / width;
  }
  return out;
}

/** The momentary loudness, LUFS, every 100 ms. */
export function momentary(segments: Float64Array): number[] {
  return Array.from(windowPowers(segments, 4), lufs);
}

/** The short-term loudness, LUFS, every 100 ms. */
export function shortTerm(segments: Float64Array): number[] {
  return Array.from(windowPowers(segments, 30), lufs);
}

/** The absolute gate, LUFS. */
const ABSOLUTE = -70;

/** Integrated loudness from the 400 ms blocks' powers, LUFS. */
export function integrated(blocks: Float64Array): number {
  let sum = 0;
  let n = 0;
  for (const z of blocks) {
    if (lufs(z) > ABSOLUTE) {
      sum += z;
      n++;
    }
  }
  if (n === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const relative = lufs(sum / n) - 10;
  sum = 0;
  n = 0;
  for (const z of blocks) {
    const l = lufs(z);
    if (l > ABSOLUTE && l > relative) {
      sum += z;
      n++;
    }
  }
  return n === 0 ? Number.NEGATIVE_INFINITY : lufs(sum / n);
}

/** The loudness range from the 3 s windows' powers, LU (EBU Tech 3342). */
export function loudnessRange(windows: Float64Array): number {
  let sum = 0;
  let n = 0;
  for (const z of windows) {
    if (lufs(z) > ABSOLUTE) {
      sum += z;
      n++;
    }
  }
  if (n === 0) {
    return 0;
  }
  const relative = lufs(sum / n) - 20;
  const kept = Array.from(windows, lufs)
    .filter((l) => l > ABSOLUTE && l > relative)
    .sort((a, b) => a - b);
  if (kept.length === 0) {
    return 0;
  }
  const at = (p: number): number =>
    kept[Math.min(kept.length - 1, Math.max(0, Math.round(p * (kept.length - 1))))] ?? 0;
  return at(0.95) - at(0.1);
}

/** The highest sample over the channels, dBFS. */
export function samplePeak(channels: readonly Float32Array[]): number {
  let most = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i] ?? 0);
      if (v > most) {
        most = v;
      }
    }
  }
  return most > 0 ? 20 * Math.log10(most) : Number.NEGATIVE_INFINITY;
}

/** Taps a phase of the oversampling filter: four phases make it. */
const TAPS = 32;
const FACTOR = 4;

/**
 * The oversampling filter, by phase: a low-pass at the original Nyquist
 * frequency, windowed by Kaiser's window (β 7, about 70 dB down), its
 * phases each summing to one so the samples themselves come through.
 */
function interpolator(): Float64Array[] {
  const n = TAPS * FACTOR;
  const beta = 7;
  const bessel = (x: number): number => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 30; k++) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  const h = new Float64Array(n);
  const centre = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const t = (i - centre) / FACTOR;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = (2 * (i - centre)) / (n - 1);
    h[i] = (sinc * bessel(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / bessel(beta);
  }
  const phases: Float64Array[] = [];
  for (let p = 0; p < FACTOR; p++) {
    const ph = new Float64Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      ph[k] = h[k * FACTOR + p] ?? 0;
      sum += ph[k] ?? 0;
    }
    for (let k = 0; k < TAPS; k++) {
      ph[k] = (ph[k] ?? 0) / sum;
    }
    phases.push(ph);
  }
  return phases;
}

let phasesMade: Float64Array[] | null = null;

/** The true peak over the channels, dBTP: the highest of the signal four times oversampled. */
export function truePeak(channels: readonly Float32Array[]): number {
  phasesMade ??= interpolator();
  const phases = phasesMade;
  let most = 0;
  for (const x of channels) {
    for (let i = 0; i < x.length; i++) {
      const v = Math.abs(x[i] ?? 0);
      if (v > most) {
        most = v;
      }
    }
    for (let m = TAPS; m < x.length; m++) {
      for (const ph of phases) {
        let y = 0;
        for (let k = 0; k < TAPS; k++) {
          y += (ph[k] ?? 0) * (x[m - k] ?? 0);
        }
        const v = Math.abs(y);
        if (v > most) {
          most = v;
        }
      }
    }
  }
  return most > 0 ? 20 * Math.log10(most) : Number.NEGATIVE_INFINITY;
}

/** A radix-2 FFT in place, of n = re.length, a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const p = i + k;
        const q = p + len / 2;
        const tr = (re[q] ?? 0) * cr - (im[q] ?? 0) * ci;
        const ti = (re[q] ?? 0) * ci + (im[q] ?? 0) * cr;
        re[q] = (re[p] ?? 0) - tr;
        im[q] = (im[p] ?? 0) - ti;
        re[p] = (re[p] ?? 0) + tr;
        im[p] = (im[p] ?? 0) + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** The frames the spectrum is taken over, samples. */
const FRAME = 4096;

/**
 * The share of the energy above hz, 0 to 1, over the channels: from the
 * spectra of Hann-windowed frames, the bins above against all but the
 * lowest.
 */
export function shareAbove(channels: readonly Float32Array[], rate: number, hz: number): number {
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  }
  const from = Math.ceil((hz * FRAME) / rate);
  let above = 0;
  let all = 0;
  for (const x of channels) {
    for (let at = 0; at + FRAME <= x.length; at += FRAME) {
      for (let i = 0; i < FRAME; i++) {
        re[i] = (x[at + i] ?? 0) * (window[i] ?? 0);
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k <= FRAME / 2; k++) {
        const e = (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
        all += e;
        if (k >= from) {
          above += e;
        }
      }
    }
  }
  return all > 0 ? above / all : 0;
}

/** Everything the meter measures of the channels at a sample rate. */
export function measure(channels: readonly Float32Array[], rate: number): Loudness {
  const segments = segmentPowers(channels, rate);
  const blocks = windowPowers(segments, 4);
  const windows = windowPowers(segments, 30);
  const most = (a: Float64Array): number => lufs(a.reduce((m, z) => Math.max(m, z), 0));
  return {
    integrated: integrated(blocks),
    momentaryMax: most(blocks),
    shortTermMax: most(windows),
    range: loudnessRange(windows),
    samplePeak: samplePeak(channels),
    truePeak: truePeak(channels),
  };
}
