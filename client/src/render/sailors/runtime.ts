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
// A beach cat (a kind whose art names her people's clips, cat.ts) has her
// sailor sit on her windward hull by its inner edge, sit out from its outer
// edge, and go out on the wire from it, as the physics puts the sailor
// further out; cross her net facing forward at a crouch, on hands and knees
// under the boom, when the side changes (after the crew, if the crew is in
// the way: wayHeld); stand on her lower hull to right her; and, thrown off
// over her bows as she pitchpoles, land in the water ahead of her front
// beam before swimming to her side.
//
// A boat steered by a wheel (its model's `wheel` node) has its sailor
// standing at it instead, at the model's `sailor` node, facing forward (of
// two wheels, aft of the windward one, walking across to the other as the
// wind changes side, hands off the spokes on the way),
// playing the wheel's clip: looking ahead, aloft at the sails and to
// windward, its windward side by the apparent wind; now and then its look's
// habit at the wheel. The hands are kept on the spokes as the wheel turns
// with the rudder, each following its spoke so far and then taking the next,
// hand over hand. Such a sailor never hikes, crosses or falls in.
//
// A cruising yacht (a kind whose art names her people's clips, yacht.ts)
// has her helm on her own clips, at the windward wheel: sat on the side
// deck outboard of it in a light wind, a hand on the rim, and standing
// aft of it in a breeze. Going from one to the other the legs come in
// along the deck aft of the wheel and the body goes down into the cockpit
// (or up out of it), the feet carried. Its windward side is away from the
// boom, as her crew's (by the wind while the boom lies amidships); when it
// changes the helm stands, lets go and walks across between the wheels at
// a crouch, facing the way, to stand at the other.
//
// A cruising catamaran (a kind whose art names her people's clips,
// bridgedeck.ts) has her helm on her own clips at her one wheel, off her
// centreline: sat on the settle behind it in a light wind, the hands on
// the thighs, and standing at it in a breeze, the hands on the rim, by her
// apparent wind alone (she barely heels); stepping back and sitting down,
// or getting up and stepping forward, the feet carried. The helm never
// crosses; the look to windward is the wind's side, as at any wheel.
//
// Everything here is in the boat model's frame (x to starboard, y up, z
// aft), unheeled; the boat's heel turns the model. A boat other than the
// one the clips were placed in moves them to its own seat (restage.ts).
// Allocation-free once made.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export type { CatBoat } from './cat';

import { CLIMBING, IN_WATER, ON_BOARD } from '../sailor';
import { BRIDGE_CLIPS, type BridgePlaces, bridgePlace } from './bridgedeck';
import {
  type Aboard,
  CAT_CLIPS,
  type CatBoat,
  catAnchor,
  catFloor,
  catPlace,
  catPoint,
  catSide,
  crawlFor,
  inCatFile,
  liftOver,
  NetCross,
  netWay,
  standPlace,
} from './cat';
import { Clip, feetTogether, Pose } from './clips';
import { carried } from './crewbody';
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
import {
  STANCE_SHORT,
  YACHT_CLIPS,
  YACHT_CROSS_SPEED,
  YACHT_WALK_AHEAD,
  type YachtPlaces,
  yachtPlace,
} from './yacht';

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
  /**
   * Two wheels, either side: how far out each is, metres (0 for one on the
   * centreline). The hub and the stand are then between them, and the
   * helmsman stands aft of whichever the sailor's offset is at.
   */
  spread?: number;
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
/** The radius of the wheel the wheel's clips were made at: a smaller wheel's hands are brought in to its rim. */
const CLIP_WHEEL_RADIUS = 0.75;
/** At two wheels, the helmsman stands aft of the windward one, walking across to the other at this speed, m/s, as the wind changes side. */
const WHEEL_WALK = 1;
/** At two wheels, the hands hold the nearer one's spokes when the helmsman is this near its stance (m), and let go this far from it. */
const AT_WHEEL_NEAR = 0.08;
const AT_WHEEL_FAR = 0.3;
/** Seconds the wheel's windward side takes to change. */
const WINDWARD_CHANGE = 1.5;
/**
 * Aboard a cruising yacht, the helm sits by the wheel in an apparent wind
 * under SIT_WIND (m/s) heeled under SIT_HEEL, and stands in one past
 * STAND_WIND or heeled past STAND_HEEL (radians); going from one to the
 * other takes SEAT_TIME, s: the legs, then the body.
 */
