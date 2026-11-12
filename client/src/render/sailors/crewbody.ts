// SPDX-License-Identifier: AGPL-3.0-only

// One person of a crew, posed on the CPU for the GPU to skin (crewlevel.ts):
// a clip at a time, placed in the boat's model, or two such blended (one
// pose going over into another, or sitting up and leaning out); bent
// forward at the waist as far as a duck asks, to keep the head under a
// boom; and the life layers over it (layers.ts: breathing, a slow sway,
// glances, blinks, the body kept nearer upright than the boat as she
// heels), each person's own from their seed. Its bones' matrices, from the
// figure's bind pose to the boat's model, are written as rows of twelve
// floats a bone, as the fleet's near sailors' are. Allocation-free once
// made.

import { Matrix4, Quaternion, Vector3 } from 'three';
import { type Clip, Pose } from './clips';
import type { DeckLook } from './fleetlooks';
import { twoBone } from './ik';
import { Layers, type SailorLayers } from './layers';
import { MachineLayers } from './machinelayers';
import { Rig } from './rig';

/**
 * A pose to be in: a clip at a time (null, the skeleton's rest), placed in
 * the boat's model: the figure's origin at `at`, its +z turned by yaw about
 * the vertical (the figure faces (sin yaw, 0, cos yaw)), and the rest of
 * its place's turn (tilt) under that.
 */
export interface Stance {
  clip: Clip | null;
  t: number;
  at: Vector3;
  yaw: number;
  tilt: Quaternion;
}

/** A stance with nothing set: to be filled. */
export function stance(): Stance {
  return { clip: null, t: 0, at: new Vector3(), yaw: 0, tilt: new Quaternion() };
}

const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const foot = new Vector3();
/** How far in, of their spread, a narrow deck brings the knees, feet and hands; the hands further by this. */
export const NARROW = 0.7;
const ARM_IN = 0.8;
const v = new Vector3();
const w = new Vector3();
const q = new Quaternion();
const q2 = new Quaternion();
const m = new Matrix4();
const m2 = new Matrix4();
const m3 = new Matrix4();
const inv = new Matrix4();
const ONE = new Vector3(1, 1, 1);

/** A stance's place set from a matrix (from the figure to the boat's model), its clip and time kept. */
export function placeStance(s: Stance, place: Matrix4): Stance {
  place.decompose(s.at, q, w);
  // The figure's +z, turned, seen from above: its yaw.
  v.set(0, 0, 1).applyQuaternion(q);
  s.yaw = Math.atan2(v.x, v.z);
  s.tilt.setFromAxisAngle(Y, -s.yaw).multiply(q);
  return s;
}

