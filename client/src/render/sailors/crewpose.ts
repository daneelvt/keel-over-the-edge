// SPDX-License-Identifier: AGPL-3.0-only

// What a crew member's body is posed in, for what the rules have them
// doing (crewrules.ts): at a station, its clip sitting up and its clip
// leaning out, blended by how far they lean; getting up from a place into
// the crouch's walk at the start of a path, walking along it, and sitting
// down out of it at its end, each blended. The clips are their look's: the
// helm's seated, the first hiking depth's, standing-idle, and the rail's
// and the crouch's (rail.ts). Aboard a beach cat, her own (cat.ts): sat on
// her hull and out on the wire, across her net at a crouch or on hands and
// knees, and righting her on her lower hull. After a capsize, in the water
// (treading it, the helm's clip) off the high side, and climbing back.
// Aboard a cruising yacht, her own (yacht.ts): at her wheel, sat on her
// bench at ease (the ship's sitting idles, one at a time by the world's
// time, talking only with someone near) and braced, on her rail sitting up
// and leaning out, and walking her ways at a crouch. Aboard a cruising
// catamaran, her own (bridgedeck.ts): on each of her seats its idles (at
// ease, talking only with someone near) and, at her table and on her aft
// bench, braced; at her wheel standing, for the helm walking to or from it;
// walking her ways upright, and up and down her helm's ladder.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { BoatStation, StationPose } from '../../catalog';
import {
  BRIDGE_CLIPS,
  BRIDGE_NOT_FOR_MACHINES,
  BRIDGE_SEATS,
  BRIDGE_WALK_SPEED,
  type BridgeBoat,
  type BridgeLadder,
  bridgePlace,
  facingDir,
  seatAnchor,
  seatOf,
} from './bridgedeck';
import {
  CAT_CLIPS,
  type CatBoat,
  catAnchor,
  catPlace,
  catPoint,
  type NetCross,
  netWay,
  standPlace,
} from './cat';
import { type Clip, feetTogether } from './clips';
import { blend, type CrewBody, type Life, placeStance, type Stance } from './crewbody';
import {
  CLIMB,
  type CrewMember,
  type CrewPath,
  type CrewSpot,
  type CrewWet,
  moveAt,
  STRIDE,
} from './crewrules';
import type { FleetSeat } from './fleetlooks';
import { CROUCH_CLIPS, CROUCH_SPEED, RAIL_CLIPS, railPlace } from './rail';
import type { Rig } from './rig';
import { CLIPS, SWIM_ROUND, THROWN_AHEAD, THROWN_FOR, THROWN_OUT } from './runtime';
import { idleAt } from './shiprules';
import { type HullSolid, reach } from './solid';
import {
  YACHT_CLIPS,
  YACHT_NOT_FOR_MACHINES,
  YACHT_WALK_AHEAD,
  type YachtBoat,
  type YachtWays,
  yachtPlace,
} from './yacht';

/**
 * Where a station's person is drawn, into out: the station's own point and
 * facing; or, to windward, on the side side (+1 starboard) — the station's
 * mirror on the other side — and, while crossing from side to the other,
 * crossed of the way across (0 to 1) as a straight line would have it.
 */
export function stationPlace(
  s: BoatStation,
  side: number,
  crossed: number,
  out: { at: [number, number, number]; facing: number },
): { at: [number, number, number]; facing: number } {
  const [x, y, z] = s.at as [number, number, number];
  if (s.windward !== true) {
    out.at[0] = x;
    out.at[1] = y;
    out.at[2] = z;
    out.facing = s.facing;
    return out;
  }
  const own = x < 0 ? -1 : 1;
  const xa = side === own ? x : -x;
  const fa = side === own ? s.facing : 360 - s.facing;
  const f = Math.max(0, Math.min(1, crossed));
  out.at[0] = f >= 1 ? xa : xa - 2 * xa * f;
  out.at[1] = y;
  out.at[2] = z;
  out.facing = fa;
  return out;
}

/** Turning more than a quarter round in getting up or sitting down: by way of facing forward. */
export const BY_THE_BOW = Math.PI;
/** How high the body is carried, at the middle of getting up or sitting down, over the line between: the legs brought in over the deck's edge, m. */
export const RISE_ARC = 0.3;

/** How high the body is lifted at the middle of stepping over something, m. */
export const OVER_ARC = 0.15;

const m = new Matrix4();
const m2 = new Matrix4();
const v = new Vector3();
const w = new Vector3();
const spot = { at: [0, 0, 0] as [number, number, number], facing: 0 };
const along = { x: 0, y: 0, z: 0 };
const where = { rise: 0, along: 0, sit: 0 };
const theBlend = blend();

