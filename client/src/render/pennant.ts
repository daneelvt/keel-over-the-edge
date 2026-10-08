// SPDX-License-Identifier: AGPL-3.0-only

// The pennant at the masthead. It streams downwind of the apparent wind at
// the masthead, as the physics computes it, so it shows the wind across the
// moving boat: level in a breeze, drooping toward the mast as the wind
// dies, fluttering faster as it rises.

import { cos, Fn, normalLocal, positionGeometry, sin, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { RECORDS } from '../predict/layout.gen';

/** Above this apparent wind, in m/s, the pennant flies level; below DROOP_BELOW it hangs. */
const LEVEL_ABOVE = 4;
const DROOP_BELOW = 1;
/** The most it hangs below level, radians. */
const MOST_DROOP = 1.35;
/** Seconds over which the pennant turns to a new wind. */
const EASE = 0.12;

export interface PennantPose {
  /** The pennant's turn about the mast from streaming aft, radians, positive toward starboard. */
  yaw: number;
  /** How far it hangs below level, radians. */
  droop: number;
  /** Flutter waves a second along it. */
  rate: number;
  /** The flutter's size, as a fraction of its length. */
  flutter: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * The pose for an apparent wind of speed (m/s) from angle (radians off the
 * bow, positive from starboard): streaming the way the wind blows.
 */
export function pennantPose(angle: number, speed: number, out: PennantPose): PennantPose {
  out.yaw = -angle;
  out.droop = MOST_DROOP * (1 - smoothstep(DROOP_BELOW, LEVEL_ABOVE, speed));
  out.rate = 1.5 + 0.9 * speed;
  out.flutter = 0.04 + 0.1 * smoothstep(0.5, 6, speed);
  return out;
}

export class Pennant {
  readonly yaw = uniform(0);
  readonly droop = uniform(MOST_DROOP);
  readonly phase = uniform(0);
  readonly flutter = uniform(0.04);
  readonly #pose: PennantPose = { yaw: 0, droop: MOST_DROOP, rate: 1.5, flutter: 0.04 };
  #yaw = 0;
  #droop = MOST_DROOP;

  /** Turns the pennant toward Out's apparent wind; dt is world time, which pauses with the game. */
  update(out: Float64Array, dt: number): void {
    const p = pennantPose(
      out[RECORDS.out.apparentWindAngle] ?? 0,
      out[RECORDS.out.apparentWindSpeed] ?? 0,
      this.#pose,
    );
    const f = dt > 0 ? 1 - Math.exp(-dt / EASE) : 0;
    let d = (p.yaw - this.#yaw) % (2 * Math.PI);
    if (d > Math.PI) {
      d -= 2 * Math.PI;
    } else if (d < -Math.PI) {
      d += 2 * Math.PI;
    }
    this.#yaw += d * f;
    this.#droop += (p.droop - this.#droop) * f;
    this.yaw.value = this.#yaw;
    this.droop.value = this.#droop;
    this.flutter.value = p.flutter;
    this.phase.value = (this.phase.value + dt * p.rate * 2 * Math.PI) % (2 * Math.PI * 64);
  }

  /** Points it at once (after a reset, and for pictures). */
  snap(out: Float64Array): void {
    this.#yaw = -(out[RECORDS.out.apparentWindAngle] ?? 0);
    this.#droop = pennantPose(0, out[RECORDS.out.apparentWindSpeed] ?? 0, this.#pose).droop;
    this.update(out, 0);
  }

  /**
   * The vertex node: a flutter wave across the strip growing toward the
   * tip, the droop about the staff, then the turn about the mast.
   */
  node(): Node<'vec3'> {
    return Fn(() => {
      const f = uv(1).x;
      const p = positionGeometry;
      const wave = sin(f.mul(11).sub(this.phase)).mul(this.flutter).mul(f).mul(p.z.add(0.05));
      // Droop: turn the strip down about the staff (about x), the tip going down.
      const cd = cos(this.droop);
      const sd = sin(this.droop);
      const y = p.y.mul(cd).sub(p.z.mul(sd));
      const z = p.y.mul(sd).add(p.z.mul(cd));
      // Then about the mast (about y).
      const cy = cos(this.yaw);
      const sy = sin(this.yaw);
      normalLocal.assign(vec3(cy, 0, sy.negate()));
      return vec3(wave.mul(cy).add(z.mul(sy)), y, z.mul(cy).sub(wave.mul(sy)));
    })() as unknown as Node<'vec3'>;
  }
}
