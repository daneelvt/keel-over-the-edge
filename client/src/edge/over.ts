// SPDX-License-Identifier: AGPL-3.0-only

// Going over, drawn. While the hull overhangs the lip it is drawn pitching
// over the brink, as the last tiles tip: drawing only, the boat's state is
// the physics'. From the tick its centre crosses the lip the boat falls as
// a slab of the sea does (falls.ts): carried out at the drain's speed, let
// go, tipping and falling at the slabs' gravity, while the camera holds
// where it was and the screen fades to the mist. Then it is back at the
// start.
//
// Each voyage's approaches to the lip are followed on the boat's own track
// as the server follows them, so the screen can say how close one came as
// soon as it is survived; the record is the server's.

import type { BoatPose } from '../predict/blend';

/** Over the falls, back at the start, and the closest approach survived, as the screen says them. */
export const OVER_THE_FALLS = 'Over the falls';
export const BACK_AT_PORT = 'Back at Port Royal';

/** "Closest to the edge: N m", in whole metres, or "under a metre". */
export function closestLine(distance: number): string {
  const m = Math.round(distance);
  return m < 1 ? 'Closest to the edge: under a metre' : `Closest to the edge: ${m} m`;
}

/** The most a hull overhanging the lip is drawn pitched over it, rad. */
const OVERHANG_TIP = 0.35;

/** The fall's numbers: the lip, the drain at it, and the slabs'. */
export interface FallShape {
  lip: number;
  /** The drain's speed at the lip, m/s. */
  drain: number;
  /** The slabs' gravity, m/s², and their tip: at release and per second. */
  gravity: number;
  tip: [number, number];
}

/**
 * Pitches and heels a pose, of a hull half as long as halfLength, as far as
 * its ends hang over the lip: a hull whose bow is over the brink is drawn
 * bow down, one lying along it heeled toward it.
 */
export function overhang(pose: BoatPose, halfLength: number, lip: number): void {
  const r = Math.hypot(pose.east, pose.north);
  if (r < lip - halfLength || r === 0) {
    return;
  }
  const ue = pose.east / r;
  const un = pose.north / r;
  // The bow's and the starboard side's reach toward the lip.
  const ahead = Math.sin(pose.heading) * ue + Math.cos(pose.heading) * un;
  const beam = Math.cos(pose.heading) * ue - Math.sin(pose.heading) * un;
  const inside = lip - r;
  const along = Math.min(Math.max((halfLength * Math.abs(ahead) - inside) / halfLength, 0), 1);
  const across = Math.min(Math.max((halfLength * Math.abs(beam) - inside) / halfLength, 0), 1);
  pose.pitch -= Math.sign(ahead) * OVERHANG_TIP * along * Math.abs(ahead);
  pose.heel += Math.sign(beam) * OVERHANG_TIP * across * Math.abs(beam);
}

/**
 * The pose of a boat t seconds after its centre crossed the lip at the
 * pose's place: carried out by the drain, falling at the slabs' gravity,
 * tipped outward about the lip's tangent.
 */
export function fallPose(
  pose: Pick<BoatPose, 'east' | 'north' | 'heading' | 'heel' | 'heave' | 'pitch'>,
  t: number,
  f: FallShape,
): void {
  if (!(t > 0)) {
    return;
  }
  const r = Math.hypot(pose.east, pose.north);
  if (r === 0) {
    return;
  }
  const ue = pose.east / r;
  const un = pose.north / r;
  pose.east += ue * f.drain * t;
  pose.north += un * f.drain * t;
  pose.heave -= 0.5 * f.gravity * t * t;
  const tip = f.tip[0] + f.tip[1] * t;
  // Tipped outward: the bow down as far as it points out, the outer side
  // down as far as the beam does.
  const ahead = Math.sin(pose.heading) * ue + Math.cos(pose.heading) * un;
  const beam = Math.cos(pose.heading) * ue - Math.sin(pose.heading) * un;
  pose.pitch -= tip * ahead;
  pose.heel += tip * beam;
}

/** The fade to the mist over going over: from nothing at start to whole at end, seconds after crossing. */
export const FADE_FROM = 2;
export const FADE_TO = 3;
/** The fade back in at the start, seconds. */
export const FADE_IN = 1;

/** How much of the screen is the mist t seconds after going over; at once with reduced motion. */
export function fadeOver(t: number, reducedMotion: boolean): number {
  if (reducedMotion) {
    return t >= 0 ? 1 : 0;
  }
  return Math.min(Math.max((t - FADE_FROM) / (FADE_TO - FADE_FROM), 0), 1);
}

/**
 * A voyage's approaches to the lip, followed as the server follows them:
 * one begins as the boat enters the mist band and is survived once it is
 * clear distance back out of it.
 */
export class ApproachWatch {
  /** The band's width inside the lip, m, and that plus the clear distance. */
  readonly #band: number;
  readonly #clear: number;
  readonly #lip: number;
  approaching = false;
  least = 0;

  constructor(lip: number, bandFrom: number, clear: number) {
    this.#lip = lip;
    this.#band = lip - bandFrom;
    this.#clear = this.#band + clear;
  }

  /**
   * Follows the boat at (east, north); returns the least distance of an
   * approach it has just survived, or null.
   */
  follow(east: number, north: number): number | null {
    const d = this.#lip - Math.hypot(east, north);
    if (!this.approaching) {
      if (d < this.#band) {
        this.approaching = true;
        this.least = d;
      }
      return null;
    }
    if (d >= this.#clear) {
      this.approaching = false;
      return this.least;
    }
    this.least = Math.min(this.least, d);
    return null;
  }

  /** A voyage's end over the lip: the approach under way is not survived. */
  over(): void {
    this.approaching = false;
  }
}
