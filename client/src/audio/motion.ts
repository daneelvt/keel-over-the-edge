// SPDX-License-Identifier: AGPL-3.0-only

// The sounds the boat's own motion makes once, from the physics: a slap as
// the bow meets a wave, the sheet running out through its block in a tack,
// and the boom's thump in a gybe. Each watch is given the boat's state as
// the sound is set, and says when one is due and how loud.
//
// The bow meets a wave as it stops falling: its pitch rate, which falls
// (negative, bow down) as the bow drops into a trough, turns and rises as
// the next wave lifts it. The harder it was falling, the harder the slap;
// and the faster the hull was dropping as it turned (its heave rate, down)
// the more of the slap's weight is in it.
//
// The sail crosses the boat in a tack and in a gybe alike: the boom passes
// the centreline. A tack brings the wind across the bow, so the apparent
// wind is forward of the beam as it crosses, and the sheet runs; a gybe
// brings it across the stern, and the boom slams over, the harder the
// faster it swings.

import type { MixRecipe } from './mix';

/** 0 below from, rising smoothly to 1 at full. */
function ramp(from: number, full: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (full - from)));
  return t * t * (3 - 2 * t);
}

/** A slap due: its level, a gain, and its count, which varies it. */
export interface Slap {
  level: number;
  seed: number;
}

/** Watches the boat's pitch for the bow meeting a wave. */
export class SlapWatch {
  readonly #r: MixRecipe['slaps'];
  /** Whether the bow is falling, the fastest it fell and the hull dropped meanwhile (rad/s, m/s, as positive numbers). */
  #falling = false;
  #fell = 0;
  #dropped = 0;
  #last = Number.NEGATIVE_INFINITY;
  count = 0;

  constructor(r: MixRecipe['slaps']) {
    this.#r = r;
  }

  /** The boat's pitch rate (rad/s, bow up) and heave rate (m/s, up) at time t, s: a slap, if one is due. */
  step(pitchRate: number, heaveRate: number, t: number): Slap | null {
    const r = this.#r;
    if (!Number.isFinite(pitchRate) || !Number.isFinite(heaveRate)) {
      return null;
    }
    if (pitchRate < 0) {
      if (!this.#falling) {
        this.#falling = true;
        this.#fell = 0;
        this.#dropped = 0;
      }
      this.#fell = Math.max(this.#fell, -pitchRate);
      this.#dropped = Math.max(this.#dropped, -heaveRate);
      return null;
    }
    if (!this.#falling) {
      return null;
    }
    this.#falling = false;
    const fell = ramp(r.pitchRate[0] ?? 0.05, r.pitchRate[1] ?? 0.3, this.#fell);
    if (!(fell > 0) || t - this.#last < r.least) {
      return null;
    }
    this.#last = t;
    const dropped = ramp(r.heaveRate[0] ?? 0.1, r.heaveRate[1] ?? 0.8, this.#dropped);
    this.count++;
    return { level: r.level * fell * (1 - r.heave + r.heave * dropped), seed: this.count };
  }
}

/** What crossing the boat sounds like: the sheet running in a tack, the boom's thump in a gybe. */
export interface SailSound {
  kind: 'sheet' | 'boom';
  level: number;
  seed: number;
}

/** Watches the boom for the sail crossing the boat. */
export class SailWatch {
  readonly #r: MixRecipe['sail'];
  /** The side the boom was last clearly on: 1 starboard, −1 port, 0 not yet seen. */
  #side = 0;
  count = 0;

  constructor(r: MixRecipe['sail']) {
    this.#r = r;
  }

  /**
   * The boom's angle off the centreline (rad, positive to starboard) and its
   * rate (rad/s), the apparent wind's angle off the bow (rad, either sign)
   * and speed (m/s): a sound, if the boom has just crossed.
   */
  step(
    boom: number,
    boomRate: number,
    apparentAngle: number,
    apparentWind: number,
  ): SailSound | null {
    const r = this.#r;
    if (!Number.isFinite(boom)) {
      return null;
    }
    // Clearly on a side only past the dead band, so a boom hanging on the
    // centreline does not tick.
    const side = boom > r.side ? 1 : boom < -r.side ? -1 : 0;
    if (side === 0) {
      return null;
    }
    const was = this.#side;
    this.#side = side;
    if (was === 0 || was === side) {
      return null;
    }
    this.count++;
    const across = Math.abs(apparentAngle) * (180 / Math.PI);
    if (across < r.tack) {
      const level =
        r.sheet.level *
        (0.35 + 0.65 * ramp(r.sheet.wind[0] ?? 2, r.sheet.wind[1] ?? 10, apparentWind));
      return { kind: 'sheet', level, seed: this.count };
    }
    const swing = ramp(r.boom.rate[0] ?? 0.3, r.boom.rate[1] ?? 2.5, Math.abs(boomRate));
    if (!(swing > 0)) {
      return null;
    }
    return { kind: 'boom', level: r.boom.level * swing, seed: this.count };
  }
}