/** Where the seat is under a figure seated by a clip, in the figure's space: the clips' boat's seat, by the clip's place. */
function seatUnder(clip: Clip, seat: FleetSeat, out: Vector3): Vector3 {
  out.set(seat.out, seat.y, seat.z);
  return clip.place === null ? out : out.applyMatrix4(m.copy(clip.place).invert());
}

/** The clips a pose is drawn in, sitting up and leaning out: the rail's, the helm's and hiking, hiking, or standing. */
export function clipsOf(pose: StationPose): [string, string] {
  switch (pose) {
    case 'rail':
      return [RAIL_CLIPS.up, RAIL_CLIPS.out];
    case 'seated':
    case 'bench':
      return [CLIPS.helm, CLIPS.hiking[0] as string];
    case 'hiking':
      return [CLIPS.hiking[0] as string, CLIPS.hiking[0] as string];
    default:
      return [CLIPS.standing, CLIPS.standing];
  }
}

/** What posing someone needs: the kind's stations, the clips' seat, the look's clips, and the moment. */
export interface PoseInput {
  stations: readonly BoatStation[];
  seat: FleetSeat;
  clips: Map<string, Clip>;
  /** The person's own clip time, seconds. */
  time: number;
  /** How far they duck, 0 to 1. */
  duck: number;
  life: Life;
  /** Two stances to fill. */
  a: Stance;
  b: Stance;
  /** Aboard a beach cat, her places; and how far aft of their places her helm stands, which her crew stand beside (m). */
  cat?: CatBoat | null;
  aft?: number;
  /** Aboard a cruising yacht, her deck; the world's time (s), which picks the idle on her bench; and whether the look is a machine's. */
  cruiser?: YachtBoat | null;
  world?: number;
  machine?: boolean;
  /** Aboard a cruising yacht, the idle on her bench to sit in, sitting up: set by the pose for the moment. */
  idle?: string | undefined;
  /** Aboard a cruising yacht, her ways (crewrules.ts's waysOf): where on her rail its clips are placed from. */
  ways?: YachtWays | null;
  /** Aboard a cruising catamaran, her deck: her people on her own clips. */
  bridge?: BridgeBoat | null;
  /** The boat as it lies, for those in the water: its heel and pitch (radians), heave (m), hull and pivot's height. */
  level?: Level | null;
}

/** The boat as it lies, for those in the water. */
export interface Level {
  heel: number;
  pitch: number;
  heave: number;
  cog: number;
  solid: HullSolid | null;
}

/**
 * A place's stance (a station's, or the helm's, -1, as station 0's) on a
 * side, sitting up (0) or leaning out (1), at t seconds into its clip, into
 * into; false if its clip is not there.
 */
export function spotStance(
  input: Pick<
    PoseInput,
    'stations' | 'seat' | 'clips' | 'cat' | 'aft' | 'cruiser' | 'idle' | 'ways' | 'bridge'
  >,
  at: CrewSpot,
  out: 0 | 1,
  t: number,
  into: Stance,
): boolean {
  const st = input.stations[Math.max(0, at.station)];
  const clips = input.clips;
  if (st === undefined) {
    return false;
  }
  const yacht = input.cruiser ?? null;
  if (yacht !== null && yachtStance(input, yacht, at, out, t, into)) {
    return true;
  }
  const bridge = input.bridge ?? null;
  if (bridge !== null && bridgeStance(input, bridge, at, out, t, into)) {
    return true;
  }
  if (at.station < 0 || st.windward === true) {
    // On the side asked: its point or its mirror.
    const own = (st.at[0] as number) < 0 ? -1 : 1;
    spot.at[0] = at.side === own ? (st.at[0] as number) : -(st.at[0] as number);
    spot.at[1] = st.at[1] as number;
    spot.at[2] = st.at[2] as number;
    spot.facing = at.side === own ? st.facing : (360 - st.facing) % 360;
  } else {
    stationPlace(st, at.side, 1, spot);
  }
  let pose = st.pose;
  const cat = input.cat ?? null;
  if (cat !== null && (pose === 'hull' || at.station <= 0)) {
    // Aboard a beach cat: sat on her hull and out on the wire (her crew),
    // or at her helm sat on it and sitting out; aft beside her helm.
    const names: readonly string[] =
      pose === 'hull' ? [CAT_CLIPS.crew, CAT_CLIPS.crewWire] : [CAT_CLIPS.helm, CAT_CLIPS.hike];
    const name = names[out] as string;
    const c = clips.get(`${name}${at.side < 0 ? '-port' : ''}`);
    const anchor = catAnchor(name);
    const point = anchor === null ? null : catPoint(cat.aboard, anchor, v);
    if (c?.place != null && point !== null) {
      point.z += input.aft ?? 0;
      into.clip = c;
      into.t = t;
      placeStance(into, catPlace(c.place, point, at.side, m));
      return true;
    }
  }
  if (pose === 'rail') {
    const c = clips.get(`${clipsOf(pose)[out]}${at.side < 0 ? '-port' : ''}`);
    if (c?.place != null) {
      v.set(Math.abs(spot.at[0]), spot.at[1], spot.at[2]);
      into.clip = c;
      into.t = t;
      placeStance(into, railPlace(c.place, v, at.side));
      return true;
    }
    // Without the rail's clips: seated at its edge.
    pose = 'seated';
  }
  const c = clips.get(clipsOf(pose)[out]) ?? null;
  if (c === null) {
    return false;
  }
  into.clip = c;
  into.t = t;
  // The figure faces +z; turned to face the station's way, its seat (or its feet) on the point.
  const under = pose === 'standing' ? v.set(0, 0, 0) : seatUnder(c, input.seat, v);
  m.makeTranslation(spot.at[0], spot.at[1], spot.at[2])
    .multiply(m2.makeRotationY(Math.PI - (spot.facing * Math.PI) / 180))
    .multiply(m2.makeTranslation(-under.x, -under.y, -under.z));
  placeStance(into, m);
  return true;
}

