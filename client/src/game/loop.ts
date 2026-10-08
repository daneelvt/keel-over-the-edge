// SPDX-License-Identifier: AGPL-3.0-only

// Fixed steps in variable frames (Fiedler, "Fix Your Timestep!", 2004). Each
// drawn frame adds the real time since the last one to an accumulator and
// takes whole steps of 1/30 s out of it; the frame is then drawn between the
// last two steps, a fraction alpha = remainder ÷ step of the way. The
// physics never sees a variable step, and motion is smooth at 30, 60 or
// 120 Hz.
//
// A frame takes at most four steps. After a stall (a slow frame, a hidden
// page) the time beyond that is dropped: the boat waits rather than the page
// freezing while it catches up.

import { STEP, type WorldClock } from './clock';

/** The most steps one frame takes. */
export const MAX_STEPS = 4;
/** Rounding in the accumulator below this, in seconds, does not hold a step back. */
const EPSILON = 1e-9;

export class StepLoop {
  /** Seconds of real time not yet stepped, in [0, STEP). */
  accumulator = 0;
  /** Paused: real time stops counting. */
  paused = false;
  /** Slow motion: real time counts at this rate (¼, ½ or 1). */
  speed = 1;

  readonly #clock: WorldClock;
  readonly #step: () => void;

  /** step is called for each step taken, after which the clock counts it. */
  constructor(clock: WorldClock, step: () => void) {
    this.#clock = clock;
    this.#step = step;
  }

  /**
   * Adds dt seconds of real time, takes the steps due, and sets the clock's
   * alpha. Returns the number of steps taken.
   */
  advance(dt: number): number {
    if (!this.paused && dt > 0) {
      this.accumulator += dt * this.speed;
    }
    let taken = 0;
    while (this.accumulator >= STEP - EPSILON && taken < MAX_STEPS) {
      this.accumulator = Math.max(0, this.accumulator - STEP);
      this.stepOnce();
      taken++;
    }
    if (this.accumulator >= STEP - EPSILON) {
      // More was due than a frame takes: drop it, keeping the fraction.
      this.accumulator %= STEP;
    }
    this.#clock.alpha = Math.min(this.accumulator / STEP, 1 - EPSILON);
    return taken;
  }

  /** Takes one step now (also the developer panel's single step). */
  stepOnce(): void {
    this.#step();
    this.#clock.steps++;
  }
}
