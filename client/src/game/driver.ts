// SPDX-License-Identifier: AGPL-3.0-only

// A boat driver: what steps the player's boat. The frame loop gives it the
// controls once a step and draws what it returns: the state before and after
// the latest step, and the values the step derived for drawing (Out). The
// offline sandbox is one driver; prediction against the server is another,
// and the frame loop, controls, camera and screen are the same for both.
// The sandbox is stepped on real time; the prediction is paced by the
// world clock (a Pacer), and moves the drawn boat by the correction it is
// easing away.

import type { BoatPose, StatePair } from '../predict/blend';

export interface Wind {
  /** The true wind 10 m above the sea, m/s. */
  speed: number;
  /** Where it comes from, radians clockwise from north. */
  from: number;
}

export interface BoatDriver {
  /** The state before and after the latest step. */
  readonly states: StatePair;
  /** The latest step's Out record. */
  readonly out: Float64Array;
  /** The wind at the boat. */
  readonly wind: Readonly<Wind>;
  /** Steps the boat once with these controls, already at the controls' resolution. */
  step(helm: number, sheet: number): void;
  /** Moves the drawn pose, dt seconds after the last frame's. */
  decorate?(pose: BoatPose, dt: number): void;
}

/** Steps a driver to where the world clock says it should be, each frame. */
export interface Pacer {
  /** The frame's steps, dt seconds after the last frame; it sets the world clock. */
  frame(dt: number): void;
}