/**
 * Aboard a cruising yacht, a place's stance on her own clips, into into:
 * the helm's (-1) at the windward wheel standing; on her bench, the idle
 * asked for sitting up (her own `bench` if none), braced leaning out; on
 * her rail, sitting up or leaning out; each from its place on the side
 * asked. False if the clip is not there.
 */
function yachtStance(
  input: Pick<PoseInput, 'stations' | 'clips' | 'idle' | 'ways'>,
  yacht: YachtBoat,
  at: CrewSpot,
  out: 0 | 1,
  t: number,
  into: Stance,
): boolean {
  const st = input.stations[Math.max(0, at.station)];
  const port = at.side < 0 ? '-port' : '';
  let name: string;
  let point: Vector3;
  let turn = false;
  if (at.station < 0) {
    name = `${YACHT_CLIPS.wheel}${port}`;
    point = v.copy(yacht.places.stance);
  } else if (st?.pose === 'bench') {
    if (out === 1) {
      name = `${YACHT_CLIPS.braced}${port}`;
    } else {
      // The idles have no -port: turned about her middle onto the port bench.
      name = input.idle ?? (YACHT_CLIPS.bench[0] as string);
      turn = true;
    }
    point = v.set(Math.abs(st.at[0] as number), st.at[1] as number, st.at[2] as number);
  } else if (st?.pose === 'rail') {
    name = `${out === 1 ? YACHT_CLIPS.railOut : YACHT_CLIPS.rail}${port}`;
    const z = st.at[2] as number;
    point = v.set(input.ways?.railX(z) ?? Math.abs(st.at[0] as number), st.at[1] as number, z);
  } else {
    return false;
  }
  const c = input.clips.get(name) ?? null;
  if (c === null || c.place === null) {
    return false;
  }
  into.clip = c;
  into.t = t;
  yachtPlace(c.place, point, at.side, turn, m);
  if (st?.pose === 'rail' && at.station >= 0 && input.ways != null) {
    // Square to her deck's edge where it turns (toward her bow).
    const a = 0.5 * input.ways.railTurn(st.at[2] as number) * at.side;
    m.premultiply(m2.makeTranslation(-at.side * point.x, -point.y, -point.z))
      .premultiply(m2.makeRotationY(a))
      .premultiply(m2.makeTranslation(at.side * point.x, point.y, point.z));
  }
  placeStance(into, m);
  return true;
}

/**
 * Aboard a cruising catamaran, a place's stance on her own clips, into
 * into: the helm's (-1) standing at her wheel; on a seat of hers, the idle
 * asked for sitting up (its first if none), braced in a breeze where it
 * has a braced clip (at her table and on her aft bench), the hand or the
 * leg toward the table's middle or her aft bench's ends; each placed from
 * its seat's front edge abreast of the station. False if the clip is not
 * there.
 */
function bridgeStance(
  input: Pick<PoseInput, 'stations' | 'clips' | 'idle'>,
  bridge: BridgeBoat,
  at: CrewSpot,
  out: 0 | 1,
  t: number,
  into: Stance,
): boolean {
  const st = input.stations[Math.max(0, at.station)];
  if (st === undefined) {
    return false;
  }
  let name: string;
  if (at.station < 0) {
    name = BRIDGE_CLIPS.wheel;
    anchor.at.copy(bridge.places.stance.at);
    anchor.facing = 0;
  } else {
    const seat = seatOf(bridge, st);
    if (seat === null) {
      return false;
    }
    const family = BRIDGE_SEATS[seat.family];
    seatAnchor(seat, st, anchor);
    const idle = input.idle !== undefined && family.idles.includes(input.idle) ? input.idle : null;
    name =
      out === 1 && family.braced !== null
        ? `${family.braced}${bracedSide(bridge, seat.family, anchor) < 0 ? '-port' : ''}`
        : (idle ?? (family.idles[0] as string));
  }
  const c = input.clips.get(name) ?? null;
  if (c === null || c.place === null) {
    return false;
  }
  into.clip = c;
  into.t = t;
  placeStance(into, bridgePlace(c.place, anchor, m));
  return true;
}

