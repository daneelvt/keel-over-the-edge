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
// A boat with a trapeze (its model's `trapeze` node) has its sailor go on
// out beyond the rail onto the wire as the physics puts it further out:
// at the helm, sat out on the rail, then crouched on the rack's edge part
// out, then out fully, lying back on the wire with its legs straight; the
// aft hand on the extension and the forward hand on the mainsheet as
// seated. The clips on the wire are placed from the rack's edge, never
// moved to another seat; the hook of the harness rides on the hips.
//
// A boat steered by a wheel (its model's `wheel` node) has its sailor
// standing at it instead, at the model's `sailor` node, facing forward,
// playing the wheel's clip: looking ahead, aloft at the sails and to
// windward, its windward side by the apparent wind; now and then its look's
// habit at the wheel. The hands are kept on the spokes as the wheel turns
// with the rudder, each following its spoke so far and then taking the next,
// hand over hand. Such a sailor never hikes, crosses or falls in.
//
// Everything here is in the boat model's frame (x to starboard, y up, z
// aft), unheeled; the boat's heel turns the model. A boat other than the
// one the clips were placed in moves them to its own seat (restage.ts).
// Allocation-free once made.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { CLIMBING, IN_WATER, ON_BOARD } from '../sailor';
import { Clip, Pose } from './clips';
import { REACH, twoBone } from './ik';
import { Layers, random, type SailorLayers } from './layers';
import { MachineLayers } from './machinelayers';
import { type Hike, restageClip, STRAPPED } from './restage';
import type { Rig } from './rig';
import { type HullSolid, reach } from './solid';
import { Springs, type SpringWorld } from './springs';
import {
  onPelvis,
  onWire,
  TRAPEZE_CLIPS,
  type Trapeze,
  wireDepth,
  wirePlace,
  wireSide,
} from './trapeze';

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
  /** At a wheel: its -port is for the wind over the port side. */
  wheel: 'helm-wheel',
  wheelHabit: 'habit-wheel',
} as const;
/** The clips placed at the wheel, from the helmsman's place: never moved to another seat. */
const AT_WHEEL: readonly string[] = [CLIPS.wheel, `${CLIPS.wheel}-port`, CLIPS.wheelHabit];

/** Whether a clip is placed at a wheel (from the helmsman's place), not in the dinghy the others are. */
export function atWheel(clip: string): boolean {
  return AT_WHEEL.includes(clip);
}

/** How many turns a wheel makes from amidships to hard over. */
export const WHEEL_TURNS = 1.25;

/**
 * A wheel's turn for the rudder's angle (both radians; rudderMax the
 * rudder's most): WHEEL_TURNS turns at hard over, the top of the wheel to
 * starboard for a rudder that turns the boat to starboard (positive).
 */
export function wheelTurn(rudder: number, rudderMax: number): number {
  return rudderMax > 0 ? (rudder / rudderMax) * WHEEL_TURNS * 2 * Math.PI : 0;
}

/** A boat's wheel, as the sailor at it needs it, in the boat model's frame. */
export interface WheelHelm {
  /** From the helmsman's place (the `sailor` node: on the deck between the feet, facing forward) into the model's frame. */
  stand: Matrix4;
  /** The hub. Its axle runs fore and aft; its spokes turn across the boat. */
  hub: Vector3;
  /** The rim's radius, metres, and how many spokes. */
  radius: number;
  spokes: number;
  /** Its turn now, radians: positive, the top to starboard (wheelTurn's). Set before each moment. */
  turn: number;
}