export const SIT_WIND = 4.5;
export const STAND_WIND = 6;
export const SIT_HEEL = (8 * Math.PI) / 180;
export const STAND_HEEL = (12 * Math.PI) / 180;
export const SEAT_TIME = 1.6;
/** Aboard a cruising yacht, how far past the centreline the boom lies before the helm's wheel is the one away from it, radians: nearer, by the wind. */
const BOOM_SIDE = (5 * Math.PI) / 180;
/** Aboard a cruising yacht, how far forward of the stance the feet are drawn in along the side deck, aft of the wheel, m. */
const LEGS_IN = 0.25;
/** Aboard a cruising yacht, seconds to get up from the wheel into the crouch's walk between the wheels, and to stand at the other. */
export const WALK_RISE = 0.5;
export const WALK_STAND = 0.5;
/** Aboard a cruising yacht, how high the helm's body is carried going down into the cockpit from sat by the wheel, or up out of it, m. */
const SEAT_ARC = 0.15;
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
/** On a beach cat: sat on her hull, sitting out from it; then part out and out fully on the wire. */
const CAT_SEATED: readonly string[] = [CAT_CLIPS.helm, CAT_CLIPS.hike];
const CAT_WIRED: readonly string[] = [
  CAT_CLIPS.helm,
  CAT_CLIPS.hike,
  CAT_CLIPS.wireLow,
  CAT_CLIPS.wire,
];
/** On a beach cat, how far past the centreline the boom comes over the hull sat on before the sailor crosses, radians. */
export const BOOM_OVER = (5 * Math.PI) / 180;
/** Of a change of mode's blend, how much passes before a crossing of the net moves on. */
const NET_RISE = 0.6;
/** How high over the net the feet are carried, onto it or off it, m. */
const NET_STEP = 0.12;
/** How far a change of mode's path bows up for a crossing of the net, m: the hips brought in over the hull's edge. */
const NET_ARC_UP = 0.03;
/**
 * Thrown off over her bows: the boat pitched this far bow down off the
 * waves (radians), or heeled no further than this (no capsize throws a
 * sailor so near upright), as the sailor fell in.
 */
export const THROWN_TRIM = 0.2;
export const THROWN_HEEL = 0.9;
/** Thrown off: landed this far ahead of the front beam, and this far out from the centreline, m; there this long, then swimming to her side over SWIM_ROUND, seconds. */
export const THROWN_AHEAD = 0.9;
export const THROWN_OUT = 0.35;
export const THROWN_FOR = 3;
export const SWIM_ROUND = 2.5;
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
  /** A beach cat's, whose people's clips are placed from her model: her sailor sits on her hull and crosses her net, if it has the clips. */
  cat?: CatBoat | null;
  /** A cruising yacht's places, whose people's clips are placed from her model: her helm at her wheel on her own clips, if it has them. */
  yacht?: YachtPlaces | null;
  /** A cruising catamaran's places, whose people's clips are placed from her model: her helm at her wheel on her own clips, if it has them. */
  bridge?: BridgePlaces | null;
}

