// SPDX-License-Identifier: AGPL-3.0-only

// How the other boats float. The server sends where each is, which way it
// heads and how it heels, but not its heave or its pitch: every client
// floats the other boats on the waves it draws under them, which are the
// same waves for everyone. A boat's heave and pitch as the server had them
// would come a fraction of a second late, as its position does, while the
// sea is drawn at the present: the boat would sit a quarter of a wave out of
// step with the water under it.
//
// Each boat is given the sea under its hull where and when it is drawn, by
// the physics module (the effective wave: the surface averaged over its
// waterplane, and its slope along the hull), and follows it as the physics
// has a hull follow it: a mass on the spring of its waterplane, damped by
// how fast it moves against the water, with its kind's own stiffness, mass
// and damping. So a dinghy, whose own periods are under a second, stays on
// the surface, and a heavier boat rides it more slowly.

import type { Boat } from '../catalog';
import { VIEW_SLOTS } from '../net/view';
import { RECORDS } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';
import type { DrawnBoat } from './fleet';

/** Sea water's density, kg/m³, and gravity, m/s², as the physics has them. */
const WATER = 1025;
const GRAVITY = 9.81;
/** A frame longer than this is taken in parts, seconds. */
const MAX_STEP = 1 / 120;

/** How a kind of hull follows the water: its natural frequencies, rad/s, and damping, as fractions of critical. */
export interface HullSprings {
  heave: number;
  heaveDamping: number;
  pitch: number;
  pitchDamping: number;
}

/** A kind's springs, from the values the physics floats it by. */
export function hullSprings(kind: Boat): HullSprings {
  const h = kind.physics.hull;
  return {
    heave: Math.sqrt((WATER * GRAVITY * h.waterplaneArea) / (h.displacement + h.addedMassHeave)),
    heaveDamping: h.heaveDamping,
    pitch: Math.sqrt((WATER * GRAVITY * h.waterplanePitch) / h.pitchInertia),
    pitchDamping: h.pitchDamping,
  };
}

/**
 * Moves a value and its rate over dt toward a target that itself moved
 * from `from` to `to` over dt: x″ = −ω²(x − target) − 2ζω(x′ − target′).
 */
function follow(
  x: Float64Array,
  v: Float64Array,
  i: number,
  from: number,
  to: number,
  omega: number,
  damping: number,
  dt: number,
): void {
  if (!(dt > 0)) {
    return;
  }
  const rate = (to - from) / dt;
  const steps = Math.ceil(dt / MAX_STEP);
  const h = dt / steps;
  for (let n = 1; n <= steps; n++) {
    const target = from + rate * (n * h);
    const a = -omega * omega * ((x[i] ?? 0) - target) - 2 * damping * omega * ((v[i] ?? 0) - rate);
    v[i] = (v[i] ?? 0) + a * h;
    x[i] = (x[i] ?? 0) + (v[i] ?? 0) * h;
  }
}

export class Floater {
  readonly #physics: Physics;
  readonly #seas: Seas;
  readonly #kinds: readonly Boat[];
  readonly #springs: readonly HullSprings[];
  /** Each view slot's boat: the water under it in the last frame, and its own heave and pitch. */
  readonly #height = new Float64Array(VIEW_SLOTS);
  readonly #slope = new Float64Array(VIEW_SLOTS);
  readonly #heave = new Float64Array(VIEW_SLOTS);
  readonly #heaveRate = new Float64Array(VIEW_SLOTS);
  readonly #pitch = new Float64Array(VIEW_SLOTS);
  readonly #pitchRate = new Float64Array(VIEW_SLOTS);
  /** Whether each view slot's boat was drawn in the last frame. */
  readonly #afloat = new Uint8Array(VIEW_SLOTS);
  readonly #seen = new Uint8Array(VIEW_SLOTS);

  constructor(physics: Physics, seas: Seas, kinds: readonly Boat[]) {
    this.#physics = physics;
    this.#seas = seas;
    this.#kinds = kinds;
    this.#springs = kinds.map(hullSprings);
  }

  /**
   * Sets the heave and pitch of the boats drawn, drawn[0 … count), on the
   * sea at world time tick, in ticks, dt seconds after the last frame.
   */
  apply(drawn: readonly DrawnBoat[], count: number, tick: number, dt: number): void {
    const p = this.#physics;
    const slot = this.#seas.slotAt(Math.floor(tick) + 1);
    this.#seen.fill(0);
    if (slot >= 0) {
      p.seaDrawAt(tick);
    }
    for (let n = 0; n < count; n++) {
      const b = drawn[n] as DrawnBoat;
      let height = 0;
      let slope = 0;
      const hull = this.#kinds[b.kind]?.physics.hull;
      const k = this.#springs[b.kind];
      if (slot >= 0 && hull !== undefined) {
        const w = p.waveUnder(
          slot,
          b.east,
          b.north,
          b.heading,
          hull.waterlineLength,
          hull.waterlineBeam,
        );
        height = w[RECORDS.wave.height] ?? 0;
        slope = w[RECORDS.wave.ahead] ?? 0;
      }
      const s = b.slot;
      if (s < 0 || s >= VIEW_SLOTS) {
        // Fading out of the view: on the water as it is.
        b.heave = height;
        b.pitch = slope;
        continue;
      }
      this.#seen[s] = 1;
      if (this.#afloat[s] === 0 || k === undefined) {
        // New to the view: on the water, at rest.
        this.#heave[s] = height;
        this.#pitch[s] = slope;
        this.#heaveRate[s] = 0;
        this.#pitchRate[s] = 0;
      } else {
        const was = this.#height[s] ?? 0;
        follow(this.#heave, this.#heaveRate, s, was, height, k.heave, k.heaveDamping, dt);
        const lay = this.#slope[s] ?? 0;
        follow(this.#pitch, this.#pitchRate, s, lay, slope, k.pitch, k.pitchDamping, dt);
      }
      this.#height[s] = height;
      this.#slope[s] = slope;
      b.heave = this.#heave[s] ?? 0;
      b.pitch = this.#pitch[s] ?? 0;
    }
    this.#afloat.set(this.#seen);
  }
}
