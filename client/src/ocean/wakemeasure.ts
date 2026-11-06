// SPDX-License-Identifier: AGPL-3.0-only

// The physics' measures of a wake's waves, for the tests: the angle the V's
// largest waves make with the track, and the length of the waves across the
// track. A wake is laid out here as a grid of heights or slopes about the
// boat's track: rows astern, columns across.

/** A wake about a straight track, sampled on a grid: index row · cols + col. */
export interface WakeGrid {
  /** Distances astern of the boat of each row, and off the track of each column (to starboard positive), metres. */
  astern: number[];
  off: number[];
  /** The surface's height, metres, and the size of its slope. */
  height: Float64Array | number[];
  slope: Float64Array | number[];
}

/**
 * The angle, in degrees, of the line along which the wake's waves are
 * largest, from the track: their envelope, the slope's square averaged over
 * a square smooth metres a side, and on each row between from and to metres
 * astern, on each side, the column off the track where it is greatest; a
 * line fitted to them by least squares, so that where the V begins does not
 * matter. Columns further off than most are left out.
 */
export function wakeAngle(g: WakeGrid, from: number, to: number, most: number, smooth = 0): number {
  const cols = g.off.length;
  const rows = g.astern.length;
  const step = cols > 1 ? Math.abs((g.off[1] as number) - (g.off[0] as number)) : 1;
  const r = Math.max(Math.round(smooth / step / 2), 0);
  const sq = new Float64Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    sq[i] = (g.slope[i] as number) ** 2;
  }
  const env = new Float64Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(row - r, 0); y <= Math.min(row + r, rows - 1); y++) {
        for (let x = Math.max(col - r, 0); x <= Math.min(col + r, cols - 1); x++) {
          sum += sq[y * cols + x] as number;
          n++;
        }
      }
      env[row * cols + col] = sum / n;
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  g.astern.forEach((a, row) => {
    if (a < from || a > to) {
      return;
    }
    for (const side of [1, -1]) {
      let best = 0;
      let at = -1;
      for (let col = 0; col < cols; col++) {
        const off = (g.off[col] as number) * side;
        if (off <= 0 || off > most) {
          continue;
        }
        const s = env[row * cols + col] as number;
        if (s > best) {
          best = s;
          at = off;
        }
      }
      if (at >= 0) {
        xs.push(a);
        ys.push(at);
      }
    }
  });
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    sxx += ((xs[i] as number) - mx) ** 2;
  }
  return (Math.atan(sxy / sxx) * 180) / Math.PI;
}

/**
 * The length of the waves along the track, in metres: the length between
 * shortest and longest whose Fourier component is strongest in the heights
 * within a few metres of the track, from from to to metres astern.
 */
export function trackWavelength(
  g: WakeGrid,
  from: number,
  to: number,
  shortest: number,
  longest: number,
  width = 1,
): number {
  const cols = g.off.length;
  const xs: number[] = [];
  const hs: number[] = [];
  g.astern.forEach((a, row) => {
    if (a < from || a > to) {
      return;
    }
    let sum = 0;
    let n = 0;
    for (let col = 0; col < cols; col++) {
      if (Math.abs(g.off[col] as number) <= width) {
        sum += g.height[row * cols + col] as number;
        n++;
      }
    }
    xs.push(a);
    hs.push(n > 0 ? sum / n : 0);
  });
  let best = 0;
  let at = shortest;
  for (let lambda = shortest; lambda <= longest; lambda += 0.005 * shortest) {
    const k = (2 * Math.PI) / lambda;
    let re = 0;
    let im = 0;
    xs.forEach((x, i) => {
      re += (hs[i] as number) * Math.cos(k * x);
      im += (hs[i] as number) * Math.sin(k * x);
    });
    const power = re * re + im * im;
    if (power > best) {
      best = power;
      at = lambda;
    }
  }
  return at;
}