/** The physics' moment for the sailor. */
export interface SailorMoment {
  dt: number;
  time: number;
  /** The physics' sailor offset (m, + starboard), mode and timer. */
  offset: number;
  /** How far aft of their place the sailor stands (m), on a boat whose rig pitches her; 0 if not said. */
  aft?: number;
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
  /** The boom's angle, radians, + starboard: on a beach cat, under it her net is crossed on hands and knees. 0 if not said. */
  boom?: number;
  /** A boat whose rig pitches her: her trim, radians, bow up; far bow down as the sailor falls in, thrown off over the bows. 0 if not said. */
  trim?: number;
  /** On a beach cat, whether someone crossing her net is in the sailor's way: the sailor waits to cross till they are clear. */
  wayHeld?: boolean;
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
  /** Aboard a cruising catamaran, her helm sat, blended with standing. */
  readonly #satPose: Pose;
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
  /** How far the sailor hiked at the last moment (depth). */
  #depth = 0;
  /** On a beach cat: whether the sailor sits on her hull (her clips are here), crosses her net (those too), and the crossing now. */
  readonly #catted: boolean;
  readonly #netted: boolean;
  #net: NetCross | null = null;
  /** How long a crossing of the net waits for the blend off the hull, seconds; whether a change's path bows up only (onto and off the net). */
  #netWait = 0;
  #flat = false;
  /** Seconds since thrown off over her bows into the water; −1 if not. */
  #thrown = -1;
  readonly #righting = new Matrix4();
  /** The legs' thigh, calf and foot bones; and each foot's place at either end of a carry. */
  readonly #legs: [number, number, number][];
  readonly #feetA: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  readonly #feetB: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  /** Between the crouch and the crawl, how far (0 to 1), the feet to be carried so; −1 if not. */
  #crawlCarry = -1;
  readonly #ends = new Place();
  /** On a beach cat, what the joints keep over: her net and decks. */
  readonly #floor: ((x: number, z: number) => number | null) | null;
  readonly #ahead = new Place();
  readonly #beside = new Place();
  /** Aboard a cruising yacht: whether her helm is on her own clips; the radius of the wheel the wheel's clip was made at. */
  readonly #yachted: boolean;
  /** Aboard a cruising catamaran: whether her helm is on her own clips. */
  readonly #bridged: boolean;
  readonly #clipRadius: number;
  /** Aboard a cruising yacht: how far sat by the wheel (0 standing, 1 sat), and whether the wind has the helm sit. */
  #seat = 0;
  #sits = false;
  /** Aboard a cruising yacht: walking between the wheels from the side walked from, seconds into it; −1 at a wheel. */
  #walkFrom = 1;
  #walkT = -1;
  /** Aboard a cruising yacht, getting up from the wheel or sitting down: where each foot is carried to, in the model's frame; null when not. */
  #feetTo: [Vector3, Vector3] | null = null;
  readonly #feetC: [Vector3, Vector3] = [new Vector3(), new Vector3()];
  readonly #seatPlace = new Place();

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
    const cat = boat.cat ?? null;
    this.#clips =
      (by === undefined || by === null) && !trapeze && cat === null
        ? clips
        : new Map(
            [...clips].map(([name, c]) => [
              name,
              // Aboard a beach cat, placed from her model's places on the
              // clip's side (righting her, from where she lies).
              cat !== null && inCatFile(name)
                ? catClip(c, cat.aboard)
                : // On the wire, placed from the rack's edge on its side.
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
    const sided = (n: string): boolean =>
      !!this.#clips.get(n)?.place && !!this.#clips.get(n + PORT)?.place;
    this.#catted = cat !== null && CAT_SEATED.every(sided);
    this.#wired =
      !!trapeze &&
      (this.#catted
        ? [CAT_CLIPS.wireLow, CAT_CLIPS.wire].every(sided)
        : [TRAPEZE_CLIPS.low, TRAPEZE_CLIPS.out].every(sided));
    this.#floor = cat === null ? null : catFloor(cat);
    this.#legs = ['l', 'r']
      .map((sd) => [`thigh_${sd}`, `calf_${sd}`, `foot_${sd}`].map((b) => rig.bone(b)))
      .filter((l) => l.every((b) => b >= 0)) as [number, number, number][];
    this.#netted =
      this.#catted &&
      [...CAT_CLIPS.crouch.slice(1, 3), ...CAT_CLIPS.crawl].every(
        (n) => !!this.#clips.get(n)?.place,
      );
    const n = rig.names.length;
    this.#pose = new Pose(n).rest(rig);
    this.#scratch = new Pose(n).rest(rig);
    this.#from = new Pose(n).rest(rig);
    this.#satPose = new Pose(n).rest(rig);
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
    this.#yachted =
      !!boat.wheel &&
      boat.yacht != null &&
      [YACHT_CLIPS.wheel, YACHT_CLIPS.seated].every(sided) &&
      !!this.#clips.get(YACHT_CLIPS.cockpit)?.place;
    this.#bridged =
      !!boat.wheel && boat.bridge != null && [BRIDGE_CLIPS.wheel, BRIDGE_CLIPS.seated].every(sided);
    this.#clipRadius =
      (this.#yachted || this.#bridged) && boat.wheel ? boat.wheel.radius : CLIP_WHEEL_RADIUS;
    if (boat.wheel) {
      this.#gripsAtRest(boat.wheel);
    }
  }

  /** Aboard a cruising yacht, whether her helm is on her own clips. */
  get yachted(): boolean {
    return this.#yachted;
  }

  /** Aboard a cruising catamaran, whether her helm is on her own clips. */
  get bridged(): boolean {
    return this.#bridged;
  }

  /** Aboard a cruising yacht or catamaran, how far her helm is sat by the wheel: 0 standing, 1 sat. */
  get seat(): number {
    return this.#seat;
  }

  /** Aboard a cruising yacht, whether her helm is walking between her wheels. */
  get walking(): boolean {
    return this.#walkT >= 0;
  }

  /**
   * Where the wheel's clip holds the spokes at rest: each hand's grip at
   * its start, in the helmsman's frame, its angle from the top and the
   * spoke nearest it.
   */
  #gripsAtRest(wheel: WheelHelm): void {
    const n = wheel.spokes;
    const c = this.#clip(
      this.#yachted ? YACHT_CLIPS.wheel : this.#bridged ? BRIDGE_CLIPS.wheel : CLIPS.wheel,
      1,
    );
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

  /**
   * How far the sailor hikes: 0 sat in at the helm, 1 on the first hiking
   * depth, more beyond it (or out on a wire); 0 while crossing or not
   * sailing.
   */
  get depth(): number {
    return this.#depth;
  }

  /** Whether the sailor is crossing the boat. */
  get crossing(): boolean {
    return this.#cross !== null || this.#net !== null;
  }

  /** The side deck the sailor is crossing from, or sits on: + starboard, − port. */
  get crossFrom(): number {
    return this.#net !== null
      ? this.#net.from
      : this.#cross === null
        ? this.#side
        : this.#crossFrom;
  }

  /** How far through crossing the boat the sailor is, 0 to 1; 1 when not crossing. */
  get crossed(): number {
    if (this.#net !== null) {
      return this.#net.done;
    }
    const c = this.#cross;
    return c === null ? 1 : Math.min(1, this.#crossT / Math.max(c.duration, 1e-3));
  }

  /** On a beach cat, where the sailor crossing her net is across it (x, + starboard); null if not crossing it. */
  get netAt(): number | null {
    return this.#net?.x ?? null;
  }

  /** Whether the sailor is on a beach cat's own clips: sat on her hull, crossing her net. */
  get catted(): boolean {
    return this.#catted;
  }

  /** Whether, in the water, the sailor was thrown off over her bows. */
  get thrown(): boolean {
    return this.#thrown >= 0;
  }

  /**
   * Forgets the moments before: the next one seats the sailor afresh, on
   * the side its offset says, as a sailor first met (a boat moved at once).
   */
  reset(): void {
    this.#mode = -1;
    this.#cross = null;
    this.#net = null;
    this.#thrown = -1;
    this.#habit = null;
    this.#change = 1;
    this.#across = Number.NaN;
    this.#walkT = -1;
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
    if (this.#mode < 0 && this.#netted && s.boom !== undefined && Math.abs(s.boom) > BOOM_OVER) {
      // On a beach cat's hull, to windward of the boom.
      this.#side = -Math.sign(s.boom);
    }
    if (mode !== this.#mode) {
      this.#begin(mode, s);
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
    this.#depth = 0;
    const wheel = this.boat.wheel;
    if (wheel) {
      this.#atWheel(s, dt, wheel, pose, place);
    } else if (mode === IN_WATER) {
      this.#sample(CLIPS.water, 1, s.time + this.#helmOffset, true, pose);
      this.#waterPlace(s, place);
      if (this.#thrown >= 0) {
        this.#thrownPlace(s, dt, place);
      }
    } else if (mode === ON_BOARD) {
      const stand = this.boat.cat?.stand ?? null;
      const c = this.#catted && stand !== null ? this.#clip(CAT_CLIPS.righting, 1) : null;
      if (c !== null && c.place !== null && stand !== null) {
        // On her lower hull, upright in the world as she lies on her side.
        this.#sample(CAT_CLIPS.righting, 1, s.time + this.#helmOffset, true, pose);
        place.set(standPlace(c.place, stand, s.heel >= 0 ? 1 : -1, this.#righting));
      } else {
        this.#sample(CLIPS.board, 1, s.time + this.#helmOffset, true, pose);
        this.#boardPlace(s, place);
      }
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
      if (seated && this.#net === null && s.aft !== undefined && s.aft !== 0) {
        // Stepped aft along the hull to hold the bows up.
        place.at.z += s.aft;
      }
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
    // Going down onto hands and knees on the net or up off them: carried.
    let carry = this.#crawlCarry;
    this.#crawlCarry = -1;
    if (this.#change < 1) {
      this.#change = Math.min(1, this.#change + dt / CHANGE);
      if (this.#flat) {
        // Onto a beach cat's net or off it: each foot carried from where
        // the old pose had it to where the new one has it, over her hull's
        // edge, as the crew's are.
        this.#feetOf(this.#from, this.#fromPlace, this.#feetA);
        this.#feetOf(pose, place, this.#feetB);
        carry = this.#change;
      }
      if (this.#change >= 1) {
        this.#flat = false;
      }
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
    if (carry >= 0 && carry < 1) {
      this.#carryFeet(carry);
    }
    if (this.#feetTo !== null) {
      this.#feetStep(this.#feetTo);
    }

    // The layers.
    this.#heelAxis.set(0, 0, 1).applyQuaternion(q.copy(this.#placeNow.turn).invert());
    this.#layers.apply({
      dt,
      time: s.time,
      effort: this.#effort,
      heelAxis: this.#heelAxis,
      heel: s.heel,
      upright: (seated && !this.crossing) || wheel ? 0.5 : 0,
      still: s.still,
    });
    // Aboard a beach cat, sailing: over her net and decks, never through them.
    if (this.#floor !== null && this.#catted && mode === 0) {
      liftOver(this.rig, this.root, this.#floor);
    }

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
  #begin(mode: number, s: SailorMoment): void {
    const first = this.#mode < 0;
    this.#from.copy(this.#pose);
    this.#fromPlace.copy(this.#placeNow);
    // Thrown off over a beach cat's bows: through the air, ahead of her.
    this.#thrown =
      mode === IN_WATER &&
      !first &&
      this.#catted &&
      ((s.trim ?? 0) < -THROWN_TRIM || Math.abs(s.heel) < THROWN_HEEL)
        ? 0
        : -1;
    // Falling in is sudden: no frame between the seat and the water, where
    // the legs would come up through the deck.
    this.#change = first || (mode === IN_WATER && this.#thrown < 0) ? 1 : 0;
    this.#flat = false;
    this.#net = null;
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
    // To the side the physics puts the sailor; on a beach cat, to windward
    // of the boom, once it has come over past BOOM_OVER: across as it
    // comes, before it lies over the hull sat on.
    const want =
      this.#netted && s.boom !== undefined
        ? this.#side * s.boom > BOOM_OVER
          ? -this.#side
          : this.#side
        : Math.abs(s.offset) > 0.05
          ? Math.sign(s.offset)
          : this.#side;
    if (this.#netted) {
      if (this.#net === null && want !== this.#side && this.#change >= 1 && s.wayHeld !== true) {
        this.#beginNet(s);
      }
      if (this.#net !== null) {
        return this.#acrossNet(s, dt, pose, place);
      }
    } else if (this.#cross === null && want !== this.#side && this.#change >= 1) {
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
    this.#depth = h;
    const t = s.time + this.#helmOffset;
    // The helm and the hiking depths (or out on the wire), each by its
    // weight, and their places.
    const scratch = this.#scratch;
    pose.clear();
    let total = 0;
    let hanging = 0;
    const names = this.#catted ? (wired ? CAT_WIRED : CAT_SEATED) : wired ? WIRED : SEATED;
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
      if (k === 0 && this.#habit === null && !this.#catted) {
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

  /** Where a pose at a place has its feet, in the model's frame, into out. The rig is left posed so. */
  #feetOf(pose: Pose, place: Place, out: [Vector3, Vector3]): void {
    pose.to(this.rig);
    this.rig.fk();
    place.matrix(m4);
    for (let k = 0; k < 2; k++) {
      const foot = this.#legs[k]?.[2] ?? -1;
      if (foot >= 0) {
        this.rig.position(foot, out[k] as Vector3).applyMatrix4(m4);
      }
    }
  }

  /** The feet carried f of the way from #feetA to #feetB, up over the net's height and down, the legs bent to them. */
  #carryFeet(f: number): void {
    const cat = this.boat.cat;
    if (cat == null) {
      return;
    }
    const top = cat.aboard.net.y + NET_STEP;
    inv.copy(this.root).invert();
    for (let k = 0; k < 2; k++) {
      const leg = this.#legs[k];
      if (leg === undefined) {
        continue;
      }
      carried(this.#feetA[k] as Vector3, this.#feetB[k] as Vector3, f, p, top).applyMatrix4(inv);
      twoBone(this.rig, leg[0], leg[1], leg[2], p);
    }
  }

  /** Begins crossing a beach cat's net, from the side sat on: blended off the hull first. */
  #beginNet(s: SailorMoment): void {
    const cat = this.boat.cat as CatBoat;
    const way = netWay(cat.aboard);
    this.#net = new NetCross(
      this.#side,
      way.x,
      crawlFor(cat.boom, s.boom ?? 0, this.#side * way.x, way.z),
    );
    this.#habit = null;
    this.#from.copy(this.#pose);
    this.#fromPlace.copy(this.#placeNow);
    this.#change = 0;
    this.#flat = true;
    this.#netWait = NET_RISE * CHANGE;
  }

  /**
   * Across a beach cat's net, facing forward: at a crouch, on hands and
   * knees under the boom, the two blended as far as the boom asks; at the
   * other side, sat down on the hull there (blended on as a change).
   */
  #acrossNet(s: SailorMoment, dt: number, pose: Pose, place: Place): boolean {
    const n = this.#net as NetCross;
    const cat = this.boat.cat as CatBoat;
    const way = netWay(cat.aboard);
    let there = false;
    if (this.#netWait > 0) {
      this.#netWait -= dt;
    } else {
      there = n.step(dt, crawlFor(cat.boom, s.boom ?? 0, n.x, way.z));
    }
    const crouch = this.#clip(n.crouch);
    const crawl = this.#clip(n.crawlClip);
    const f = smooth(n.crawl);
    const scratch = this.#scratch;
    const dz = way.z - (cat.aboard.net.fore + cat.aboard.net.aft) / 2;
    // Each clip's place on the net's middle, moved across to where they are.
    (crouch?.place ?? m.identity()).decompose(v, q, w);
    (crawl?.place ?? m2.identity()).decompose(u, q2, w);
    v.x += n.x;
    v.z += dz;
    u.x += n.x;
    u.z += dz;
    scratch.rest(this.rig);
    crawl?.sample(n.crawlT % crawl.duration, scratch);
    pose.rest(this.rig);
    crouch?.sample(n.crouchT % crouch.duration, pose);
    if (f > 0 && f < 1) {
      // Each foot where either has it, to be carried between.
      this.#ends.at.copy(v);
      this.#ends.turn.copy(q);
      this.#feetOf(pose, this.#ends, this.#feetA);
      this.#ends.at.copy(u);
      this.#ends.turn.copy(q2);
      this.#feetOf(scratch, this.#ends, this.#feetB);
      this.#crawlCarry = f;
    }
    pose.mix(scratch, f);
    place.at.lerpVectors(v, u, f);
    place.turn.copy(q).slerp(q2, f);
    if (there) {
      // Across: sat down on the hull on the other side, blended from here.
      this.#side = -n.from;
      this.#net = null;
      this.#from.copy(pose);
      this.#fromPlace.copy(place);
      this.#change = 0;
      this.#flat = true;
      this.#springs.reset();
    }
    return true;
  }

  /**
   * Thrown off over her bows: landed in the water ahead of her front beam,
   * facing her; after THROWN_FOR, swimming round to her side, to where the
   * water's place is (place, as #waterPlace gave it).
   */
  #thrownPlace(s: SailorMoment, dt: number, place: Place): void {
    const cat = this.boat.cat;
    if (cat === undefined || cat === null) {
      return;
    }
    this.#thrown += dt;
    this.#beside.copy(place);
    this.#level(
      this.#side * THROWN_OUT,
      -s.heave,
      cat.aboard.net.fore - THROWN_AHEAD,
      0,
      s,
      this.#ahead,
    );
    const f = smooth((this.#thrown - THROWN_FOR) / SWIM_ROUND);
    place.at.lerpVectors(this.#ahead.at, this.#beside.at, f);
    place.turn.copy(this.#ahead.turn).slerp(this.#beside.turn, f);
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
    this.#feetTo = null;
    if (this.#yachted) {
      // Aboard a cruising yacht, to windward of the boom, as her crew: by
      // the wind only while it lies near the centreline.
      const boom = s.boom ?? 0;
      const side = Math.abs(boom) > BOOM_SIDE ? -Math.sign(boom) : want;
      this.#atYachtWheel(s, dt, wheel, side, pose, place);
      return;
    }
    if (this.#bridged) {
      this.#atBridgeWheel(s, dt, wheel, want, pose, place);
      return;
    }
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
    place.set(m.multiplyMatrices(this.#standAt(wheel, dt), c?.place ?? m2.identity()));
  }

  /**
   * Aboard a cruising yacht, at her windward wheel on her own clips: sat
   * by it or standing aft of it as the wind has them, blended as the legs
   * come in and the body goes down into the cockpit (the feet carried);
   * when the wind changes side, standing, then walking across between the
   * wheels at a crouch to stand at the other.
   */
  #atYachtWheel(
    s: SailorMoment,
    dt: number,
    wheel: WheelHelm,
    want: number,
    pose: Pose,
    place: Place,
  ): void {
    const yacht = this.boat.yacht as YachtPlaces;
    const spread = wheel.spread ?? 0;
    const heel = Math.abs(s.heel);
    this.#sits = this.#sits
      ? s.windSpeed < STAND_WIND && heel < STAND_HEEL
      : s.windSpeed < SIT_WIND && heel < SIT_HEEL;
    if (Number.isNaN(this.#across)) {
      // Met first: at the wheel the wind says, as the wind has them.
      this.#windward = want;
      this.#across = want * spread;
      this.#seat = this.#sits ? 1 : 0;
    }
    const t = s.time + this.#helmOffset;
    if (this.#walkT < 0) {
      const away = want !== this.#windward;
      const target = away || !this.#sits ? 0 : 1;
      const step = dt / SEAT_TIME;
      this.#seat += Math.max(-step, Math.min(step, target - this.#seat));
      if (away && this.#seat <= 0) {
        // Stood: across to the other wheel.
        this.#walkFrom = this.#windward;
        this.#walkT = 0;
        this.#habit = null;
      }
    }
    if (this.#walkT >= 0) {
      this.#walkBetween(dt, wheel, t, pose, place);
      return;
    }
    const side = this.#windward;
    this.#across = side * spread;
    this.#standFor(wheel);
    // Standing aft of the wheel, and now and then the habit over it.
    this.#sample(YACHT_CLIPS.wheel, side, t, true, pose);
    const stand = this.#clip(YACHT_CLIPS.wheel, side);
    place.set(yachtPlace(stand?.place ?? m2.identity(), yacht.stance, side, false, m));
    if (this.#seat <= 0) {
      if (this.#habit === null) {
        this.#maybeHabit(s, dt, 0, YACHT_CLIPS.habit, 1);
      }
      if (this.#habit !== null) {
        this.#habitStep(dt, pose);
      }
      return;
    }
    this.#habit = null;
    const sat = this.#clip(YACHT_CLIPS.seated, side);
    const seatPlace = this.#seatPlace.set(
      yachtPlace(sat?.place ?? m2.identity(), yacht.stance, side, false, m),
    );
    if (this.#seat >= 1) {
      this.#sample(YACHT_CLIPS.seated, side, t, true, pose);
      place.copy(seatPlace);
      return;
    }
    // Between: the body down into the cockpit or up out of it over the
    // first half (from standing), the legs along the deck over the second;
    // each foot carried from where standing has it to beside the hips on
    // the deck aft of the wheel, and on to where sat has it.
    const scratch = this.#scratch;
    scratch.rest(this.rig);
    sat?.sample(t % sat.duration, scratch);
    const body = smooth(Math.min(1, this.#seat * 2));
    const legs = smooth(Math.max(0, this.#seat * 2 - 1));
    this.#feetOf(pose, place, this.#feetA);
    this.#feetOf(scratch, seatPlace, this.#feetB);
    pose.mix(scratch, body);
    place.at.lerp(seatPlace.at, body);
    place.at.y += SEAT_ARC * Math.sin(Math.PI * body);
    place.turn.slerp(seatPlace.turn, body);
    const feet = this.#feetC;
    for (let k = 0; k < 2; k++) {
      const a = this.#feetA[k] as Vector3;
      const b = this.#feetB[k] as Vector3;
      // Drawn in: as sat, but aft of the wheel, beside the hips.
      v.set(b.x, b.y, yacht.stance.z - LEGS_IN);
      const f = feet[k] as Vector3;
      if (this.#seat < 0.5) {
        carried(a, v, body, f, b.y);
      } else {
        f.lerpVectors(v, b, legs);
      }
    }
    this.#feetTo = feet;
  }

  /**
   * Aboard a cruising yacht, walking between her wheels: up from the wheel
   * into the crouch's walk, across on the stance's line facing the way,
   * the feet still on the sole, and up to stand at the other wheel.
   */
  #walkBetween(dt: number, wheel: WheelHelm, t: number, pose: Pose, place: Place): void {
    const yacht = this.boat.yacht as YachtPlaces;
    const spread = wheel.spread ?? 0;
    const from = this.#walkFrom;
    const c = this.#clip(YACHT_CLIPS.cockpit) as Clip;
    const speed = YACHT_CROSS_SPEED[YACHT_CLIPS.cockpit] ?? 0.7;
    // Short of the other wheel's stance: the crouch's head is well ahead of its hips.
    const length = 2 * spread - STANCE_SHORT;
    const walk = length / speed;
    this.#walkT += dt;
    const wt = this.#walkT;
    const along = Math.max(0, Math.min(length, (wt - WALK_RISE) * speed));
    // The walk, along the stance's line, facing the way.
    const scratch = this.#scratch;
    scratch.rest(this.rig);
    c.sample((feetTogether(c, this.rig) + along / speed) % c.duration, scratch);
    const x = from * (spread - along);
    this.#across = x;
    this.#standFor(wheel);
    // Set ahead of its hips: the hips on the stance's line.
    const at = this.#walkAt.set(
      x - from * YACHT_WALK_AHEAD,
      yacht.stance.y + (c.place?.elements[13] ?? 0),
      yacht.stance.z,
    );
    const turn = this.#walkTurn.setFromAxisAngle(Y, -from * (Math.PI / 2));
    if (wt < WALK_RISE || wt > WALK_RISE + walk) {
      // From standing at the wheel, or to standing at the other.
      const side = wt < WALK_RISE ? from : -from;
      const f = wt < WALK_RISE ? 1 - wt / WALK_RISE : (wt - WALK_RISE - walk) / WALK_STAND;
      this.#sample(YACHT_CLIPS.wheel, side, t, true, pose);
      const stand = this.#clip(YACHT_CLIPS.wheel, side);
      place.set(yachtPlace(stand?.place ?? m2.identity(), yacht.stance, side, false, m));
      const g = smooth(Math.min(1, f));
      scratch.mix(pose, g);
      pose.copy(scratch);
      place.at.lerpVectors(at, place.at, g);
      this.#placeTurn.copy(place.turn);
      place.turn.copy(turn).slerp(this.#placeTurn, g);
      if (wt >= WALK_RISE + walk + WALK_STAND) {
        // There: standing at the other wheel.
        this.#windward = -from;
        this.#across = -from * spread;
        this.#walkT = -1;
      }
      return;
    }
    pose.copy(scratch);
    place.at.copy(at);
    place.turn.copy(turn);
  }

  /**
   * Aboard a cruising catamaran, at her wheel on her own clips: looking to
   * windward (the two sides blended while the wind changes side), sat on
   * the settle behind the stance or standing at the wheel as the apparent
   * wind has her, blended as the helm steps back and sits down (or gets up
   * and steps forward), the feet carried; and now and then the habit,
   * standing.
   */
  #atBridgeWheel(
    s: SailorMoment,
    dt: number,
    wheel: WheelHelm,
    want: number,
    pose: Pose,
    place: Place,
  ): void {
    const bridge = this.boat.bridge as BridgePlaces;
    this.#sits = this.#sits ? s.windSpeed < STAND_WIND : s.windSpeed < SIT_WIND;
    if (Number.isNaN(this.#across)) {
      // Met first: as the wind has the helm.
      this.#windward = want;
      this.#windwardChange = 1;
      this.#seat = this.#sits ? 1 : 0;
    }
    this.#across = 0;
    if (want !== this.#windward && this.#windwardChange >= 1) {
      this.#windward = want;
      this.#windwardChange = 0;
    }
    this.#windwardChange = Math.min(1, this.#windwardChange + dt / WINDWARD_CHANGE);
    const step = dt / SEAT_TIME;
    this.#seat += Math.max(-step, Math.min(step, (this.#sits ? 1 : 0) - this.#seat));
    this.#standFor(wheel);
    const t = s.time + this.#helmOffset;
    const side = this.#windward;
    // Standing at the wheel, looking to windward.
    this.#sideways(BRIDGE_CLIPS.wheel, side, t, pose);
    const stand = this.#clip(BRIDGE_CLIPS.wheel, side);
    place.set(bridgePlace(stand?.place ?? m2.identity(), bridge.stance, m));
    if (this.#seat <= 0) {
      if (this.#habit === null) {
        this.#maybeHabit(s, dt, 0, BRIDGE_CLIPS.habit, 1);
      }
      if (this.#habit !== null) {
        this.#habitStep(dt, pose);
      }
      return;
    }
    this.#habit = null;
    const sat = this.#clip(BRIDGE_CLIPS.seated, side);
    const seatPlace = this.#seatPlace.set(
      bridgePlace(sat?.place ?? m2.identity(), bridge.stance, m),
    );
    if (this.#seat >= 1) {
      this.#sideways(BRIDGE_CLIPS.seated, side, t, pose);
      place.copy(seatPlace);
      return;
    }
    // Between: stepping back to the settle and sitting down on it (or up
    // and forward), the feet carried from where standing has them to where
    // sat has them.
    const scratch = this.#satPose;
    this.#sideways(BRIDGE_CLIPS.seated, side, t, scratch);
    const f = smooth(this.#seat);
    this.#feetOf(pose, place, this.#feetA);
    this.#feetOf(scratch, seatPlace, this.#feetB);
    pose.mix(scratch, f);
    place.at.lerp(seatPlace.at, f);
    place.turn.slerp(seatPlace.turn, f);
    const feet = this.#feetC;
    for (let k = 0; k < 2; k++) {
      carried(
        this.#feetA[k] as Vector3,
        this.#feetB[k] as Vector3,
        f,
        feet[k] as Vector3,
        Number.NEGATIVE_INFINITY,
      );
    }
    this.#feetTo = feet;
  }

  /** A clip at the wheel looking to windward on side, the other side's blended in while the wind changes side, into out. */
  #sideways(name: string, side: number, t: number, out: Pose): void {
    this.#sample(name, side, t, true, out);
    if (this.#windwardChange < 1) {
      const other = this.#scratch;
      this.#sample(name, -side, t, true, other);
      other.mix(out, smooth(this.#windwardChange));
      out.copy(other);
    }
  }

  readonly #placeTurn = new Quaternion();
  readonly #walkAt = new Vector3();
  readonly #walkTurn = new Quaternion();

  /** The helmsman's frame and the wheel the hands are on, for where they stand across now (#across). */
  #standFor(wheel: WheelHelm): void {
    const spread = wheel.spread ?? 0;
    this.#stand.copy(wheel.stand);
    this.#stand.elements[12] = (this.#stand.elements[12] ?? 0) + this.#across;
    this.#hubAt.copy(wheel.hub);
    this.#hubAt.x += this.#across >= 0 ? spread : -spread;
  }

  /** Each leg bent to put its foot where it is carried to (the model's frame). */
  #feetStep(to: [Vector3, Vector3]): void {
    inv.copy(this.root).invert();
    for (let k = 0; k < 2; k++) {
      const leg = this.#legs[k];
      if (leg === undefined) {
        continue;
      }
      p.copy(to[k] as Vector3).applyMatrix4(inv);
      twoBone(this.rig, leg[0], leg[1], leg[2], p);
    }
  }

  /** Where the helmsman stands: the stand; of two wheels, aft of the windward one, walked across to the other. */
  readonly #stand = new Matrix4();
  readonly #hubAt = new Vector3();
  #across = Number.NaN;
  #standAt(wheel: WheelHelm, dt: number): Matrix4 {
    const spread = wheel.spread ?? 0;
    const want = spread * this.#windward;
    if (Number.isNaN(this.#across)) {
      this.#across = want;
    }
    const step = WHEEL_WALK * dt;
    this.#across += Math.max(-step, Math.min(step, want - this.#across));
    this.#stand.copy(wheel.stand);
    this.#stand.elements[12] = (this.#stand.elements[12] ?? 0) + this.#across;
    // The wheel the hands are on: the one the helmsman is nearer.
    this.#hubAt.copy(wheel.hub);
    this.#hubAt.x += this.#across >= 0 ? spread : -spread;
    return this.#stand;
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
      w.copy(h.home).applyMatrix4(this.#stand);
      const spread = wheel.spread ?? 0;
      // At two wheels, off the one it is at the helmsman lets go.
      const off = spread > 0 ? Math.abs(Math.abs(this.#across) - spread) : 0;
      // Sat by a cruising yacht's wheel, a hand on its rim as the clip has it.
      const near =
        (1 - smooth((off - AT_WHEEL_NEAR) / (AT_WHEEL_FAR - AT_WHEEL_NEAR))) *
        (this.#walkT >= 0 ? 0 : 1 - this.#seat);
      const hold = near * (1 - smooth((v.distanceTo(w) - HOLD_NEAR) / (HOLD_FAR - HOLD_NEAR)));
      u.subVectors(v, this.#hubAt);
      // Its place against its grip at rest: across the spoke and off the
      // wheel, brought in to a smaller wheel's rim.
      const r = Math.hypot(u.x, u.y) * (wheel.radius / this.#clipRadius);
      const drift = Math.atan2(u.x, u.y) - h.angle;
      // The spoke it holds: changed for the next when the wheel has carried
      // it too far, the other hand holding meanwhile.
      const other = this.#wheelHands[1 - k];
      const now = wheel.turn + h.spoke * step;
      const away = wrap(now - h.angle);
      if (
        h.next < 0 &&
        (Math.abs(away) > SPOKE_MOST || (Math.abs(away) > SPOKE_LEAD && (other?.next ?? -1) < 0))
      ) {
        const n = wheel.spokes;
        h.next = (((Math.round((h.angle - wheel.turn) / step) % n) + n) % n) as number;
        h.change = 0;
        if (h.next === h.spoke) {
          h.next = -1;
        }
      }
      let angle = now;
      let lift = 0;
      if (h.next >= 0) {
        h.change = Math.min(1, h.change + dt / REGRIP);
        const to = wheel.turn + h.next * step;
        angle = now + wrap(to - now) * smooth(h.change);
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
      const hub = this.#hubAt;
      p.set(hub.x + r * Math.sin(a), hub.y + r * Math.cos(a), hub.z + u.z + lift);
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
   * from her as she comes up. A boat of two hulls' is the lower hull's
   * keel.
   */
  #boardPlace(s: SailorMoment, place: Place): void {
    const board = this.boat.solid.board;
    // The board's top face, as the boat lies: the face nearer the sky.
    this.#levelTurn(s, q);
    u.set(0, 1, 0).applyQuaternion(q.invert());
    const face = u.x >= 0 ? 1 : -1;
    const low = s.heel >= 0 ? 1 : -1;
    place.at.set(low * board.x + face * (board.thickness / 2), board.y - BOARD_ALONG, board.z);
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
    // Onto a beach cat's net or off it: up over the hull's edge, not out.
    const flat = this.#flat;
    u.set(
      flat ? (v.x + w.x) / 2 : side * Math.max(side * v.x, side * w.x) + side * ARC_OUT * bow,
      Math.max(v.y, w.y) + (flat ? NET_ARC_UP : ARC_UP) * bow,
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
    const crossing = this.#cross !== null || this.#net !== null;
    const side = crossing ? (this.crossed < 0.75 ? this.crossFrom : -this.crossFrom) : this.#side;
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
    const side = this.crossing ? this.crossFrom : this.#side;
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
    wd.seated = seated && this.#mode === 0 && !this.crossing && this.hands.wire < OFF_SEAT;
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

/**
 * A clip of a beach cat's people's file placed in her model: from its place
 * on her starboard side (its mirror, a -port clip's), or, righting her, as
 * it is (placed from where she lies, as she lies).
 */
function catClip(c: Clip, aboard: Aboard): Clip {
  const anchor = catAnchor(c.name);
  const at = anchor === null ? null : catPoint(aboard, anchor);
  if (c.place === null || at === null) {
    return c;
  }
  return new Clip(c.name, c.duration, c.tracks, catPlace(c.place, at, catSide(c.name)));
}