/** A hand follows its spoke this far (radians) from where its clip holds it; then takes the next. */
const SPOKE_LEAD = 0.6;
/** Beyond this it lets go and takes the next even while the other hand is changing. */
const SPOKE_MOST = 1.2;
/** Seconds a hand takes to go to the next spoke, and how far aft of the wheel it lifts on the way. */
const REGRIP = 0.35;
const REGRIP_LIFT = 0.06;
/** A hand of the clip this near its grip (m) holds the spoke; let go fully this far beyond. */
const HOLD_NEAR = 0.04;
const HOLD_FAR = 0.12;
/** Seconds the wheel's windward side takes to change. */
const WINDWARD_CHANGE = 1.5;
const PORT = '-port';
/** The helm and the hiking depths, blended by how far out the sailor is. */
const SEATED: readonly string[] = [CLIPS.helm, ...CLIPS.hiking];
/** On a boat with a trapeze: the helm, sat out on the rail, then part out and out fully on the wire. */
const WIRED: readonly string[] = [
  CLIPS.helm,
  CLIPS.hiking[0],
  TRAPEZE_CLIPS.low,
  TRAPEZE_CLIPS.out,
];
/** The first of WIRED on the wire. */
const FIRST_ON_WIRE = 2;
/** Further out on the wire than this, the cloth hangs free of the seat. */
export const OFF_SEAT = 0.5;
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
  /**
   * How far this boat's seat is from that of the boat the clips were
   * placed in, on the starboard side: the clips are moved by it. None (or
   * null) for that boat itself.
   */
  restage?: Vector3 | null;
  /** How it hikes: a dinghy's strap if not said. */
  hike?: Hike;
  /** The wheel the sailor stands at, on a boat steered by one; then it never hikes, crosses or falls in. */
  wheel?: WheelHelm | null;
  /** The trapeze, on a boat with one: the sailor goes out on its wire beyond the rail, if it has the clips on the wire. */
  trapeze?: Trapeze | null;
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
  /** At a wheel: how many hands hold its spokes (0 to 2), and where each is (left, right). */
  wheel: number;
  wheelAt: [Vector3, Vector3];
  /** On a trapeze: how far the sailor is out on the wire, 0 (not) to 1 (fully on its clips). */
  wire: number;
  /** The harness's hook's eye, where the wire hangs from it, when the runtime has been given it (see hook()). */
  hook: Vector3;
  /** Whether the sailor hangs on the wire from its hook: on the wire, with a hook. */
  hooked: boolean;
}

/** A hand at the wheel: the spoke it holds (counted from the top at rest), and a change to the next. */
interface WheelHand {
  spoke: number;
  /** The spoke it is going to, and how far there (0 to 1); -1 when not changing. Spokes count 0 to n − 1. */
  next: number;
  change: number;
  /** Its grip at rest in the helmsman's frame: the clip's hand at the start of its wheel clip. */
  home: Vector3;
  /** The grip's angle from the top (to starboard) and its distance from the hub, at rest. */
  angle: number;
}

