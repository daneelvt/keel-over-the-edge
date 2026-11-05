// SPDX-License-Identifier: AGPL-3.0-only

// A sailor in a boat, moved by the physics: the clips its mode and offset
// call for, blended; the procedural layers over them; the aft hand brought
// to the tiller extension wherever the rudder puts it; the springs; and
// where the figure is in the boat model.
//
// Sailing, the sailor sits at the helm on the side deck it last crossed to,
// the hiking poses blended in as the physics puts it further out, and
// crosses the boat when its side changes (a tack or a gybe), facing forward
// under the boom. In a steady boat it now and then goes through its look's
// habit. After a capsize it treads water at the high side, climbs onto the
// daggerboard and leans back on it, and climbs in over the side as the boat
// comes up, each placed against the hull's solid; a change of mode is
// blended, the figure carried along a path that stays out of the hull.
//
// Everything here is in the boat model's frame (x to starboard, y up, z
// aft), unheeled; the boat's heel turns the model. Allocation-free once
// made.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { CLIMBING, IN_WATER, ON_BOARD } from '../sailor';
import { type Clip, Pose } from './clips';
import { twoBone } from './ik';
import { Layers, random } from './layers';
import type { Rig } from './rig';
import { type HullSolid, reach } from './solid';
import { Springs, type SpringWorld } from './springs';

/** The clips a sailor sails with, by name; the -port ones are the starboard ones' mirror. */
export const CLIPS = {
  helm: 'helm',
  hiking: ['hiking-1', 'hiking-2', 'hiking-3'],
  cross: 'cross',
  habit: 'habit',
  standing: 'standing-idle',
  standingHabit: 'habit-standing',
  water: 'treading-water',
  board: 'righting',
  climb: 'climbing-in',
} as const;
const PORT = '-port';
/** The helm and the hiking depths, blended by how far out the sailor is. */
const SEATED: readonly string[] = [CLIPS.helm, ...CLIPS.hiking];

/** Where the hiking poses come in: from this far out (m) to fully out at HIKE_FULL. */
const HIKE_FROM = 0.55;
const HIKE_FULL = 0.95;
/** How far out and up of both ends a change of mode's path bows. */
const ARC_OUT = 0.35;
const ARC_UP = 0.6;
/** Ends this far apart bow fully; nearer, in proportion. */
const ARC_SPAN = 0.6;
/** Seconds a change of mode blends over. */
const CHANGE = 0.7;
/** A steady boat for this long, the habit may come; between habits at least this long. */
const STEADY_FOR = 6;
const HABIT_MIN = 18;
const HABIT_MAX = 40;
/** In the water, the body's clearance from the hull. The clip itself holds the body down in the water, its head out: its origin is the surface. */
const WATER_CLEAR = 0.32;
/** On the board, how far along it from the hull the feet stand. */
const BOARD_ALONG = 0.45;

/** What the runtime needs of the boat, in the model's frame. */
export interface SailorBoat {
  /** The tiller extension's hinge now, and at rest (the rudder amidships). */
  hinge: Vector3;
  hingeRest: Vector3;
  /** The extension's length. */
  extension: number;
  /** The seat: its height, the side deck's inner and outer edges out from the centreline, its station. */
  seatY: number;
  seatIn: number;
  seatOut: number;
  seatZ: number;
  /** The centre of gravity's height, the heel's pivot. */
  cog: number;
  solid: HullSolid;
  /** The physics' climbing time, seconds. */
  climbTime: number;
}

/** The physics' moment for the sailor. */
export interface SailorMoment {
  dt: number;
  time: number;
  /** The physics' sailor offset (m, + starboard), mode and timer. */
  offset: number;
  mode: number;
  timer: number;
  heel: number;
  pitch: number;
  heave: number;
  /** The apparent wind's speed (m/s) and angle (radians, from the bow, + starboard). */
  windSpeed: number;
  windAngle: number;
  /** The boat's heel rate (rad/s), for whether she is steady. */
  rollRate: number;
  /** Under reduced motion: breathing only, no habit. */
  still: boolean;
}

