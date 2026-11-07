// SPDX-License-Identifier: AGPL-3.0-only

// Drawing between two steps. The client keeps the state before and after
// the latest step, and draws the boat a fraction alpha of the way from one
// to the other. This is drawing only: it never feeds a step or the server,
// so JavaScript's Math is fine here.

import { RECORDS, SIZES } from './layout.gen';

const S = RECORDS.state;

/** What is drawn of a boat, between two steps. */
export interface BoatPose {
  /** World position, metres east and north of the disk's centre. */
  east: number;
  north: number;
  /** Clockwise from north, radians. */
  heading: number;
  /** Positive with the starboard side down, radians. */
  heel: number;
  /** The centre of gravity's rise above where it floats in flat water, metres. */
  heave: number;
  /** Positive with the bow up, radians. */
  pitch: number;
  /** Positive to starboard, radians. */
  boom: number;
  rudder: number;
  /** The sailor's offset from the centreline, metres, positive to starboard. */
  sailor: number;
  /** The furthest the sheet lets the boom out, radians. */
  sheetLimit: number;
  /** The sailor's mode, from the newer step. */
  sailorMode: number;
  /** The seconds left in the sailor's mode (swimming, climbing), from the newer step. */
  sailorTimer: number;
  /** The heel's rate, radians a second. */
  rollRate: number;
  /** The headsails' clew's angle, positive to starboard, radians; 0 on a boat with none. */
  jib: number;
  /** How far the main is reefed: 0 at full sail, up to 2. */
  reef: number;
  /**
   * The after and fore yards' nodes' turns about the vertical, radians
   * (yardsTurn of State.Yards and State.ForeYards):
   * 0 square, and on a boat with none.
   */
  yardsTurn: number;
  foreYardsTurn: number;
}

export function newPose(): BoatPose {
  return {
    east: 0,
    north: 0,
    heading: 0,
    heel: 0,
    heave: 0,
    pitch: 0,
    boom: 0,
    rudder: 0,
    sailor: 0,
    sheetLimit: 0,
    sailorMode: 0,
    sailorTimer: 0,
    rollRate: 0,
    jib: 0,
    reef: 0,
    yardsTurn: 0,
    foreYardsTurn: 0,
  };
}

/** a + t·(b − a) along the shorter way round the circle. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) {
    d -= 2 * Math.PI;
  } else if (d < -Math.PI) {
    d += 2 * Math.PI;
  }
  return a + d * t;
}

/**
 * A square rig's yards' node's turn about the vertical, radians, as
 * Object3D.rotation.y takes it, for the physics's yards' angle off the
 * centreline (signed by the side they are braced for, positive with the
 * port yardarm forward; ±π/2 square): π/2 less the angle, the port arm
 * forward (a negative turn: the bow is at −z, starboard at +x) for a
 * positive angle; 0 square, and for yards never braced (0).
 */
export function yardsTurn(angle: number): number {
  if (angle === 0 || !Number.isFinite(angle)) {
    return 0;
  }
  const a = Math.min(Math.abs(angle), Math.PI / 2);
  return -Math.sign(angle) * (Math.PI / 2 - a);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The previous and newer state of a boat, two records made once. */
export class StatePair {
  readonly previous = new Float64Array(SIZES.state);
  readonly current = new Float64Array(SIZES.state);

  /** Keeps the newer state as the previous one, then copies a new one in. */
  push(state: Float64Array): void {
    this.previous.set(this.current);
    this.current.set(state);
  }

  /** Both states the same, after the boat is placed or reset. */
  hold(state: Float64Array): void {
    this.previous.set(state);
    this.current.set(state);
  }

  /** The pose a fraction alpha of the way from the previous state to the newer. */
  blend(alpha: number, out: BoatPose): BoatPose {
    out.east = this.#at(S.x, alpha);
    out.north = this.#at(S.y, alpha);
    out.heading = lerpAngle(this.previous[S.heading] ?? 0, this.current[S.heading] ?? 0, alpha);
    out.heel = lerpAngle(this.previous[S.heel] ?? 0, this.current[S.heel] ?? 0, alpha);
    out.heave = this.#at(S.heave, alpha);
    out.pitch = this.#at(S.pitch, alpha);
    out.boom = this.#at(S.boom, alpha);
    out.rudder = this.#at(S.rudder, alpha);
    out.sailor = this.#at(S.sailor, alpha);
    out.sheetLimit = this.#at(S.sheetLimit, alpha);
    out.sailorMode = this.current[S.sailorMode] ?? 0;
    out.sailorTimer = this.current[S.sailorTimer] ?? 0;
    out.rollRate = this.#at(S.rollRate, alpha);
    out.jib = this.#at(S.jib, alpha);
    out.reef = this.#at(S.reef, alpha);
    // Blended by their turns, which run smoothly through square, where the
    // angles' sign flips.
    out.yardsTurn = lerp(
      yardsTurn(this.previous[S.yards] ?? 0),
      yardsTurn(this.current[S.yards] ?? 0),
      alpha,
    );
    out.foreYardsTurn = lerp(
      yardsTurn(this.previous[S.foreYards] ?? 0),
      yardsTurn(this.current[S.foreYards] ?? 0),
      alpha,
    );
    return out;
  }

  #at(i: number, alpha: number): number {
    return lerp(this.previous[i] ?? 0, this.current[i] ?? 0, alpha);
  }
}