const anchor = { at: new Vector3(), facing: 0 };

/**
 * Aboard a cruising catamaran, the side a braced clip is on at a seat's
 * place: at her table, its right hand on the table's edge (+1), or its
 * mirror's left (−1), whichever is toward the table's middle; on her aft
 * bench, its left leg braced out (+1), or its mirror's right, whichever
 * is toward the nearer end of the bench.
 */
export function bracedSide(
  bridge: BridgeBoat,
  family: string,
  at: { at: Vector3; facing: number },
): number {
  const [dx, dz] = facingDir(at.facing);
  // The figure's right, facing that way: ahead turned a quarter to starboard.
  const rx = -dz;
  const rz = dx;
  if (family === 'table' && bridge.table !== null) {
    const t = bridge.table;
    const toward = ((t.x0 + t.x1) / 2 - at.at.x) * rx + ((t.z0 + t.z1) / 2 - at.at.z) * rz;
    return toward >= 0 ? 1 : -1;
  }
  const seat = bridge.seats.find((s) => s.family === family);
  if (seat === undefined) {
    return 1;
  }
  const along = Math.abs(dx) < 0.5 ? at.at.x : at.at.z;
  const middle = (seat.along[0] + seat.along[1]) / 2;
  // Along the edge, the figure's left is the way of −right.
  const left = Math.abs(dx) < 0.5 ? -rx : -rz;
  return (along - middle) * left >= 0 ? 1 : -1;
}

/** The idles on a cruising catamaran's seat this look can play now: a machine has not some, and talking needs someone near. */
function seatIdle(input: PoseInput, idles: readonly string[], company: boolean, i: number): string {
  const name = idles[i] as string;
  const talk = i === 3;
  return input.clips.has(name) &&
    !(input.machine === true && BRIDGE_NOT_FOR_MACHINES.includes(name)) &&
    (company || !talk)
    ? name
    : (idles[0] as string);
}

/** Of her ladder, how much at each end the climb is blended with the walk: in from it, and out to it. */
const LADDER_BLEND = 0.08;

/**
 * Aboard a cruising catamaran, s along a walk with her ladder on it, into
 * into: the ladder's clip, up from its foot or down from its head, played
 * through as far as they have come up or down it; placed from where it was
 * made. False if the clip is not there.
 */
function ladderStance(
  input: PoseInput,
  bridge: BridgeBoat,
  ladder: BridgeLadder,
  s: number,
  into: Stance,
): boolean {
  const name = ladder.up ? BRIDGE_CLIPS.up : BRIDGE_CLIPS.down;
  const c = input.clips.get(name) ?? null;
  if (c === null || c.place === null) {
    return false;
  }
  const f = Math.max(0, Math.min(1, (s - ladder.s0) / Math.max(1e-6, ladder.s1 - ladder.s0)));
  into.clip = c;
  into.t = Math.min(f * c.duration, c.duration - 1e-3);
  placeStance(
    into,
    bridgePlace(c.place, ladder.up ? bridge.places.foot : bridge.places.landing, m),
  );
  return true;
}

/**
 * Aboard a cruising catamaran, her upright walk s along a path into into:
 * whole steps on each stretch walked (from its start, or from the ladder's
 * head or foot, to the next), the feet together at each end; they keep
 * their place on her floor, a step's length the walk's own.
 */
function bridgeWalk(
  clips: Map<string, Clip>,
  rig: Rig,
  path: CrewPath,
  ladder: BridgeLadder | null,
  s: number,
  into: Stance,
): boolean {
  const c = clips.get(BRIDGE_CLIPS.walk) ?? null;
  const yaw = path.at(s, along);
  into.clip = c;
  const stride = c === null ? 1 : (c.duration * BRIDGE_WALK_SPEED) / 2;
  let from = 0;
  let to = path.length;
  if (ladder !== null) {
    if (s <= ladder.s0) {
      to = ladder.s0;
    } else {
      from = ladder.s1;
    }
  }
  const length = Math.max(1e-6, to - from);
  const paces = Math.max(1, Math.round(length / stride));
  const pace = (paces * stride) / length;
  into.t = (c === null ? 0 : feetTogether(c, rig)) + ((s - from) * pace) / BRIDGE_WALK_SPEED;
  into.at.set(along.x, along.y + (c?.place?.elements[13] ?? 0), along.z);
  into.yaw = yaw;
  into.tilt.identity();
  return c !== null;
}

