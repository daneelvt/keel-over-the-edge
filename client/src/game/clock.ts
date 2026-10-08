// SPDX-License-Identifier: AGPL-3.0-only

// The world clock. The physics steps a boat 30 times a second, and world
// time is counted in those steps: the sea's phases, the sail's flutter and
// everything else that moves with time read it, so the sea and the boat
// always agree. Between steps a frame is drawn a fraction alpha of the way
// to the next one, and world time includes that fraction.

/** Steps a second, as the physics module steps. */
export const STEPS_PER_SECOND = 30;
/** The length of a step, in seconds. */
export const STEP = 1 / STEPS_PER_SECOND;

export class WorldClock {
  /** Steps taken since the clock started. */
  steps = 0;
  /** How far the frame drawn is toward the next step, in [0, 1). */
  alpha = 0;

  /** World time at the frame drawn, in seconds. */
  get time(): number {
    return (this.steps + this.alpha) / STEPS_PER_SECOND;
  }

  /** Sets world time to t seconds, at the nearest step. */
  set(t: number): void {
    this.steps = Math.round(t * STEPS_PER_SECOND);
    this.alpha = 0;
  }
}