/** Which hand holds what, and where (the model's frame). */
export interface Hands {
  /** The aft hand on the tiller extension: whether it holds it, and where. */
  tiller: boolean;
  tillerAt: Vector3;
  /** The forward hand on the mainsheet. */
  sheet: boolean;
  sheetAt: Vector3;
}

const v = new Vector3();
const w = new Vector3();
const u = new Vector3();
const p = new Vector3();
const q = new Quaternion();
const q2 = new Quaternion();
const m = new Matrix4();
const m2 = new Matrix4();
const m3 = new Matrix4();
const m4 = new Matrix4();
const inv = new Matrix4();
const e = new Euler();
const ONE = new Vector3(1, 1, 1);

/** A root place: a position and a turn, blended. */
class Place {
  readonly at = new Vector3();
  readonly turn = new Quaternion();

  set(matrix: Matrix4): this {
    matrix.decompose(this.at, this.turn, v);
    return this;
  }

  copy(o: Place): this {
    this.at.copy(o.at);
    this.turn.copy(o.turn);
    return this;
  }

  matrix(out: Matrix4): Matrix4 {
    return out.compose(this.at, this.turn, ONE);
  }
}

export class SailorRuntime {
  /** From the figure's space to the boat model's, now. */
  readonly root = new Matrix4();
  readonly hands: Hands = {
    tiller: false,
    tillerAt: new Vector3(),
    sheet: false,
    sheetAt: new Vector3(),
  };

