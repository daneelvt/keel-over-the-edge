// SPDX-License-Identifier: AGPL-3.0-only

// The loudness meter of audio/loudness.ts, fed as the sound plays, a block
// at a time: the sound room's. It K-weights each channel through filters
// that keep their state from block to block, sums each 100 ms segment's
// power, and from the segments since it was reset reads the integrated
// loudness (gated as BS.1770-4 gates it), the short-term (the last 3 s)
// and the momentary (the last 400 ms); with the highest true peak, and the
// share of the energy above 2 kHz.

import {
  integrated,
  kFilters,
  lufs,
  SEGMENT,
  shareAbove,
  truePeak,
  windowPowers,
} from './loudness';

/** A biquad's state: its last two inputs and outputs. */
interface State {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const fresh = (): State => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/** The spectrum's frames, samples: the share above 2 kHz is read a whole frame at a time. */
const FRAME = 4096;

export class LiveMeter {
  readonly rate: number;
  readonly #filters: ReturnType<typeof kFilters>;
  readonly #step: number;
  #states: State[][] = [];
  #segments: number[] = [];
  #sum = 0;
  #n = 0;
  #peak = Number.NEGATIVE_INFINITY;
  #above = 0;
  #all = 0;
  /** What has come since the last whole frame, by channel. */
  #pending: Float32Array[] = [];
  #pendingLength = 0;

  constructor(rate: number) {
    this.rate = rate;
    this.#filters = kFilters(rate);
    this.#step = Math.round(rate * SEGMENT);
    this.reset();
  }

  /** Forgets everything measured. */
  reset(): void {
    this.#states = [];
    this.#segments = [];
    this.#sum = 0;
    this.#n = 0;
    this.#peak = Number.NEGATIVE_INFINITY;
    this.#above = 0;
    this.#all = 0;
    this.#pending = [];
    this.#pendingLength = 0;
  }

  /** Measures a block of the channels, all of one length. */
  push(channels: readonly Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    const [s, h] = this.#filters;
    channels.forEach((_, c) => {
      this.#states[c] ??= [fresh(), fresh()];
    });
    for (let i = 0; i < length; i++) {
      let p = 0;
      channels.forEach((x, c) => {
        const [a, b] = this.#states[c] as [State, State];
        const x0 = x[i] ?? 0;
        const y0 = s.b0 * x0 + s.b1 * a.x1 + s.b2 * a.x2 - s.a1 * a.y1 - s.a2 * a.y2;
        a.x2 = a.x1;
        a.x1 = x0;
        a.y2 = a.y1;
        a.y1 = y0;
        const z0 = h.b0 * y0 + h.b1 * b.x1 + h.b2 * b.x2 - h.a1 * b.y1 - h.a2 * b.y2;
        b.x2 = b.x1;
        b.x1 = y0;
        b.y2 = b.y1;
        b.y1 = z0;
        p += z0 * z0;
      });
      this.#sum += p;
      if (++this.#n === this.#step) {
        this.#segments.push(this.#sum / this.#step);
        this.#sum = 0;
        this.#n = 0;
      }
    }
    this.#peak = Math.max(this.#peak, truePeak(channels));
    // The spectrum, a whole frame at a time.
    let at = 0;
    while (at < length) {
      const take = Math.min(FRAME - this.#pendingLength, length - at);
      channels.forEach((x, c) => {
        this.#pending[c] ??= new Float32Array(FRAME);
        (this.#pending[c] as Float32Array).set(x.subarray(at, at + take), this.#pendingLength);
      });
      this.#pendingLength += take;
      at += take;
      if (this.#pendingLength === FRAME) {
        const frame = this.#pending.slice(0, channels.length);
        let e = 0;
        for (const x of frame) {
          for (let i = 0; i < FRAME; i++) {
            e += (x[i] ?? 0) ** 2;
          }
        }
        this.#all += e;
        this.#above += e * shareAbove(frame, this.rate, 2000);
        this.#pendingLength = 0;
      }
    }
  }

  /** The integrated loudness since the reset, LUFS. */
  get integrated(): number {
    return integrated(windowPowers(Float64Array.from(this.#segments), 4));
  }

  /** The loudness of the last segments, LUFS: 30 the short-term, 4 the momentary. */
  #last(n: number): number {
    const s = this.#segments.slice(-n);
    if (s.length < n) {
      return Number.NEGATIVE_INFINITY;
    }
    return lufs(s.reduce((a, v) => a + v, 0) / n);
  }

  get shortTerm(): number {
    return this.#last(30);
  }

  get momentary(): number {
    return this.#last(4);
  }

  /** The highest true peak since the reset, dBTP. */
  get truePeak(): number {
    return this.#peak;
  }

  /** The share of the energy above 2 kHz since the reset, 0 to 1. */
  get above(): number {
    return this.#all > 0 ? this.#above / this.#all : 0;
  }

  /** How long has been measured, s. */
  get seconds(): number {
    return this.#segments.length * SEGMENT;
  }
}