const v = new Vector3();
const w = new Vector3();
const u = new Vector3();
const p = new Vector3();
const o = new Vector3();
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
    wheel: 0,
    wheelAt: [new Vector3(), new Vector3()],
    wire: 0,
    hook: new Vector3(),
    hooked: false,
  };

  readonly #clips: Map<string, Clip>;
  readonly #pose: Pose;
  readonly #scratch: Pose;
  readonly #from: Pose;
  readonly #habitPose: Pose;
  readonly #layers: SailorLayers;
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
  /** At a wheel: the windward side the clip looks to (+1 starboard), and how far its change has gone (0 to 1). */
  #windward = 1;
  #windwardChange = 1;
  readonly #wheelHands: WheelHand[] = [];
  /** Whether the sailor goes out on a trapeze's wire: its boat has one, and the clips on the wire are here. */
  readonly #wired: boolean;
  /** The harness's hook against the pelvis, when given. */
  #hookRest: Vector3 | null = null;

  constructor(
    readonly rig: Rig,
    clips: Map<string, Clip>,
    readonly boat: SailorBoat,
    seed: number,
    machine = false,
    /** Whether the cloth and hair move on springs (the boat in view's); else as the clips have them. */
    readonly springs = true,
  ) {
    const by = boat.restage;
    const trapeze = boat.trapeze;
    this.#clips =
      (by === undefined || by === null) && !trapeze
        ? clips
        : new Map(
            [...clips].map(([name, c]) => [
              name,
              // On the wire, placed from the rack's edge on its side.
              onWire(name)
                ? trapeze && c.place !== null
                  ? new Clip(
                      c.name,
                      c.duration,
                      c.tracks,
                      wirePlace(c.place, trapeze.rackEdge, wireSide(name)),
                    )
                  : c
                : AT_WHEEL.includes(name) || by === undefined || by === null
                  ? c
                  : restageClip(c, rig, by),
            ]),
          );
    this.#wired =
      !!trapeze &&
      [TRAPEZE_CLIPS.low, TRAPEZE_CLIPS.out].every(
        (n) => this.#clips.get(n)?.place && this.#clips.get(n + PORT)?.place,
      );
    const n = rig.names.length;
    this.#pose = new Pose(n).rest(rig);
    this.#scratch = new Pose(n).rest(rig);
    this.#from = new Pose(n).rest(rig);
    this.#habitPose = new Pose(n).rest(rig);
    // A machine has its own life: no breath, snapped glances, its lamps.
    this.#layers = machine ? new MachineLayers(rig, seed) : new Layers(rig, seed);
    this.#springs = new Springs(rig);
    this.#rand = random(seed * 7 + 3);
    this.#helmOffset = 30 * this.#rand();
    this.#nextHabit = HABIT_MIN + (HABIT_MAX - HABIT_MIN) * this.#rand();
    this.#bones = Object.fromEntries(
      ['hand_l', 'hand_r', 'upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'pelvis'].map(
        (b) => [b, rig.bone(b)],
      ),
    );
    if (boat.wheel) {
      this.#gripsAtRest(boat.wheel);
    }
  }

  /**
   * Where the wheel's clip holds the spokes at rest: each hand's grip at
   * its start, in the helmsman's frame, its angle from the top and the
   * spoke nearest it.
   */
  #gripsAtRest(wheel: WheelHelm): void {
    const n = wheel.spokes;
    const c = this.#clip(CLIPS.wheel, 1);
    const rig = this.rig;
    const pose = this.#scratch;
    pose.rest(rig);
    c?.sample(0, pose);
    pose.to(rig);
    rig.fk();
    // The hub in the helmsman's frame.
    inv.copy(wheel.stand).invert();
    o.copy(wheel.hub).applyMatrix4(inv);
    const step = (2 * Math.PI) / wheel.spokes;
    for (const b of ['hand_l', 'hand_r']) {
      const home = rig.position(rig.bone(b), new Vector3()).applyMatrix4(c?.place ?? m.identity());
      const angle = Math.atan2(home.x - o.x, home.y - o.y);
      this.#wheelHands.push({
        spoke: ((Math.round(angle / step) % n) + n) % n,
        next: -1,
        change: 0,
        home,
        angle,
      });
    }
    rig.reset();
  }

  /**
   * The harness's hook's eye, in the figure's space at rest (the file's
   * place): carried by the pelvis from now on, hands.hook where it is. The
   * rig is left at rest.
   */
  hook(point: Vector3 | null): void {
    this.#hookRest = point === null ? null : onPelvis(this.rig, point);
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

  /** A machine's lamps' strength now, 0 to 1 (1 for a person, who has none). */
  get glow(): number {
    return this.#layers.glow ?? 1;
  }

  /** The sailor's side deck, + starboard, − port. */
  get side(): number {
    return this.#side;
  }

  /** At a wheel, the side its clip looks to windward on: +1 starboard, −1 port. */
  get windward(): number {
    return this.#windward;
  }

  /** Whether the sailor is crossing the boat. */
  get crossing(): boolean {
    return this.#cross !== null;
  }

  /** The side deck the sailor is crossing from, or sits on: + starboard, − port. */
  get crossFrom(): number {
    return this.#cross === null ? this.#side : this.#crossFrom;
  }

  /** How far through crossing the boat the sailor is, 0 to 1; 1 when not crossing. */
  get crossed(): number {
    const c = this.#cross;
    return c === null ? 1 : Math.min(1, this.#crossT / Math.max(c.duration, 1e-3));
  }

  /**
   * Forgets the moments before: the next one seats the sailor afresh, on
   * the side its offset says, as a sailor first met (a boat moved at once).
   */
  reset(): void {
    this.#mode = -1;
    this.#cross = null;
    this.#habit = null;
    this.#change = 1;
    this.#springs.reset();
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
      Math.min(
        1,
        this.#effort +
          (Math.abs(s.offset) > (this.boat.hike ?? STRAPPED).from ? dt / 20 : -dt / 40),
      ),
    );

    // The mode's pose and place.
    const pose = this.#pose;
    const place = this.#place;
    let seated = false;
    this.hands.wire = 0;
    const wheel = this.boat.wheel;
    if (wheel) {
      this.#atWheel(s, dt, wheel, pose, place);
    } else if (mode === IN_WATER) {
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
      upright: (seated && this.#cross === null) || wheel ? 0.5 : 0,
      still: s.still,
    });

    // The hands.
    if (wheel) {
      this.#wheelHandsStep(dt, wheel);
    }
    this.#tillerHand(seated);

    // The springs.
    if (this.springs) {
      this.#springStep(s, dt, seated);
    }
    this.#forwardHand(seated);
    this.#hookStep();
  }

  /** The hook where the pelvis carries it now, and whether the wire hangs from it. */
  #hookStep(): void {
    const hands = this.hands;
    const rest = this.#hookRest;
    hands.hooked = rest !== null && hands.wire > 0;
    if (rest === null) {
      return;
    }
    const pelvis = this.#bones.pelvis as number;
    m.fromArray(this.rig.world, 16 * pelvis);
    hands.hook.copy(rest).applyMatrix4(m).applyMatrix4(this.root);
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
    const hike = this.boat.hike ?? STRAPPED;
    let h = Math.max(0, Math.min(1, (out - hike.from) / (hike.full - hike.from))) * hike.depth;
    // On a trapeze, beyond the rail onto the wire.
    const trapeze = this.boat.trapeze;
    const wired = this.#wired && trapeze;
    if (wired) {
      // Out to the rail on the first hiking clip, then onto the wire.
      h = Math.min(h, 1) + wireDepth(out, hike.full, trapeze.reach);
    }
    const t = s.time + this.#helmOffset;
    // The helm and the hiking depths (or out on the wire), each by its
    // weight, and their places.
    const scratch = this.#scratch;
    pose.clear();
    let total = 0;
    let hanging = 0;
    const names = wired ? WIRED : SEATED;
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
      if (wired && k >= FIRST_ON_WIRE) {
        hanging += weight;
      }
    }
    if (total <= 0) {
      pose.rest(this.rig);
      place.set(m.identity());
      return false;
    }
    this.hands.wire = hanging / total;
    pose.normalize(total);
    place.at.copy(p).divideScalar(total);
    place.turn.copy(q).normalize();
    return true;
  }

  /**
   * At the wheel: its clip looking to windward (the two sides' blended
   * while the wind changes side), now and then the habit over it; placed
   * from the helmsman's place.
   */
  #atWheel(s: SailorMoment, dt: number, wheel: WheelHelm, pose: Pose, place: Place): void {
    // The windward side, by the apparent wind (from starboard, positive),
    // held through a calm or a wind from dead ahead or astern.
    const want =
      Math.abs(Math.sin(s.windAngle)) > 0.1 ? Math.sign(Math.sin(s.windAngle)) : this.#windward;
    if (want !== this.#windward && this.#windwardChange >= 1) {
      this.#windward = want;
      this.#windwardChange = 0;
    }
    this.#windwardChange = Math.min(1, this.#windwardChange + dt / WINDWARD_CHANGE);
    const t = s.time + this.#helmOffset;
    this.#sample(CLIPS.wheel, this.#windward, t, true, pose);
    if (this.#windwardChange < 1) {
      this.#sample(CLIPS.wheel, -this.#windward, t, true, this.#scratch);
      this.#scratch.mix(pose, smooth(this.#windwardChange));
      pose.copy(this.#scratch);
    }
    if (this.#habit === null) {
      this.#maybeHabit(s, dt, 0, CLIPS.wheelHabit, 1);
    }
    if (this.#habit !== null) {
      this.#habitStep(dt, pose);
    }
    const c = this.#clip(CLIPS.wheel, 1);
    place.set(m.multiplyMatrices(wheel.stand, c?.place ?? m2.identity()));
  }

  /**
   * The hands kept on the wheel's spokes as it turns: each where its clip
   * holds it (but as far as it has let go, in a habit), turned with its
   * spoke; past SPOKE_LEAD from its grip at rest it takes the spoke after,
   * one hand at a time, lifted aft of the wheel on the way.
   */
  #wheelHandsStep(dt: number, wheel: WheelHelm): void {
    const rig = this.rig;
    const hands = this.hands;
    hands.wheel = 0;
    const step = (2 * Math.PI) / wheel.spokes;
    inv.copy(this.root).invert();
    for (let k = 0; k < 2; k++) {
      const h = this.#wheelHands[k];
      const hand = k === 0 ? this.#bones.hand_l : this.#bones.hand_r;
      const upper = k === 0 ? this.#bones.upperarm_l : this.#bones.upperarm_r;
      const lower = k === 0 ? this.#bones.lowerarm_l : this.#bones.lowerarm_r;
      if (h === undefined || hand === undefined || upper === undefined || lower === undefined) {
        continue;
      }
      // The clip's hand, in the model's frame, against the wheel's hub.
      rig.position(hand, v).applyMatrix4(this.root);
      w.copy(h.home).applyMatrix4(wheel.stand);
      const hold = 1 - smooth((v.distanceTo(w) - HOLD_NEAR) / (HOLD_FAR - HOLD_NEAR));
      u.subVectors(v, wheel.hub);
      // Its place against its grip at rest: across the spoke and off the wheel.
      const r = Math.hypot(u.x, u.y);
      const drift = Math.atan2(u.x, u.y) - h.angle;
      // The spoke it holds: changed for the next when the wheel has carried
      // it too far, the other hand holding meanwhile.
      const other = this.#wheelHands[1 - k];
      const at = wheel.turn + h.spoke * step;
      const off = wrap(at - h.angle);
      if (
        h.next < 0 &&
        (Math.abs(off) > SPOKE_MOST || (Math.abs(off) > SPOKE_LEAD && (other?.next ?? -1) < 0))
      ) {
        const n = wheel.spokes;
        h.next = (((Math.round((h.angle - wheel.turn) / step) % n) + n) % n) as number;
        h.change = 0;
        if (h.next === h.spoke) {
          h.next = -1;
        }
      }
      let angle = at;
      let lift = 0;
      if (h.next >= 0) {
        h.change = Math.min(1, h.change + dt / REGRIP);
        const to = wheel.turn + h.next * step;
        angle = at + wrap(to - at) * smooth(h.change);
        lift = REGRIP_LIFT * Math.sin(Math.PI * h.change);
        if (h.change >= 1) {
          h.spoke = h.next;
          h.next = -1;
        }
      }
      if (hold <= 0) {
        continue;
      }
      const a = angle + drift;
      p.set(wheel.hub.x + r * Math.sin(a), wheel.hub.y + r * Math.cos(a), wheel.hub.z + u.z + lift);
      twoBone(rig, upper, lower, hand, p.applyMatrix4(inv), hold);
      rig.position(hand, hands.wheelAt[k] as Vector3).applyMatrix4(this.root);
      if (hold >= 1 && h.next < 0) {
        hands.wheel++;
      }
    }
  }

  /** The habit begins in a steady boat, at the helm, now and then. */
  #maybeHabit(
    s: SailorMoment,
    dt: number,
    hike: number,
    name: string = CLIPS.habit,
    side = this.#side,
  ): void {
    const steady = hike <= 0 && Math.abs(s.rollRate) < 0.08 && !s.still;
    this.#steady = steady ? this.#steady + dt : 0;
    this.#nextHabit -= dt;
    if (this.#steady > STEADY_FOR && this.#nextHabit <= 0) {
      this.#habit = this.#clip(name, side);
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
   * clip puts it; slid along the extension toward the clip's hand, no
   * further than its end, where the arm could not reach so far (a long
   * tiller swung away from the sailor). Seated and not crossing only.
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
    let hold = Math.min(b.extension, v.distanceTo(b.hingeRest));
    u.subVectors(v, b.hinge).normalize();
    // Out of the arm's reach there, the hold slides along the extension to
    // the nearest point within it: |hinge + h·u − shoulder| = the reach.
    const rig = this.rig;
    const most =
      REACH *
      (rig.position(upper, p).distanceTo(rig.position(lower, w)) +
        w.distanceTo(rig.position(hand, o)));
    rig.position(upper, p).applyMatrix4(this.root);
    w.copy(u).multiplyScalar(hold).add(b.hinge);
    if (w.distanceTo(p) > most) {
      o.subVectors(b.hinge, p);
      const od = o.dot(u);
      const disc = od * od - o.lengthSq() + most * most;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        const near = Math.abs(-od - r - hold) < Math.abs(-od + r - hold) ? -od - r : -od + r;
        hold = Math.max(0, Math.min(b.extension, near));
      }
    }
    w.copy(u).multiplyScalar(hold).add(b.hinge);
    if (w.distanceTo(p) > most) {
      // Nowhere along it within reach (the rudder has swung the hinge away
      // from a sailor far out): the extension turned toward the shoulder,
      // held as far toward the hinge as the arm reaches; at its end, the
      // arm stretched to it, if it is not so long.
      o.subVectors(b.hinge, p);
      const far = o.length() - most * (1 - 1e-3);
      if (far > 0) {
        u.copy(o).normalize().negate();
        hold = Math.min(far, b.extension);
        w.copy(u).multiplyScalar(hold).add(b.hinge);
      }
    }
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
    // Out on the wire the cloth hangs free of the seat.
    wd.seated = seated && this.#mode === 0 && this.#cross === null && this.hands.wire < OFF_SEAT;
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

/** An angle brought within ±π. */
function wrap(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (6 * t - 15) + 10);
}