  readonly #clips: Map<string, Clip>;
  readonly #pose: Pose;
  readonly #scratch: Pose;
  readonly #from: Pose;
  readonly #habitPose: Pose;
  readonly #layers: Layers;
  readonly #springs: Springs;
  readonly #rand: () => number;
  readonly #place = new Place();
  readonly #fromPlace = new Place();
  readonly #placeNow = new Place();
  readonly #bones: Record<string, number>;
  readonly #helmOffset: number;
  readonly #world: SpringWorld = {
    dt: 0,
    down: new Vector3(),
    wind: new Vector3(),
    accel: new Vector3(),
    seatY: 0,
    seated: false,
    side: 1,
    seatIn: 0,
    seatOut: 0,
  };
  readonly #heelAxis = new Vector3();
  #side = 1;
  #mode = -1;
  #change = 1;
  #cross: Clip | null = null;
  #crossT = 0;
  #crossFrom = 1;
  #habit: Clip | null = null;
  #habitT = 0;
  #steady = 0;
  #nextHabit = 20;
  #effort = 0;
  #high = 1;
  #rebase = false;

  constructor(
    readonly rig: Rig,
    clips: Map<string, Clip>,
    readonly boat: SailorBoat,
    seed: number,
  ) {
    this.#clips = clips;
    const n = rig.names.length;
    this.#pose = new Pose(n).rest(rig);
    this.#scratch = new Pose(n).rest(rig);
    this.#from = new Pose(n).rest(rig);
    this.#habitPose = new Pose(n).rest(rig);
    this.#layers = new Layers(rig, seed);
    this.#springs = new Springs(rig);
    this.#rand = random(seed * 7 + 3);
    this.#helmOffset = 30 * this.#rand();
    this.#nextHabit = HABIT_MIN + (HABIT_MAX - HABIT_MIN) * this.#rand();
    this.#bones = Object.fromEntries(
      ['hand_l', 'hand_r', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'pelvis'].map(
        (b) => [b, rig.bone(b)],
      ),
    );
  }

  /** A clip's pose at t (looped, or held at its end) into out, from rest. */
  #sample(name: string, side: number, t: number, loop: boolean, out: Pose): void {
    const c = this.#clip(name, side);
    out.rest(this.rig);
    if (c !== null) {
      c.sample(loop ? t % c.duration : Math.min(t, c.duration), out);
    }
  }

  #clip(name: string, side = 1): Clip | null {
    return this.#clips.get(side < 0 ? name + PORT : name) ?? null;
  }

  /** The sailor's side deck, + starboard, − port. */
  get side(): number {
    return this.#side;
  }

  /** Whether the sailor is crossing the boat. */
  get crossing(): boolean {
    return this.#cross !== null;
  }

  /** Poses the rig for the moment, and sets root and hands. */
  update(s: SailorMoment): void {
    const dt = Math.max(0, Math.min(s.dt, 0.1));
    const mode = s.mode;
    this.#high = s.heel > 0 ? -1 : 1;
    if (this.#mode < 0 && Math.abs(s.offset) > 0.05) {
      // The first moment: the sailor is already on its side deck.
      this.#side = Math.sign(s.offset);
    }
    if (mode !== this.#mode) {
      this.#begin(mode);
    }
    this.#effort = Math.max(
      0,
      Math.min(1, this.#effort + (Math.abs(s.offset) > HIKE_FROM ? dt / 20 : -dt / 40)),
    );

    // The mode's pose and place.
    const pose = this.#pose;
    const place = this.#place;
    let seated = false;
    if (mode === IN_WATER) {
      this.#sample(CLIPS.water, 1, s.time + this.#helmOffset, true, pose);
      this.#waterPlace(s, place);
    } else if (mode === ON_BOARD) {
      this.#sample(CLIPS.board, 1, s.time + this.#helmOffset, true, pose);
      this.#boardPlace(s, place);
    } else if (mode === CLIMBING) {
      const c = this.#clip(CLIPS.climb, this.#side);
      if (c !== null) {
        const f = Math.max(0, Math.min(1, 1 - s.timer / Math.max(this.boat.climbTime, 1e-3)));
        pose.rest(this.rig);
        c.sample(f * c.duration, pose);
        place.set(c.place ?? m.identity());
      }
    } else {
      seated = this.#sailing(s, dt, pose, place);
    }

    // A change of mode, blended along a path clear of the hull.
    if (this.#change < 1 && this.#rebase) {
      // From a clip's end to a pose in the same boat (the climb ends seated
      // at the helm): the old pose moved into the new place, and blended
      // there, the root still.
      this.#rebase = false;
      this.#rebasePose(this.#from, this.#fromPlace, place);
      this.#fromPlace.copy(place);
    }
    if (this.#change < 1) {
      this.#change = Math.min(1, this.#change + dt / CHANGE);
      const f = smooth(this.#change);
      // The body takes its new shape early in the move, the limbs gathered
      // before the hips go over the side.
      this.#scratch.copy(this.#from).mix(pose, smooth(Math.min(1, this.#change * 2)));
      pose.copy(this.#scratch);
      this.#path(this.#fromPlace, place, f, s, this.#placeNow);
    } else {
      this.#placeNow.copy(place);
    }
    this.#placeNow.matrix(this.root);
    pose.to(this.rig);
    this.rig.fk();

    // The layers.
    this.#heelAxis.set(0, 0, 1).applyQuaternion(q.copy(this.#placeNow.turn).invert());
    this.#layers.apply({
      dt,
      time: s.time,
      effort: this.#effort,
      heelAxis: this.#heelAxis,
      heel: s.heel,
      upright: seated && this.#cross === null ? 0.5 : 0,
      still: s.still,
    });

    // The hands.
    this.#tillerHand(seated);

    // The springs.
    this.#springStep(s, dt, seated);
    this.#forwardHand(seated);
  }

  /** Starts a new mode: the old pose and place kept to blend from. */
  #begin(mode: number): void {
    const first = this.#mode < 0;
    this.#from.copy(this.#pose);
    this.#fromPlace.copy(this.#placeNow);
    // Falling in is sudden: no frame between the seat and the water, where
    // the legs would come up through the deck.
    this.#change = first || mode === IN_WATER ? 1 : 0;
    if (mode === CLIMBING || (mode === 0 && this.#mode === IN_WATER)) {
      // Climbing in on the side the board was on, the high one.
      this.#side = this.#high;
    }
    // A climb ends seated at the helm: the pose carries on in the boat.
    this.#rebase = mode === 0 && this.#mode === CLIMBING;
    this.#cross = null;
    this.#habit = null;
    this.#mode = mode;
    this.#springs.reset();
  }

  /**
   * Moves a pose made for one place to another: its hips turned and moved
   * so that, at the new place, the body is where it was.
   */
  #rebasePose(pose: Pose, from: Place, to: Place): void {
    const rig = this.rig;
    const hips = this.#bones.pelvis as number;
    const root = rig.parent[hips] as number;
    // The hips' parent's frame in the figure's: the base, and the root bone.
    m.copy(rig.base);
    if (root >= 0) {
      m.multiply(
        m2.compose(v.fromArray(pose.pos, 3 * root), q.fromArray(pose.quat, 4 * root), ONE),
      );
    }
    // K: from the old place's figure space to the new one's.
    from.matrix(m3);
    to.matrix(m4).invert().multiply(m3);
    // L' = M⁻¹ K M L
    m2.compose(v.fromArray(pose.pos, 3 * hips), q.fromArray(pose.quat, 4 * hips), ONE);
    m3.copy(m).invert().multiply(m4).multiply(m).multiply(m2);
    m3.decompose(v, q, w);
    v.toArray(pose.pos, 3 * hips);
    q.toArray(pose.quat, 4 * hips);
  }

  /** At the helm or hiking, crossing, or the habit: true when seated on a side deck. */
  #sailing(s: SailorMoment, dt: number, pose: Pose, place: Place): boolean {
    const want = Math.abs(s.offset) > 0.05 ? Math.sign(s.offset) : this.#side;
    if (this.#cross === null && want !== this.#side && this.#change >= 1) {
      this.#cross = this.#clip(CLIPS.cross, this.#side);
      this.#crossT = 0;
      this.#crossFrom = this.#side;
      this.#habit = null;
      if (this.#cross === null) {
        this.#side = want;
      }
    }
    if (this.#cross !== null) {
      this.#crossT += dt;
      const c = this.#cross;
      pose.rest(this.rig);
      c.sample(Math.min(this.#crossT, c.duration), pose);
      place.set(c.place ?? m.identity());
      if (this.#crossT >= c.duration) {
        this.#cross = null;
        this.#side = -this.#crossFrom;
        this.#springs.reset();
      }
      return true;
    }
    const side = this.#side;
    const out = Math.max(0, s.offset * side);
    const h = Math.max(0, Math.min(1, (out - HIKE_FROM) / (HIKE_FULL - HIKE_FROM))) * 3;
    const t = s.time + this.#helmOffset;
    // The helm and the hiking depths, each by its weight, and their places.
    const scratch = this.#scratch;
    pose.clear();
    let total = 0;
    const names = SEATED;
    p.set(0, 0, 0);
    q.set(0, 0, 0, 0);
    for (let k = 0; k < names.length; k++) {
      const weight = Math.max(0, 1 - Math.abs(h - k));
      const c = weight > 0 ? this.#clip(names[k] as string, side) : null;
      if (c === null) {
        continue;
      }
      scratch.rest(this.rig);
      c.sample(t % c.duration, scratch);
      if (k === 0 && this.#habit === null) {
        this.#maybeHabit(s, dt, h);
      }
      if (k === 0 && this.#habit !== null) {
        this.#habitStep(dt, scratch);
      }
      pose.add(scratch, weight);
      (c.place ?? m.identity()).decompose(v, q2, w);
      p.addScaledVector(v, weight);
      if (q.x * q2.x + q.y * q2.y + q.z * q2.z + q.w * q2.w < 0) {
        q2.set(-q2.x, -q2.y, -q2.z, -q2.w);
      }
      q.set(q.x + q2.x * weight, q.y + q2.y * weight, q.z + q2.z * weight, q.w + q2.w * weight);
      total += weight;
    }
    if (total <= 0) {
      pose.rest(this.rig);
      place.set(m.identity());
      return false;
    }
    pose.normalize(total);
    place.at.copy(p).divideScalar(total);
    place.turn.copy(q).normalize();
    return true;
  }

  /** The habit begins in a steady boat, at the helm, now and then. */
  #maybeHabit(s: SailorMoment, dt: number, hike: number): void {
    const steady = hike <= 0 && Math.abs(s.rollRate) < 0.08 && !s.still;
    this.#steady = steady ? this.#steady + dt : 0;
    this.#nextHabit -= dt;
    if (this.#steady > STEADY_FOR && this.#nextHabit <= 0) {
      this.#habit = this.#clip(CLIPS.habit, this.#side);
      this.#habitT = 0;
      this.#nextHabit = HABIT_MIN + (HABIT_MAX - HABIT_MIN) * this.#rand();
    }
  }

  /** The habit over the helm, faded in and out at its ends. */
  #habitStep(dt: number, helm: Pose): void {
    const c = this.#habit as Clip;
    this.#habitT += dt;
    if (this.#habitT >= c.duration) {
      this.#habit = null;
      return;
    }
    const fade = Math.min(1, this.#habitT / 0.4, (c.duration - this.#habitT) / 0.4);
    this.#habitPose.rest(this.rig);
    c.sample(this.#habitT, this.#habitPose);
    helm.mix(this.#habitPose, smooth(fade));
  }

  /** Treading water off the high side, clear of the hull, facing it. */
  #waterPlace(s: SailorMoment, place: Place): void {
    const high = this.#high;
    const b = this.boat;
    const out = reach(b.solid, high, -s.heel, b.cog, b.seatZ - 0.4, b.seatZ + 0.4) + WATER_CLEAR;
    // In the level frame about the heel's pivot, then into the model's.
    this.#level(high * out, -s.heave, b.seatZ, -high * (Math.PI / 2), s, place);
  }

  /**
   * Standing on the daggerboard as on a floor, facing up it to the hull:
   * upright in the world when she lies on her side, leaning back away
   * from her as she comes up.
   */
  #boardPlace(s: SailorMoment, place: Place): void {
    const board = this.boat.solid.board;
    // The board's top face, as the boat lies: the face nearer the sky.
    this.#levelTurn(s, q);
    u.set(0, 1, 0).applyQuaternion(q.invert());
    const face = u.x >= 0 ? 1 : -1;
    place.at.set(face * (board.thickness / 2), board.y - BOARD_ALONG, board.z);
    // The figure's left, up and forward: up off the face, forward up the board.
    v.set(face, 0, 0);
    w.set(0, 1, 0);
    u.crossVectors(v, w);
    m.makeBasis(u, v, w);
    place.turn.setFromRotationMatrix(m);
  }

  /** The heel group's turn (pitch, then heel) as boat.ts sets it. */
  #levelTurn(s: SailorMoment, out: Quaternion): Quaternion {
    return out.setFromEuler(e.set(s.pitch, 0, -s.heel));
  }

  /**
   * A place given in the level frame (world axes about the heel's pivot,
   * the waterline at y 0 with the heave), facing by a turn about the
   * vertical, as a place in the model's frame.
   */
  #level(x: number, y: number, z: number, facing: number, s: SailorMoment, place: Place): void {
    const cog = this.boat.cog;
    this.#levelTurn(s, q);
    q2.copy(q).invert();
    place.at.set(x, y - cog, z).applyQuaternion(q2);
    place.at.y += cog;
    q.setFromAxisAngle(Y, facing);
    place.turn.copy(q2).multiply(q);
  }

  /**
   * A place between two, f of the way: through the level frame, by a curve
   * that rises and stands off the hull at its middle, so the body goes
   * round the gunwale, not through it.
   */
  #path(a: Place, b: Place, f: number, s: SailorMoment, out: Place): void {
    // Each end in the level frame.
    this.#levelTurn(s, q);
    const cog = this.boat.cog;
    v.copy(a.at)
      .setY(a.at.y - cog)
      .applyQuaternion(q);
    w.copy(b.at)
      .setY(b.at.y - cog)
      .applyQuaternion(q);
    // The control point: outboard of both on the side they lie, and above
    // both; as much as the ends are apart (a place to itself is no move).
    const side = Math.sign(v.x + w.x) || 1;
    const bow = Math.min(1, v.distanceTo(w) / ARC_SPAN);
    u.set(
      side * Math.max(side * v.x, side * w.x) + side * ARC_OUT * bow,
      Math.max(v.y, w.y) + ARC_UP * bow,
      (v.z + w.z) / 2,
    );
    const g = 1 - f;
    p.set(
      g * g * v.x + 2 * g * f * u.x + f * f * w.x,
      g * g * v.y + 2 * g * f * u.y + f * f * w.y,
      g * g * v.z + 2 * g * f * u.z + f * f * w.z,
    );
    out.at.copy(p).applyQuaternion(q.invert());
    out.at.y += cog;
    out.turn.copy(a.turn).slerp(b.turn, f);
  }

  /**
   * The aft hand brought to the extension, which the rudder swings: kept
   * as far from its hinge as the clip has it, along the line to where the
   * clip puts it. Seated and not crossing only.
   */
  #tillerHand(seated: boolean): void {
    const hands = this.hands;
    const crossing = this.#cross !== null;
    const side = crossing
      ? this.#crossT / (this.#cross as Clip).duration < 0.75
        ? this.#crossFrom
        : -this.#crossFrom
      : this.#side;
    hands.tiller = seated && this.#mode === 0;
    if (!hands.tiller) {
      return;
    }
    const hand = side > 0 ? this.#bones.hand_l : this.#bones.hand_r;
    const upper = side > 0 ? this.#bones.upperarm_l : this.#bones.upperarm_r;
    const lower = side > 0 ? this.#bones.lowerarm_l : this.#bones.lowerarm_r;
    if (hand === undefined || upper === undefined || lower === undefined || hand < 0) {
      hands.tiller = false;
      return;
    }
    const b = this.boat;
    this.rig.position(hand, v).applyMatrix4(this.root);
    const hold = Math.min(b.extension, v.distanceTo(b.hingeRest));
    w.subVectors(v, b.hinge).normalize().multiplyScalar(hold).add(b.hinge);
    hands.tillerAt.copy(w);
    if (!crossing && w.distanceToSquared(v) > 1e-8) {
      inv.copy(this.root).invert();
      twoBone(this.rig, upper, lower, hand, w.applyMatrix4(inv));
      this.rig.position(hand, hands.tillerAt).applyMatrix4(this.root);
    }
  }

  /** The forward hand, where the mainsheet comes to it. */
  #forwardHand(seated: boolean): void {
    const hands = this.hands;
    const side = this.#cross !== null ? this.#crossFrom : this.#side;
    hands.sheet = seated && this.#mode === 0 && this.#habit === null;
    const hand = side > 0 ? this.#bones.hand_r : this.#bones.hand_l;
    if (hand === undefined || hand < 0) {
      hands.sheet = false;
      return;
    }
    this.rig.position(hand, hands.sheetAt).applyMatrix4(this.root);
  }

  #springStep(s: SailorMoment, dt: number, seated: boolean): void {
    const wd = this.#world;
    wd.dt = dt;
    // Down as the boat lies.
    this.#levelTurn(s, q);
    wd.down.set(0, -1, 0).applyQuaternion(q.invert());
    // The apparent wind blows from its angle off the bow (−z) toward the stern.
    wd.wind.set(-Math.sin(s.windAngle), 0, Math.cos(s.windAngle)).multiplyScalar(s.windSpeed);
    wd.accel.set(0, 0, 0);
    wd.seatY = this.boat.seatY;
    wd.seated = seated && this.#mode === 0 && this.#cross === null;
    wd.side = this.#side;
    wd.seatIn = this.boat.seatIn;
    wd.seatOut = this.boat.seatOut;
    this.#springs.step(this.root, wd);
  }

  /** The current place in the model's frame (for tests). */
  get place(): { at: Vector3; turn: Quaternion } {
    return this.#placeNow;
  }
}

const Y = new Vector3(0, 1, 0);

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (6 * t - 15) + 10);
}