/** The idles on a cruising yacht's bench this look can play now: a machine has not some, and talking needs someone near. */
function benchIdle(input: PoseInput, company: boolean, i: number): string {
  const name = YACHT_CLIPS.bench[i] as string;
  const talk = name === YACHT_CLIPS.bench[3];
  return input.clips.has(name) &&
    !(input.machine === true && YACHT_NOT_FOR_MACHINES.includes(name)) &&
    (company || !talk)
    ? name
    : (YACHT_CLIPS.bench[0] as string);
}

const idle = { now: 0, was: 0, f: 1 };

/** The crouch's walk s along a path, into into: begun with the feet side by side; they keep their place on the deck, a step's length the clip's speed. */
export function walkStance(
  clips: Map<string, Clip>,
  rig: Rig,
  path: CrewPath,
  s: number,
  into: Stance,
  name: string = CROUCH_CLIPS.walk,
  /** How far ahead of the path's point the figure is set, m: its hips on it. */
  ahead = 0,
): boolean {
  const c = clips.get(name) ?? null;
  const yaw = path.at(s, along);
  into.clip = c;
  // Whole steps along the path; from its start, or from the end of the last
  // step or stretch stepped over before s (or the start of the next), with
  // the feet together there, so that each is stepped from feet together to
  // feet together.
  const pace = path.length > 0 ? (path.paces * STRIDE) / path.length : 1;
  let from = 0;
  for (const o of path.anchors) {
    if (o[1] <= s) {
      from = o[1];
    } else if (s <= o[0] && from === 0) {
      from = o[0];
      break;
    }
  }
  into.t = (c === null ? 0 : feetTogether(c, rig)) + ((s - from) * pace) / CROUCH_SPEED;
  // Placed on a deck of its own (a cruising yacht's), as high over it as there.
  into.at.set(
    along.x + ahead * Math.sin(yaw),
    along.y + (c?.place?.elements[13] ?? 0),
    along.z + ahead * Math.cos(yaw),
  );
  into.yaw = yaw;
  into.tilt.identity();
  return c !== null;
}

/** Poses a member's body for what the rules have them doing. */
export function poseMember(body: CrewBody, member: CrewMember, input: PoseInput): void {
  const wet = member.wet ?? null;
  if (wet !== null && input.level != null) {
    poseWet(body, member, wet, input, input.level);
    return;
  }
  if (member.moving?.net != null && input.cat != null) {
    poseAcross(body, member, input, input.cat);
    return;
  }
  const mv = member.moving;
  const lean = smooth(member.lean);
  const t = input.time;
  let a = input.a;
  let b: Stance | null = input.b;
  const how = theBlend;
  how.f = lean;
  how.via = null;
  how.arc = 0;
  how.narrowA = 0;
  how.narrowB = 0;
  how.carry = false;
  how.top = Number.NEGATIVE_INFINITY;
  let upright = input.life.upright;
  const walk = input.cruiser != null ? YACHT_CLIPS.cockpit : CROUCH_CLIPS.walk;
  const bridge = input.bridge ?? null;
  const ahead = input.cruiser != null ? YACHT_WALK_AHEAD : 0;
  how.legs = 1;
  how.hands = Number.NEGATIVE_INFINITY;
  // Aboard a cruising yacht, on her bench: the idle now, by the world's time.
  input.idle = undefined;
  const at0: CrewSpot =
    mv === null || mv.t < 0 ? (mv?.from ?? { station: member.station, side: member.side }) : mv.to;
  const st0 = input.stations[at0.station];
  const seat0 =
    bridge !== null && st0 !== undefined && at0.station >= 0 ? seatOf(bridge, st0) : null;
  const idles = seat0 === null ? null : BRIDGE_SEATS[seat0.family].idles;
  const pick =
    idles !== null
      ? (i: number): string => seatIdle(input, idles, member.company === true, i)
      : (i: number): string => benchIdle(input, member.company === true, i);
  if ((input.cruiser != null && st0?.pose === 'bench') || idles !== null) {
    idleAt(member.seat, input.world ?? 0, idles?.length ?? YACHT_CLIPS.bench.length, idle);
    input.idle = pick(idle.now);
    if ((mv === null || mv.t < 0) && member.lean <= 0 && idle.f < 1) {
      // One idle going over into the next.
      const now = input.idle;
      input.idle = pick(idle.was);
      spotStance(input, at0, 0, t, a);
      input.idle = now;
      if (!spotStance(input, at0, 0, t, b)) {
        b = null;
      }
      how.f = smooth(idle.f);
      const life = input.life;
      const was = life.upright;
      body.pose(a, b, how, input.duck, life);
      life.upright = was;
      return;
    }
  }
  if (mv === null || mv.t < 0) {
    const at: CrewSpot = mv === null ? { station: member.station, side: member.side } : mv.from;
    if (underLifelines(input, at)) {
      // On a cruising yacht's rail, against her lifelines: with her as she heels.
      upright = 0;
    }
    spotStance(input, at, 0, t, a);
    if (!spotStance(input, at, 1, t, b)) {
      b = null;
    }
  } else {
    const { rise, along: s, sit } = moveAt(mv, where);
    upright = 0;
    how.via = BY_THE_BOW;
    how.carry = true;
    const pose = lean >= 0.5 ? 1 : 0;
    if (bridge !== null) {
      poseBridgeMove(body, input, bridge, mv, pose, t, a, b, how, rise, s, sit);
      return;
    }
    if (rise < 1) {
      spotStance(input, mv.from, pose, t, a);
      walkStance(input.clips, body.rig, mv.path, 0, b, walk, ahead);
      how.f = smooth(rise);
      how.narrowB = 1;
      // Not lifted under a boom: kept low; off a cruising yacht's rail,
      // the legs brought in under her lower lifeline.
      how.arc = underLifelines(input, mv.from) ? 0 : RISE_ARC * (1 - input.duck);
      railTransition(input, mv.from, how);
    } else if (sit <= 0) {
      const step = mv.path.stepAt(s);
      how.narrowA = 1;
      if (step === null) {
        walkStance(input.clips, body.rig, mv.path, s, a, walk, ahead);
        b = null;
      } else {
        // A step up or down: from the walk at its foot to the walk at its
        // head, the feet carried over its edge.
        walkStance(input.clips, body.rig, mv.path, step[0], a, walk, ahead);
        walkStance(input.clips, body.rig, mv.path, step[1], b, walk, ahead);
        how.f = smooth((s - step[0]) / (step[1] - step[0]));
        how.narrowB = 1;
        how.carry = true;
        how.top = mv.path.overAt(s);
        if (how.top > Number.NEGATIVE_INFINITY) {
          // Over something: the body lifted with the feet, the knees over it.
          how.arc = OVER_ARC;
        }
      }
    } else {
      walkStance(input.clips, body.rig, mv.path, mv.path.length, a, walk, ahead);
      spotStance(input, mv.to, pose, t, b);
      how.f = smooth(sit);
      how.narrowA = 1;
      how.arc = underLifelines(input, mv.to) ? 0 : RISE_ARC * (1 - input.duck);
      railTransition(input, mv.to, how);
      if (how.legs !== undefined && how.legs < 1) {
        // Sitting down on it, the legs go out last.
        how.legs = 1;
      }
    }
  }
  if (a.clip === null && b !== null) {
    [a, b] = [b, null];
  }
  const life = input.life;
  const was = life.upright;
  life.upright = upright;
  body.pose(a, b, how, input.duck, life);
  life.upright = was;
}

