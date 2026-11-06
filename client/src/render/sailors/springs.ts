// SPDX-License-Identifier: AGPL-3.0-only

// Springs on a sailor's hanging things: the coat's and waistcoat's skirt
// chains, the hair's queue or braid and the back's spring joints. Each joint
// is a Verlet point at its bone's tail, in the boat's space (so the boat's
// own heel and pitch are felt as the cloth's), pulled toward where the clip
// puts it (the clip keys the skirts lying on the seat when seated), carried
// on by its own speed less a drag, pushed by gravity, the apparent wind and
// the boat's acceleration, kept at its bone's length, and kept out of the
// thighs and hips and off the seat's plane while the sailor sits; then the
// bone turned to point at it. After VRM's spring bone (VRMC_springBone 1.0),
// with the game's own colliders. Allocation-free once made.

import { type Matrix4, Quaternion, Vector3 } from 'three';
import type { Rig } from './rig';

/** The chains, root first; a look moves its spring joints where its hair and tails hang. */
export const CHAINS = [
  ['skirt_front_l_01', 'skirt_front_l_02'],
  ['skirt_front_r_01', 'skirt_front_r_02'],
  ['skirt_side_l_01', 'skirt_side_l_02'],
  ['skirt_side_r_01', 'skirt_side_r_02'],
  ['skirt_back_l_01', 'skirt_back_l_02'],
  ['skirt_back_r_01', 'skirt_back_r_02'],
  ['spring_01', 'spring_02', 'spring_03', 'spring_04'],
  ['spring_05', 'spring_06', 'spring_07', 'spring_08'],
];

/** How each kind of joint moves: its pull home (per second), its drag, how much the wind and gravity move it. */
const SKIRT = { stiffness: 9, drag: 0.35, wind: 0.004, gravity: 0.4 };
const HAIR = { stiffness: 14, drag: 0.3, wind: 0.006, gravity: 0.3 };

/** The colliders' radii, metres: a thigh's capsule and the hips' sphere. */
const THIGH = 0.085;
const HIPS = 0.13;
/** How far over the seat's plane cloth lies. */
const SEAT_CLEAR = 0.012;

/** What the springs feel this frame, in the boat model's space. */
export interface SpringWorld {
  /** Seconds since the last step. */
  dt: number;
  /** Down, as the boat lies (heeled and pitched). */
  down: Vector3;
  /** The apparent wind's velocity (where it blows to, m/s). */
  wind: Vector3;
  /** The boat's acceleration, which the cloth lags. */
  accel: Vector3;
  /** The seat's plane: its height, and whether the sailor sits on it, and on which side (x's sign). */
  seatY: number;
  seated: boolean;
  side: number;
  /** The side deck's inner and outer edges, out from the centreline. */
  seatIn: number;
  seatOut: number;
}

const head = new Vector3();
const anim = new Vector3();
const next = new Vector3();
const vel = new Vector3();
const d = new Vector3();
const e = new Vector3();
const p0 = new Vector3();
const p1 = new Vector3();
const pr = new Quaternion();
const qa = new Quaternion();
const qn = new Quaternion();
const qr = new Quaternion();
const rootQ = new Quaternion();
const from = new Vector3();
const to = new Vector3();
const scratch = new Vector3();
const dummyScale = new Vector3();

export class Springs {
  /** The joints, chain by chain, root first: bone indices; -1 where the skeleton lacks one. */
  readonly #bones: Int32Array;
  /** Where each chain starts in #bones, and how long it is. */
  readonly #chains: Int32Array;
  /** Each joint's tail in its own bone's space at rest (direction times length). */
  readonly #axis: Float32Array;
  readonly #hair: Uint8Array;
  /** Each joint's tail now and a step ago, in the boat's space. */
  readonly #now: Float32Array;
  readonly #then: Float32Array;
  #fresh = true;
  readonly #thighs: Int32Array;
  readonly #knees: Int32Array;
  readonly #pelvis: number;

