// SPDX-License-Identifier: AGPL-3.0-only

// Frame statistics for the developer panel: the interval between drawn
// frames over 2-second windows (median and 90th percentile), the main
// thread's work on each drawn frame, GPU time from timestamp queries where
// the device offers them, and the draw calls and triangles of the last
// frame. The interval shows the frame cap as much as the phone; the work
// shows what the phone has to spare. Recording a frame allocates nothing.

import type { Gfx } from './renderer';

/** Length of a statistics window, in milliseconds. */
export const WINDOW = 2000;
const MAX_FRAMES = 1024;

export interface FrameStats {
  /** Frames in the last window. */
  frames: number;
  /** Median and 90th-percentile interval between drawn frames, in milliseconds. */
  median: number;
  p90: number;
  /** Median and 90th-percentile main-thread work per drawn frame, in milliseconds. */
  workMedian: number;
  workP90: number;
  /** Mean GPU time per frame over the window, in milliseconds, or null. */
  gpu: number | null;
  drawCalls: number;
  triangles: number;
}

/** The value at fraction p of sorted (0 the least, 1 the greatest). */
export function percentile(sorted: Float64Array, n: number, p: number): number {
  if (n === 0) {
    return 0;
  }
  const i = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sorted[i] ?? 0;
}

export class Stats {
  readonly last: FrameStats = {
    frames: 0,
    median: 0,
    p90: 0,
    workMedian: 0,
    workP90: 0,
    gpu: null,
    drawCalls: 0,
    triangles: 0,
  };
  /** Whether to read GPU timestamps (the panel asks for them). */
  gpuTiming = false;

  readonly #times = new Float64Array(MAX_FRAMES);
  readonly #sorted = new Float64Array(MAX_FRAMES);
  readonly #work = new Float64Array(MAX_FRAMES);
  #n = 0;
  #w = 0;
  #prev = -1;
  #windowStart = -1;
  #gpuSum = 0;
  #gpuFrames = 0;
  #unresolved = 0;
  #resolving = false;

  /** Records the draw calls, triangles and main-thread work (ms) of the frame just drawn. */
  drawn(gfx: Gfx, work = 0): void {
    const info = gfx.renderer.info.render;
    this.last.drawCalls = info.drawCalls;
    this.last.triangles = info.triangles;
    if (this.#w < MAX_FRAMES) {
      this.#work[this.#w++] = work;
    }
  }

  /** Records the frame starting at now, in milliseconds. */
  frame(now: number, gfx: Gfx): void {
    if (this.#prev >= 0 && this.#n < MAX_FRAMES) {
      this.#times[this.#n++] = now - this.#prev;
    }
    this.#prev = now;
    if (this.#windowStart < 0) {
      this.#windowStart = now;
    }
    // A resolve returns the total of every frame drawn since the last one.
    this.#unresolved++;
    if (this.gpuTiming && gfx.timestamps && !this.#resolving) {
      this.#resolving = true;
      const frames = this.#unresolved;
      this.#unresolved = 0;
      void gfx.renderer.resolveTimestampsAsync('render').then((ms) => {
        this.#resolving = false;
        if (typeof ms === 'number' && ms > 0) {
          this.#gpuSum += ms;
          this.#gpuFrames += frames;
        }
      });
    }
    if (now - this.#windowStart >= WINDOW) {
      this.#close(now);
    }
  }

  #close(now: number): void {
    const n = this.#n;
    this.#sorted.set(this.#times.subarray(0, n));
    const s = this.#sorted.subarray(0, n).sort();
    this.last.frames = n;
    this.last.median = percentile(s, n, 0.5);
    this.last.p90 = percentile(s, n, 0.9);
    this.last.gpu = this.#gpuFrames > 0 ? this.#gpuSum / this.#gpuFrames : null;
    const w = this.#w;
    this.#sorted.set(this.#work.subarray(0, w));
    const sw = this.#sorted.subarray(0, w).sort();
    this.last.workMedian = percentile(sw, w, 0.5);
    this.last.workP90 = percentile(sw, w, 0.9);
    this.#w = 0;
    this.#n = 0;
    this.#gpuSum = 0;
    this.#gpuFrames = 0;
    this.#windowStart = now;
  }
}