/**
 * Aboard a cruising catamaran, someone walking her ways at a handover:
 * getting up from their seat (or from her wheel) into the walk, along her
 * floors upright, up or down her ladder on its clip (blended with the walk
 * at its foot and its head), and sitting down at the end (or standing at
 * her wheel).
 */
function poseBridgeMove(
  body: CrewBody,
  input: PoseInput,
  bridge: BridgeBoat,
  mv: NonNullable<CrewMember['moving']>,
  pose: 0 | 1,
  t: number,
  a: Stance,
  b0: Stance,
  how: typeof theBlend,
  rise: number,
  s: number,
  sit: number,
): void {
  let b: Stance | null = b0;
  const ladder = mv.ladder ?? null;
  const rig = body.rig;
  if (rise < 1) {
    spotStance(input, mv.from, pose, t, a);
    bridgeWalk(input.clips, rig, mv.path, ladder, 0, b);
    how.f = smooth(rise);
    how.narrowB = 0;
    how.arc = mv.from.station < 0 ? 0 : RISE_ARC * 0.5;
  } else if (sit <= 0) {
    if (ladder !== null && s > ladder.s0 && s < ladder.s1) {
      const f = (s - ladder.s0) / (ladder.s1 - ladder.s0);
      ladderStance(input, bridge, ladder, s, a);
      if (f < LADDER_BLEND) {
        bridgeWalk(input.clips, rig, mv.path, ladder, ladder.s0, b);
        how.f = 1 - smooth(f / LADDER_BLEND);
      } else if (f > 1 - LADDER_BLEND) {
        bridgeWalk(input.clips, rig, mv.path, ladder, ladder.s1, b);
        how.f = smooth((f - 1 + LADDER_BLEND) / LADDER_BLEND);
      } else {
        b = null;
      }
    } else {
      bridgeWalk(input.clips, rig, mv.path, ladder, s, a);
      b = null;
    }
  } else {
    bridgeWalk(input.clips, rig, mv.path, ladder, mv.path.length, a);
    spotStance(input, mv.to, pose, t, b);
    how.f = smooth(sit);
    how.arc = mv.to.station < 0 ? 0 : RISE_ARC * 0.5;
  }
  if (a.clip === null && b !== null) {
    [a, b] = [b, null];
  }
  const life = input.life;
  const was = life.upright;
  life.upright = 0;
  body.pose(a, b, how, 0, life);
  life.upright = was;
}