  constructor(readonly rig: Rig) {
    const bones: number[] = [];
    const chains: number[] = [];
    const axis: number[] = [];
    const hair: number[] = [];
    for (const names of CHAINS) {
      const idx = names.map((n) => rig.bone(n));
      if (idx.some((i) => i < 0)) {
        continue;
      }
      chains.push(bones.length, idx.length);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k] as number;
        bones.push(i);
        hair.push(names[0]?.startsWith('spring') ? 1 : 0);
        // The tail: the next joint's head, or for the last one a length like
        // the one before it, along the bone.
        const child = idx[k + 1];
        if (child !== undefined) {
          axis.push(
            rig.restPos[3 * child] as number,
            rig.restPos[3 * child + 1] as number,
            rig.restPos[3 * child + 2] as number,
          );
        } else {
          const prev = axis.length >= 3 ? Math.hypot(...axis.slice(-3)) : 0.1;
          axis.push(0, prev, 0);
        }
      }
    }
    this.#bones = Int32Array.from(bones);
    this.#chains = Int32Array.from(chains);
    this.#axis = Float32Array.from(axis);
    this.#hair = Uint8Array.from(hair);
    this.#now = new Float32Array(3 * bones.length);
    this.#then = new Float32Array(3 * bones.length);
    this.#thighs = Int32Array.from([rig.bone('thigh_l'), rig.bone('thigh_r')]);
    this.#knees = Int32Array.from([rig.bone('calf_l'), rig.bone('calf_r')]);
    this.#pelvis = rig.bone('pelvis');
  }

  /** The joints put where the clip has them, at rest: after a jump (a new mode, a new place). */
  reset(): void {
    this.#fresh = true;
  }

  /**
   * One step: the rig posed by its clips (and fk() run), root the figure's
   * place in the boat model; the joints' bones turned to their points.
   */
  step(root: Matrix4, w: SpringWorld): void {
    const rig = this.rig;
    const dt = Math.min(Math.max(w.dt, 0), 1 / 20);
    root.decompose(scratch, rootQ, dummyScale);
    for (let c = 0; c < this.#chains.length; c += 2) {
      const start = this.#chains[c] as number;
      const n = this.#chains[c + 1] as number;
      for (let k = start; k < start + n; k++) {
        const j = this.#bones[k] as number;
        const hairy = this.#hair[k] === 1;
        const spec = hairy ? HAIR : SKIRT;
        rig.position(j, head).applyMatrix4(root);
        // Where the clip puts the tail.
        rig.parentRotation(j, pr).premultiply(rootQ);
        qa.fromArray(rig.quat, 4 * j);
        qr.copy(pr).multiply(qa);
        anim.fromArray(this.#axis, 3 * k);
        const length = anim.length();
        anim.applyQuaternion(qr).add(head);
        if (this.#fresh || dt <= 0) {
          anim.toArray(this.#now, 3 * k);
          anim.toArray(this.#then, 3 * k);
          continue;
        }
        next.fromArray(this.#now, 3 * k);
        vel
          .fromArray(this.#then, 3 * k)
          .sub(next)
          .negate()
          .multiplyScalar(1 - spec.drag);
        const pull = 1 - Math.exp(-spec.stiffness * dt);
        d.subVectors(anim, next).multiplyScalar(pull);
        e.copy(w.down)
          .multiplyScalar(9.81 * spec.gravity)
          .addScaledVector(w.wind, w.wind.length() * spec.wind)
          .sub(w.accel)
          .multiplyScalar(dt * dt);
        next.add(vel).add(d).add(e);
        this.#keep(next, head, length);
        this.#collide(next, head, length, w, root);
        this.#then.set(this.#now.subarray(3 * k, 3 * k + 3), 3 * k);
        next.toArray(this.#now, 3 * k);
        // The bone turned from where the clip points it to its point.
        from.subVectors(anim, head).normalize();
        to.subVectors(next, head).normalize();
        qn.setFromUnitVectors(from, to).multiply(qr);
        pr.invert()
          .multiply(qn)
          .normalize()
          .toArray(rig.quat, 4 * j);
        rig.fk();
      }
    }
    this.#fresh = false;
  }

  #keep(p: Vector3, h: Vector3, length: number): void {
    d.subVectors(p, h);
    const l = d.length();
    if (l > 1e-6) {
      p.copy(h).addScaledVector(d, length / l);
    }
  }

  /** Out of the thighs and the hips, and over the seat's plane where the sailor sits. */
  #collide(p: Vector3, h: Vector3, length: number, w: SpringWorld, root: Matrix4): void {
    const rig = this.rig;
    for (let s = 0; s < 2; s++) {
      rig.position(this.#thighs[s] as number, p0).applyMatrix4(root);
      rig.position(this.#knees[s] as number, p1).applyMatrix4(root);
      pushOutOfCapsule(p, p0, p1, THIGH);
    }
    rig.position(this.#pelvis, p0).applyMatrix4(root);
    pushOutOfCapsule(p, p0, p0, HIPS);
    if (w.seated) {
      const out = w.side * p.x;
      if (out > w.seatIn && out < w.seatOut + 0.3 && p.y < w.seatY + SEAT_CLEAR) {
        p.y = w.seatY + SEAT_CLEAR;
      }
    }
    this.#keep(p, h, length);
  }
}

/** Moves p out of a capsule from a to b of radius r, if inside. */
function pushOutOfCapsule(p: Vector3, a: Vector3, b: Vector3, r: number): void {
  e.subVectors(b, a);
  const l2 = e.lengthSq();
  const f = l2 > 1e-12 ? Math.max(0, Math.min(1, scratch.subVectors(p, a).dot(e) / l2)) : 0;
  scratch.copy(a).addScaledVector(e, f);
  e.subVectors(p, scratch);
  const dist = e.length();
  if (dist < r && dist > 1e-6) {
    p.copy(scratch).addScaledVector(e, r / dist);
  }
}

/** The matrix type the step takes, for callers. */
export type { Matrix4 };
