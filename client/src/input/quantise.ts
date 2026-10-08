// SPDX-License-Identifier: AGPL-3.0-only

// The controls' resolution. Each control is rounded to a step of 1/1024 of
// its range before the physics sees it, the same resolution the server will
// receive, so a boat stepped here is the boat the server sails.

/** Steps across each control's range. */
export const RESOLUTION = 1024;

/** v, clamped to [lo, hi] and rounded to the nearest of RESOLUTION + 1 values across it. */
export function quantise(v: number, lo: number, hi: number): number {
  if (!(v > lo)) {
    return lo;
  }
  if (!(v < hi)) {
    return hi;
  }
  const k = Math.round(((v - lo) / (hi - lo)) * RESOLUTION);
  return lo + (k * (hi - lo)) / RESOLUTION;
}

/** The helm, −1 (hard to port) to 1, as the physics receives it. */
export function quantiseHelm(helm: number): number {
  return quantise(helm, -1, 1);
}

/** The sheet, 0 (hauled in) to 1 (let fly), as the physics receives it. */
export function quantiseSheet(sheet: number): number {
  return quantise(sheet, 0, 1);
}
