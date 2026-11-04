// SPDX-License-Identifier: AGPL-3.0-only

// The life a sailor has over the clips: breathing (12 to 20 breaths a
// minute, in to out 1:2, faster after hiking), a slow sway (0.1 to 0.5 Hz),
// glances about with the eyes leading the head, blinks, and the body kept
// nearer upright than the boat as she heels. Each sailor's own rates and
// phases come from its seed, so a fleet is never in step. All of it turns
// bones in the figure's space after the clips; nothing allocates.

import { Quaternion, Vector3 } from 'three';
import type { Rig } from './rig';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const q = new Quaternion();
const axis = new Vector3();

const DEG = Math.PI / 180;

/** A small random generator, the same sequence for the same seed. */
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** What the layers need of the sailor's moment. */
export interface LayerInput {
  dt: number;
  /** Seconds since the sailor was made. */
  time: number;
  /** How hard the sailor has been working (hiking), 0 to 1. */
  effort: number;
  /** The boat's heel against the figure: its fore-and-aft axis in the figure's space, and the angle, radians. */
  heelAxis: Vector3;
  heel: number;
  /** Whether the body keeps itself upright (seated or hiking), or goes with the boat. */
  upright: number;
  /** Under reduced motion: breathing only. */
  still: boolean;
}

export class Layers {
  readonly #rand: () => number;
  readonly #breath: number;
  #breathPhase = 0;
  readonly #sway: Float32Array;
  #look = 0;
  #lookTo = 0;
  #lookV = 0;
  #eyes = 0;
  #nextLook = 2;
  #blink = -1;
  #nextBlink = 3;
  readonly #b: Record<string, number>;

  constructor(
    readonly rig: Rig,
    seed: number,
  ) {
    this.#rand = random(seed);
    const r = this.#rand;
    // 12 to 20 breaths a minute.
    this.#breath = (12 + 8 * r()) / 60;
    this.#breathPhase = r();
    // Two slow sways a side and fore-and-aft: their frequencies and phases.
    this.#sway = Float32Array.from([
      0.1 + 0.15 * r(),
      0.25 + 0.25 * r(),
      2 * Math.PI * r(),
      2 * Math.PI * r(),
    ]);
    this.#nextLook = 1 + 4 * r();
    this.#nextBlink = 2 + 4 * r();
    const names = [
      'pelvis',
      'spine_01',
      'spine_02',
      'spine_03',
      'neck_01',
      'head',
      'clavicle_l',
      'clavicle_r',
      'eye_l',
      'eye_r',
      'lid_upper_l',
      'lid_upper_r',
    ];
    this.#b = Object.fromEntries(names.map((n) => [n, rig.bone(n)]));
  }

  /** Turns the rig's bones (posed by the clips, fk() run) by the layers. */
  apply(i: LayerInput): void {
    const rig = this.rig;
    const b = this.#b;
    const dt = Math.max(0, Math.min(i.dt, 0.1));

    // Breathing: in for a third of the breath, out for the rest; faster
    // and deeper after work.
    const rate = this.#breath * (1 + 0.8 * i.effort);
    this.#breathPhase = (this.#breathPhase + rate * dt) % 1;
    const ph = this.#breathPhase;
    const breath = ph < 1 / 3 ? smooth(ph * 3) : 1 - smooth((ph - 1 / 3) * 1.5);
    const depth = 1 + 0.6 * i.effort;
    this.#turn(b.spine_03, X, -1.4 * DEG * breath * depth);
    this.#turn(b.clavicle_l, axis.set(0, 0, 1), 1.2 * DEG * breath * depth);
    this.#turn(b.clavicle_r, axis.set(0, 0, 1), -1.2 * DEG * breath * depth);
    if (i.still) {
      rig.fk();
      return;
    }

    // The body kept nearer upright than the boat as she heels.
    if (i.upright > 0 && Math.abs(i.heel) > 1e-4) {
      const k = i.upright * i.heel;
      this.#turn(b.spine_01, i.heelAxis, 0.18 * k);
      this.#turn(b.spine_02, i.heelAxis, 0.12 * k);
      this.#turn(b.spine_03, i.heelAxis, 0.06 * k);
      this.#turn(b.neck_01, i.heelAxis, 0.12 * k);
    }

    // A slow sway.
    const sw = this.#sway;
    const f1 = sw[0] as number;
    const f2 = sw[1] as number;
    const a1 = sw[2] as number;
    const a2 = sw[3] as number;
    const t = i.time;
    this.#turn(b.spine_01, axis.set(0, 0, 1), 0.9 * DEG * Math.sin(2 * Math.PI * f1 * t + a1));
    this.#turn(b.spine_01, X, 0.6 * DEG * Math.sin(2 * Math.PI * f2 * t + a2));

    // Glances: a new one every few seconds, the eyes there first and the
    // head after, through a lightly damped spring.
    this.#nextLook -= dt;
    if (this.#nextLook <= 0) {
      this.#lookTo = (this.#rand() * 2 - 1) * 14 * DEG;
      this.#nextLook = 2 + 4 * this.#rand();
      if (Math.abs(this.#lookTo - this.#look) > 10 * DEG) {
        // A large glance brings a blink with it.
        this.#nextBlink = Math.min(this.#nextBlink, 0.03);
      }
    }
    const w = 2 * Math.PI * 1.6;
    const acc = w * w * (this.#lookTo - this.#look) - 2 * 0.8 * w * this.#lookV;
    this.#lookV += acc * dt;
    this.#look += this.#lookV * dt;
    // The eyes lead by about 30 ms.
    this.#eyes += (this.#lookTo - this.#eyes) * Math.min(1, dt / 0.03);
    this.#turn(b.neck_01, Y, 0.35 * this.#look);
    this.#turn(b.head, Y, 0.65 * this.#look);
    const ahead = this.#eyes - this.#look;
    this.#turn(b.eye_l, Y, ahead);
    this.#turn(b.eye_r, Y, ahead);

    // Blinks every 2 to 6 s: closing in 0.1 s, opening in 0.2.
    this.#nextBlink -= dt;
    if (this.#nextBlink <= 0 && this.#blink < 0) {
      this.#blink = 0;
      this.#nextBlink = 2 + 4 * this.#rand();
    }
    if (this.#blink >= 0) {
      this.#blink += dt;
      const shut = this.#blink < 0.1 ? this.#blink / 0.1 : 1 - (this.#blink - 0.1) / 0.2;
      if (this.#blink > 0.3) {
        this.#blink = -1;
      } else {
        this.#turn(b.lid_upper_l, X, BLINK * Math.max(0, shut));
        this.#turn(b.lid_upper_r, X, BLINK * Math.max(0, shut));
      }
    }
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

/** How far an upper lid turns down to close, radians. */
export const BLINK = 22 * DEG;

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