/** Of a rise off a cruising yacht's rail, how much the legs take to come in: first, under her lower lifeline. */
const LEGS_IN = 0.5;
/** How far over her upper lifeline the hands are carried, m. */
const HANDS_OVER = 0.1;

/** Off or onto a cruising yacht's rail: the legs in first under her lower lifeline, the hands carried over her upper. */
function railTransition(input: PoseInput, at: CrewSpot, how: typeof theBlend): void {
  const st = input.stations[Math.max(0, at.station)];
  const l = input.cruiser?.lifelines ?? null;
  if (!underLifelines(input, at) || st === undefined || l === null) {
    return;
  }
  how.legs = LEGS_IN;
  how.hands = (st.at[1] as number) + Math.max(...l.heights) + HANDS_OVER;
}

/** Whether a place is on a cruising yacht's rail, the legs over her side under her lifelines. */
function underLifelines(input: PoseInput, at: CrewSpot): boolean {
  return input.cruiser != null && input.stations[Math.max(0, at.station)]?.pose === 'rail';
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** A crossing's loop on a beach cat's net (the crouch's or the crawl's), at its time, where the crossing is across it, into into. */
function netStance(
  input: PoseInput,
  cat: CatBoat,
  name: string,
  time: number,
  x: number,
  into: Stance,
): boolean {
  const c = input.clips.get(name) ?? null;
  const at = catPoint(cat.aboard, 'net', v);
  if (c === null || c.place === null || at === null) {
    return false;
  }
  into.clip = c;
  into.t = time;
  at.x += x;
  at.z = netWay(cat.aboard, true).z;
  placeStance(into, catPlace(c.place, at, 1, m));
  return true;
}

/** The loop dominant now, and its time. */
function netLoop(net: NetCross): [string, number] {
  return net.crawl >= 0.5 ? [net.crawlClip, net.crawlT] : [net.crouch, net.crouchT];
}

/**
 * Across a beach cat's net, facing forward: off the hull into the crossing,
 * at a crouch and on hands and knees under the boom (blended as far as the
 * boom asks), and down onto the hull on the other side.
 */
function poseAcross(body: CrewBody, member: CrewMember, input: PoseInput, cat: CatBoat): void {
  const mv = member.moving as NonNullable<CrewMember['moving']>;
  const net = mv.net as NetCross;
  const { rise, sit } = moveAt(mv, where);
  const t = input.time;
  const how = theBlend;
  how.via = null;
  how.arc = 0;
  how.narrowA = 0;
  how.narrowB = 0;
  how.carry = false;
  how.top = Number.NEGATIVE_INFINITY;
  how.legs = 1;
  how.hands = Number.NEGATIVE_INFINITY;
  const a = input.a;
  let b: Stance | null = input.b;
  const pose = smooth(member.lean) >= 0.5 ? 1 : 0;
  const [loop, time] = netLoop(net);
  if (rise < 1) {
    spotStance(input, mv.from, pose, t, a);
    if (!netStance(input, cat, loop, time, net.x, b)) {
      b = null;
    }
    how.f = smooth(rise);
    how.arc = ACROSS_ARC;
    how.carry = true;
    how.top = cat.aboard.net.y + ACROSS_STEP;
  } else if (sit <= 0) {
    netStance(input, cat, net.crouch, net.crouchT, net.x, a);
    if (!netStance(input, cat, net.crawlClip, net.crawlT, net.x, b)) {
      b = null;
    }
    // Down onto hands and knees, or up off them: lifted over, the feet
    // carried, never through the net.
    how.f = smooth(net.crawl);
    how.arc = ACROSS_ARC;
    how.carry = true;
    how.top = cat.aboard.net.y + ACROSS_STEP;
  } else {
    netStance(input, cat, loop, time, net.x, a);
    spotStance(input, mv.to, pose, t, b);
    how.f = smooth(sit);
    how.arc = ACROSS_ARC;
    how.carry = true;
    how.top = cat.aboard.net.y + ACROSS_STEP;
  }
  const life = input.life;
  const was = life.upright;
  life.upright = 0;
  // Ducked under the boom at a crouch; on hands and knees, low enough.
  body.pose(a, b, how, input.duck * Math.max(0, 1 - 2 * net.crawl), life);
  life.upright = was;
}

/** How high the body is lifted at the middle of coming off a beach cat's hull onto her net, or back, m. */
const ACROSS_ARC = 0.08;
/** How high over a beach cat's net the feet are carried coming off her hull or onto it, m. */
const ACROSS_STEP = 0.12;
/** In the water, how far clear of the hull (as the sailor's own, runtime.ts); climbing back aboard, how high over the line between the body is carried, m. */
const WATER_CLEAR = 0.32;
const CLIMB_ARC = 0.4;

const e = new Euler();
const q = new Quaternion();
const q2 = new Quaternion();
const Y = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);