/** An angle brought within ±π. */
export function wrap(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

/**
 * The yaw f of the way from a to b: the short way round, or, turning more
 * than a quarter round, by way of a yaw (via, radians): the way that
 * passes it.
 */
export function yawBetween(a: number, b: number, f: number, via: number | null = null): number {
  let d = wrap(b - a);
  // Past a quarter turn either way, by way of via if asked.
  if (via !== null && Math.abs(d) > Math.PI / 2) {
    // The way that passes via: if the short way does not, the long way.
    const toVia = wrap(via - a);
    const passes = d >= 0 ? toVia >= 0 && toVia <= d : toVia <= 0 && toVia >= d;
    if (!passes) {
      d = d >= 0 ? d - 2 * Math.PI : d + 2 * Math.PI;
    }
  }
  return a + d * f;
}

/** How a pose goes over into another. */
export interface Blend {
  /** How far, 0 (the first) to 1 (the other). */
  f: number;
  /** Turning more than a quarter round, by way of this yaw (radians); null, the short way. */
  via: number | null;
  /** How high the place is lifted at the middle, m. */
  arc: number;
  /** How narrow each end goes (0 to 1 of NARROW): the knees, feet and hands brought in, for a narrow deck. */
  narrowA: number;
  narrowB: number;
  /** Whether the feet are carried from where one end has them to where the other does (up, across, down), not swung through between. */
  carry: boolean;
  /** At least how high carried feet go, stepping over something, m in the boat's model; −∞ for no more than a step. */
  top: number;
}

/** A blend with nothing set: the first pose alone. */
export function blend(): Blend {
  return {
    f: 0,
    via: null,
    arc: 0,
    narrowA: 0,
    narrowB: 0,
    carry: false,
    top: Number.NEGATIVE_INFINITY,
  };
}

/** How high a carried foot is lifted over the higher of its ends, m. */
const STEP_UP = 0.08;

/**
 * A foot carried from a to b, f of the way, into out: lifted to over the
 * higher end in the first third, across in the second, set down in the
 * last; so it goes round an edge between, not through it.
 */
function carried(a: Vector3, b: Vector3, f: number, out: Vector3, over: number): Vector3 {
  const top = Math.max(a.y + STEP_UP, b.y + STEP_UP, over);
  const up = smooth3(3 * f);
  const across = smooth3(3 * f - 1);
  const down = smooth3(3 * f - 2);
  out.x = a.x + (b.x - a.x) * across;
  out.z = a.z + (b.z - a.z) * across;
  out.y = f < 2 / 3 ? a.y + (top - a.y) * up : top + (b.y - top) * down;
  return out;
}

/** t into a loop of duration d: within [0, d), before its start too. */
function loopTime(t: number, d: number): number {
  return d > 0 ? ((t % d) + d) % d : 0;
}

function smooth3(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** The bones a duck bends, and each one's share of it. */
const DUCK: readonly [string, number][] = [
  ['spine_01', 0.4],
  ['spine_02', 0.3],
  ['spine_03', 0.2],
  ['neck_01', 0.1],
];
/** A leg's reach in the plumb's solve, of its length: past the soft limit's ease, so a pose the leg had is solved exactly. */
const PLUMB_REACH = 1.09;
/** How far a full duck lowers someone walking, m: the knees bent more. */
export const DUCK_DROP = 0.08;
/** How much of a step's lift a full duck takes away from someone walking under a boom. */
export const STEP_LOW = 0.8;
/** How far a full duck bends the back forward, radians. */
export const DUCK_ANGLE = (70 * Math.PI) / 180;

/** What the layers need of the moment, besides the time. */
export interface Life {
  dt: number;
  /** The boat's heel, radians, and whether the body keeps itself upright against it (seated, 0.5) or goes with the boat (0). */
  heel: number;
  upright: number;
  /** Under reduced motion: breathing only. */
  still: boolean;
  /**
   * Up, in the boat model's frame, for a figure kept plumb as she heels and
   * pitches: the figure turned about the point between its feet to stand
   * along it, the feet kept where they were; null or not given, it goes
   * with the boat.
   */
  plumb?: Vector3 | null;
}

export class CrewBody {
  readonly rig: Rig;
  /** Twelve floats a bone: the first three rows of its matrix from the bind pose to the boat's model. */
  readonly bones: Float32Array;
  /** The head's joint and the neck's, in the boat's model, as last posed; and the head's as it would be without the duck. */
  readonly head = new Vector3();
  readonly headUp = new Vector3();
  readonly neck = new Vector3();
  /** The place last posed at: from the figure's space to the model's. */
  readonly root = new Matrix4();
  readonly #inverse: Float32Array;
  readonly #layers: SailorLayers;
  readonly #a: Pose;
  readonly #b: Pose;
  readonly #duck: [number, number][];
  readonly #headBone: number;
  readonly #neckBone: number;
  readonly #heelAxis = new Vector3();
  /** The legs and arms: root, middle and end bones, and whether a leg; the legs alone; and each end's feet. */
  readonly #limbs: [number, number, number, boolean][] = [];
  readonly #legs: [number, number, number][] = [];
  readonly #feetA = [new Vector3(), new Vector3()];
  readonly #feetB = [new Vector3(), new Vector3()];
  #time = 0;

  constructor(deck: DeckLook, seed: number, machine: boolean) {
    const t = deck.rig;
    this.rig = new Rig(t.names, t.parent, t.restPos, t.restQuat);
    this.rig.base.copy(t.base);
    this.#inverse = deck.inverse;
    const n = this.rig.names.length;
    this.bones = new Float32Array(12 * n);
    this.#a = new Pose(n).rest(this.rig);
    this.#b = new Pose(n).rest(this.rig);
    this.#layers = machine ? new MachineLayers(this.rig, seed) : new Layers(this.rig, seed);
    this.#duck = DUCK.map(
      ([name, share]) => [this.rig.bone(name), share] as [number, number],
    ).filter(([b]) => b >= 0);
    this.#headBone = this.rig.bone('head');
    for (const sd of ['l', 'r']) {
      const bones = [`thigh_${sd}`, `calf_${sd}`, `foot_${sd}`].map((b) => this.rig.bone(b));
      if (bones.every((b) => b >= 0)) {
        this.#limbs.push([bones[0] as number, bones[1] as number, bones[2] as number, true]);
        this.#legs.push([bones[0] as number, bones[1] as number, bones[2] as number]);
      }
      const arm = [`upperarm_${sd}`, `lowerarm_${sd}`, `hand_${sd}`].map((b) => this.rig.bone(b));
      if (arm.every((b) => b >= 0)) {
        this.#limbs.push([arm[0] as number, arm[1] as number, arm[2] as number, false]);
      }
    }
    this.#neckBone = this.rig.bone('neck_01');
  }

  /**
   * Poses the body: stance a, going over into b as the blend says (b null,
   * a alone); bent forward by duck (0 to 1 of DUCK_ANGLE); the life layers
   * over it. Its bones' rows written.
   */
  pose(a: Stance, b: Stance | null, blend: Blend, duck: number, life: Life): void {
    const rig = this.rig;
    const pa = this.#a;
    pa.rest(rig);
    if (a.clip !== null) {
      a.clip.sample(loopTime(a.t, a.clip.duration), pa);
    }
    const g = b === null ? 0 : Math.max(0, Math.min(1, blend.f));
    const carry = b !== null && blend.carry && g > 0 && g < 1;
    if (b !== null && g > 0) {
      const pb = this.#b;
      pb.rest(rig);
      if (b.clip !== null) {
        b.clip.sample(loopTime(b.t, b.clip.duration), pb);
      }
      if (carry) {
        // Where each end has its feet, in the boat's model.
        this.#feetOf(pa, a, blend.narrowA, this.#feetA);
        this.#feetOf(pb, b, blend.narrowB, this.#feetB);
      }
      pa.mix(pb, g);
    }
    // The place: the yaw by the way asked, the rest of the turn between.
    if (b === null || g <= 0) {
      v.copy(a.at);
      q2.setFromAxisAngle(Y, a.yaw).multiply(a.tilt);
    } else {
      v.lerpVectors(a.at, b.at, g);
      v.y += blend.arc * Math.sin(Math.PI * g);
      const yaw = yawBetween(a.yaw, b.yaw, g, blend.via);
      q.copy(a.tilt).slerp(b.tilt, g);
      q2.setFromAxisAngle(Y, yaw).multiply(q);
    }
    this.root.compose(v, q2, ONE);
    pa.to(rig);
    rig.fk();
    const narrow = b === null ? blend.narrowA : blend.narrowA + (blend.narrowB - blend.narrowA) * g;
    if (narrow > 0) {
      this.#narrow(Math.min(1, narrow));
    }
    const low = Math.min(1, duck) * (blend.carry ? 1 : Math.min(1, narrow));
    if (low > 0) {
      // Moving about under a boom: lower still, the knees bent more, the feet where they were.
      this.#legs.forEach(([, , foot], k) => {
        rig.position(foot, this.#feetA[k] as Vector3).applyMatrix4(this.root);
      });
      this.root.elements[13] = (this.root.elements[13] as number) - DUCK_DROP * low;
      if (!carry && this.#feetA.length === 2) {
        // A step kept low: the foot in the air nearer the deck, its knee lower.
        const [f0, f1] = this.#feetA as [Vector3, Vector3];
        const floor = Math.min(f0.y, f1.y);
        for (const f of this.#feetA) {
          f.y = floor + (f.y - floor) * (1 - STEP_LOW * low);
        }
      }
      inv.copy(this.root).invert();
      this.#legs.forEach(([thigh, calf, foot], k) => {
        twoBone(rig, thigh, calf, foot, w.copy(this.#feetA[k] as Vector3).applyMatrix4(inv));
      });
    }
    if (carry) {
      // The feet carried from one end's to the other's: up, across, down.
      inv.copy(this.root).invert();
      this.#legs.forEach(([thigh, calf, foot], k) => {
        carried(this.#feetA[k] as Vector3, this.#feetB[k] as Vector3, g, w, blend.top).applyMatrix4(
          inv,
        );
        twoBone(rig, thigh, calf, foot, w);
      });
    }
    const up = life.plumb ?? null;
    if (up !== null && !carry && this.#legs.length === 2 && up.y < 1 - 1e-9) {
      this.#plumb(up);
    }
    if (this.#headBone >= 0) {
      rig.position(this.#headBone, this.headUp).applyMatrix4(this.root);
    }
    // Ducked: the back bent forward, the head down.
    if (duck > 0) {
      for (const [bone, share] of this.#duck) {
        q.setFromAxisAngle(X, DUCK_ANGLE * share * Math.min(1, duck));
        rig.turn(bone, q);
      }
      rig.fk();
    }
    // The life over it.
    this.#time += Math.max(0, life.dt);
    this.#heelAxis.set(0, 0, 1).applyQuaternion(q.copy(q2).invert());
    this.#layers.apply({
      dt: life.dt,
      time: this.#time,
      effort: 0,
      heelAxis: this.#heelAxis,
      heel: life.heel,
      upright: life.upright,
      still: life.still,
    });
    this.#write();
  }

  /**
   * The figure turned about the point between its feet to stand along up
   * (in the boat's model), the feet put back where they were by the legs.
   */
  #plumb(up: Vector3): void {
    const rig = this.rig;
    // Each foot where it is, and how far its hip is from it.
    const reach = this.#reach;
    this.#legs.forEach(([thigh, , foot], k) => {
      rig.position(foot, this.#feetA[k] as Vector3).applyMatrix4(this.root);
      reach[k] = rig
        .position(thigh, v)
        .applyMatrix4(this.root)
        .distanceTo(this.#feetA[k] as Vector3);
    });
    const [f0, f1] = this.#feetA as [Vector3, Vector3];
    v.set((f0.x + f1.x) / 2, Math.min(f0.y, f1.y), (f0.z + f1.z) / 2);
    q.setFromUnitVectors(Y, up);
    m.makeTranslation(v.x, v.y, v.z)
      .multiply(m2.makeRotationFromQuaternion(q))
      .multiply(m3.makeTranslation(-v.x, -v.y, -v.z));
    this.root.premultiply(m);
    // Lowered as far as a hip has come further from its foot than it was:
    // the knees a little more bent, both feet where they were.
    let drop = 0;
    this.#legs.forEach(([thigh], k) => {
      rig.position(thigh, v).applyMatrix4(this.root);
      drop = Math.max(drop, v.distanceTo(this.#feetA[k] as Vector3) - (reach[k] as number));
    });
    if (drop > 0) {
      m.makeTranslation(-up.x * drop, -up.y * drop, -up.z * drop);
      this.root.premultiply(m);
    }
    inv.copy(this.root).invert();
    // Solved exactly, never eased short: each leg reaches no further than it did.
    this.#legs.forEach(([thigh, calf, foot], k) => {
      twoBone(
        rig,
        thigh,
        calf,
        foot,
        w.copy(this.#feetA[k] as Vector3).applyMatrix4(inv),
        1,
        PLUMB_REACH,
      );
    });
  }

  readonly #reach = [0, 0];

  /** Not drawn: every bone folded to a point (gone on a ladder or aloft). */
  hide(): void {
    this.bones.fill(0);
  }

  /** Where a pose, at a stance, brought in by narrow, has its feet: into out, in the boat's model. */
  #feetOf(pose: Pose, at: Stance, narrow: number, out: Vector3[]): void {
    const rig = this.rig;
    pose.to(rig);
    rig.fk();
    if (narrow > 0) {
      this.#narrow(Math.min(1, narrow));
    }
    m3.compose(at.at, q.setFromAxisAngle(Y, at.yaw).multiply(at.tilt), ONE);
    this.#legs.forEach(([, , foot], k) => {
      rig.position(foot, out[k] as Vector3).applyMatrix4(m3);
    });
  }

  /**
   * The knees and hands brought in toward the middle (each limb turned in
   * at its root, about the figure's forward axis), and the feet set down
   * where they were, as far in: by n of NARROW.
   */
  #narrow(n: number): void {
    const rig = this.rig;
    const k = 1 - NARROW * n;
    for (const limb of this.#limbs) {
      const [root, mid, end, leg] = limb;
      rig.position(root, v);
      rig.position(mid, w);
      // The joint's way out from the root, turned in about the forward axis.
      const dx = w.x - v.x;
      const dy = w.y - v.y;
      const angle = Math.atan2(dx * k, -dy) - Math.atan2(dx, -dy);
      if (Math.abs(angle) > 1e-5) {
        q.setFromAxisAngle(Z, angle);
        rig.turn(root, q);
        rig.fk();
      }
      // The foot back on the deck where it was, but further in; the hand
      // brought in as far.
      rig.position(end, foot);
      foot.x *= leg ? k : k * ARM_IN;
      twoBone(rig, root, mid, end, foot);
    }
  }

  #write(): void {
    const rig = this.rig;
    const out = this.bones;
    const inverse = this.#inverse;
    for (let j = 0; j < rig.names.length; j++) {
      m.fromArray(rig.world, 16 * j);
      m2.fromArray(inverse, 16 * j);
      m.premultiply(this.root).multiply(m2);
      const e = m.elements;
      const o = 12 * j;
      out[o] = e[0] as number;
      out[o + 1] = e[4] as number;
      out[o + 2] = e[8] as number;
      out[o + 3] = e[12] as number;
      out[o + 4] = e[1] as number;
      out[o + 5] = e[5] as number;
      out[o + 6] = e[9] as number;
      out[o + 7] = e[13] as number;
      out[o + 8] = e[2] as number;
      out[o + 9] = e[6] as number;
      out[o + 10] = e[10] as number;
      out[o + 11] = e[14] as number;
    }
    if (this.#headBone >= 0) {
      rig.position(this.#headBone, this.head).applyMatrix4(this.root);
    }
    if (this.#neckBone >= 0) {
      rig.position(this.#neckBone, this.neck).applyMatrix4(this.root);
    }
  }
}
