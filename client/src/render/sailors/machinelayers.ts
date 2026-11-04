// SPDX-License-Identifier: AGPL-3.0-only

// A machine's life over the clips, in place of a person's (layers.ts): it
// does not breathe or sway; it keeps its body nearer upright than the boat
// as she heels, as a sailor does; it looks about in small snapped steps,
// the head jumping a few degrees and holding, its ear discs turning to
// each new bearing a moment before the head; and its lamps (the eyes and
// the lantern at its nape) pulse slowly, never in step with another's.
// Each machine's rates and phases come from its seed. Nothing allocates.

import { Quaternion, Vector3 } from 'three';
import { type LayerInput, random, type SailorLayers } from './layers';
import type { Rig } from './rig';

const Y = new Vector3(0, 1, 0);
const q = new Quaternion();
const DEG = Math.PI / 180;

/** How far a glance goes either way, and how far one step of it turns. */
export const GLANCE = 20 * DEG;
export const STEP = 7 * DEG;
/** A step's snap, seconds, and the hold after it. */
export const SNAP = 0.09;
const HOLD = [0.25, 0.6] as const;
/** Seconds between glances. */
const BETWEEN = [2.5, 6] as const;
/** How much further than the head the ear discs turn on to a new bearing. */
const EARS = 1.6;
/** The lamps' pulse: its least strength and its period, seconds. */
const PULSE_LOW = 0.72;
const PULSE = [3, 5] as const;

export class MachineLayers implements SailorLayers {
  /** The lamps' strength now, 0 to 1. */
  glow = 1;
  readonly #rand: () => number;
  readonly #b: Record<string, number>;
  readonly #period: number;
  readonly #phase: number;
  #nextGlance: number;
  #target = 0;
  /** The head's bearing: the step it is on, from and to, and the time in it. */
  #from = 0;
  #to = 0;
  #t = SNAP;
  #hold = 0;

  constructor(
    readonly rig: Rig,
    seed: number,
  ) {
    this.#rand = random(seed);
    const r = this.#rand;
    this.#period = PULSE[0] + (PULSE[1] - PULSE[0]) * r();
    this.#phase = r();
    this.#nextGlance = 1 + BETWEEN[1] * r();
    const names = [
      'spine_01',
      'spine_02',
      'spine_03',
      'neck_01',
      'head',
      'lid_lower_l',
      'lid_lower_r',
    ];
    this.#b = Object.fromEntries(names.map((n) => [n, rig.bone(n)]));
  }

  /** The head's bearing now, radians, + to the figure's left. */
  get bearing(): number {
    return this.#from + (this.#to - this.#from) * smooth(this.#t / SNAP);
  }

  apply(i: LayerInput): void {
    const dt = Math.max(0, Math.min(i.dt, 0.1));
    const b = this.#b;
    const rig = this.rig;
    // The lamps.
    const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * (i.time / this.#period + this.#phase));
    this.glow = i.still ? 1 : PULSE_LOW + (1 - PULSE_LOW) * pulse;
    if (i.still) {
      rig.fk();
      return;
    }
    // Kept nearer upright than the boat as she heels.
    if (i.upright > 0 && Math.abs(i.heel) > 1e-4) {
      const k = i.upright * i.heel;
      this.#turn(b.spine_01, i.heelAxis, 0.18 * k);
      this.#turn(b.spine_02, i.heelAxis, 0.12 * k);
      this.#turn(b.spine_03, i.heelAxis, 0.06 * k);
      this.#turn(b.neck_01, i.heelAxis, 0.12 * k);
    }
    // A new bearing now and then, reached in steps.
    this.#nextGlance -= dt;
    if (this.#nextGlance <= 0) {
      this.#target = (this.#rand() * 2 - 1) * GLANCE;
      this.#nextGlance = BETWEEN[0] + (BETWEEN[1] - BETWEEN[0]) * this.#rand();
    }
    this.#t += dt;
    if (this.#t >= SNAP) {
      this.#hold -= dt;
      const left = this.#target - this.#to;
      if (this.#hold <= 0 && Math.abs(left) > 0.5 * DEG) {
        this.#from = this.#to;
        this.#to += Math.max(-STEP, Math.min(STEP, left));
        this.#t = 0;
        this.#hold = HOLD[0] + (HOLD[1] - HOLD[0]) * this.#rand();
      }
    }
    const look = this.bearing;
    this.#turn(b.neck_01, Y, 0.3 * look);
    this.#turn(b.head, Y, 0.7 * look);
    // The ears are on the next bearing first, turned further than the
    // head, and settle with it.
    const ears = EARS * (this.#to - look) + 0.3 * look;
    this.#turn(b.lid_lower_l, Y, ears);
    this.#turn(b.lid_lower_r, Y, ears);
    rig.fk();
  }

  #turn(bone: number | undefined, about: Vector3, angle: number): void {
    if (bone === undefined || bone < 0 || angle === 0) {
      return;
    }
    q.setFromAxisAngle(about, angle);
    this.rig.turn(bone, q);
  }
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