/**
 * A place given as the boat lies (the world's axes about her pivot, the
 * sea's surface at the heave below her), facing a turn about the vertical,
 * as a matrix in her model's frame, into out.
 */
export function levelPlace(
  lv: Level,
  x: number,
  y: number,
  z: number,
  facing: number,
  out: Matrix4,
): Matrix4 {
  q.setFromEuler(e.set(lv.pitch, 0, -lv.heel)).invert();
  w.set(x, y - lv.cog, z).applyQuaternion(q);
  w.y += lv.cog;
  q2.setFromAxisAngle(Y, facing);
  q.multiply(q2);
  return out.compose(w, q, ONE);
}

/**
 * Treading water, as the boat lies: off her high side by her hull at their
 * own station's z, facing her; thrown off a beach cat's bows, first ahead
 * of her front beam (on the other side of her centreline from her helm),
 * facing her, then swimming round to her side.
 */
function waterStance(
  input: PoseInput,
  member: CrewMember,
  wet: CrewWet,
  lv: Level,
  into: Stance,
): boolean {
  const c = input.clips.get(CLIPS.water) ?? null;
  if (c === null) {
    return false;
  }
  into.clip = c;
  into.t = input.time;
  const high = lv.heel > 0 ? -1 : 1;
  const st = input.stations[Math.max(0, member.station)];
  const z = (st?.at[2] as number | undefined) ?? 0;
  const out =
    (lv.solid === null ? 1 : reach(lv.solid, high, -lv.heel, lv.cog, z - 0.4, z + 0.4)) +
    WATER_CLEAR;
  levelPlace(lv, high * out, -lv.heave, z, -high * (Math.PI / 2), m);
  const cat = input.cat ?? null;
  if (wet.thrown && cat !== null) {
    const f = smooth((wet.t - THROWN_FOR) / SWIM_ROUND);
    levelPlace(lv, -member.side * THROWN_OUT, -lv.heave, cat.aboard.net.fore - THROWN_AHEAD, 0, m2);
    m.decompose(v, q, w);
    m2.decompose(w, q2, ahead);
    w.lerp(v, f);
    q2.slerp(q, f);
    m.compose(w, q2, ONE);
  }
  placeStance(into, m);
  return true;
}

const ahead = new Vector3();
/** Thrown off a beach cat's bows: how long through the air, s, and how high over the line between, m. */
const THROWN_FLY = 0.7;
const THROWN_ARC = 0.6;

/**
 * After a capsize: in the water; up on a beach cat's lower hull righting
 * her beside the sailor; or climbing back aboard to their station, carried
 * up over the side.
 */
function poseWet(
  body: CrewBody,
  member: CrewMember,
  wet: CrewWet,
  input: PoseInput,
  lv: Level,
): void {
  const how = theBlend;
  how.f = 0;
  how.via = null;
  how.arc = 0;
  how.narrowA = 0;
  how.narrowB = 0;
  how.carry = false;
  how.top = Number.NEGATIVE_INFINITY;
  how.legs = 1;
  how.hands = Number.NEGATIVE_INFINITY;
  const a = input.a;
  let b: Stance | null = null;
  const cat = input.cat ?? null;
  const stand = cat?.crewStand ?? null;
  const righting = input.clips.get(CAT_CLIPS.righting) ?? null;
  if (wet.phase === 'board' && stand !== null && righting?.place != null) {
    a.clip = righting;
    a.t = input.time;
    placeStance(a, standPlace(righting.place, stand, lv.heel >= 0 ? 1 : -1, m));
  } else if (wet.thrown && wet.phase === 'water' && wet.t < THROWN_FLY) {
    // Thrown off the hull or the wire, over the bows, through the air.
    spotStance(
      input,
      { station: member.station, side: member.side },
      wet.lean >= 0.5 ? 1 : 0,
      input.time,
      a,
    );
    b = input.b;
    waterStance(input, member, wet, lv, b);
    how.f = smooth(wet.t / THROWN_FLY);
    how.arc = THROWN_ARC;
  } else {
    waterStance(input, member, wet, lv, a);
    if (wet.phase === 'climb') {
      b = input.b;
      spotStance(input, { station: member.station, side: member.side }, 0, input.time, b);
      how.f = smooth(wet.t / CLIMB);
      how.arc = CLIMB_ARC;
    }
  }
  // In the water or on her hull as she lies, over nothing of hers.
  const life = input.life;
  const was = life.upright;
  const floor = life.floor ?? null;
  life.upright = 0;
  life.floor = wet.phase === 'climb' ? floor : null;
  body.pose(a, b, how, 0, life);
  life.upright = was;
  life.floor = floor;
}
