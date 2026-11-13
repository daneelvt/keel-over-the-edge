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

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { BoatStation, StationPose } from '../../catalog';
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
import { type Clip, Pose } from './clips';
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
import { type HullSolid, reach } from './solid';

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
  input: Pick<PoseInput, 'stations' | 'seat' | 'clips' | 'cat' | 'aft'>,
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

/** Each walk's time with both feet down and nearest side by side, its steps begun and ended there. */
const together = new WeakMap<Clip, number>();

/** How near its lowest the higher foot must be for both to be down, m. */
const FEET_DOWN = 0.02;

/** The time in a walk where both its feet are down, nearest side by side fore and aft: found once. */
export function feetTogether(clip: Clip, rig: Rig): number {
  let t0 = together.get(clip);
  if (t0 === undefined) {
    const pose = new Pose(rig.names.length);
    const l = rig.bone('foot_l');
    const r = rig.bone('foot_r');
    // Each moment's feet: how far apart fore and aft, and how high the higher is.
    const apart: number[] = [];
    const high: number[] = [];
    for (let k = 0; k < 120; k++) {
      const t = (clip.duration * k) / 120;
      pose.rest(rig);
      clip.sample(t, pose);
      pose.to(rig);
      rig.fk();
      rig.position(l, v);
      rig.position(r, w);
      apart.push(Math.abs(v.z - w.z));
      high.push(Math.max(v.y, w.y));
    }
    // Both feet down (the higher within FEET_DOWN of its lowest), nearest side by side.
    const low = Math.min(...high);
    let best = Number.POSITIVE_INFINITY;
    t0 = 0;
    for (let k = 0; k < 120; k++) {
      if ((high[k] as number) <= low + FEET_DOWN && (apart[k] as number) < best) {
        best = apart[k] as number;
        t0 = (clip.duration * k) / 120;
      }
    }
    rig.reset();
    together.set(clip, t0);
  }
  return t0;
}

/** The crouch's walk s along a path, into into: begun with the feet side by side; they keep their place on the deck, a step's length the clip's speed. */
export function walkStance(
  clips: Map<string, Clip>,
  rig: Rig,
  path: CrewPath,
  s: number,
  into: Stance,
): boolean {
  const c = clips.get(CROUCH_CLIPS.walk) ?? null;
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
  into.at.set(along.x, along.y, along.z);
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
  if (mv === null || mv.t < 0) {
    const at: CrewSpot = mv === null ? { station: member.station, side: member.side } : mv.from;
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
    if (rise < 1) {
      spotStance(input, mv.from, pose, t, a);
      walkStance(input.clips, body.rig, mv.path, 0, b);
      how.f = smooth(rise);
      how.narrowB = 1;
      // Not lifted under a boom: kept low.
      how.arc = RISE_ARC * (1 - input.duck);
    } else if (sit <= 0) {
      const step = mv.path.stepAt(s);
      how.narrowA = 1;
      if (step === null) {
        walkStance(input.clips, body.rig, mv.path, s, a);
        b = null;
      } else {
        // A step up or down: from the walk at its foot to the walk at its
        // head, the feet carried over its edge.
        walkStance(input.clips, body.rig, mv.path, step[0], a);
        walkStance(input.clips, body.rig, mv.path, step[1], b);
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
      walkStance(input.clips, body.rig, mv.path, mv.path.length, a);
      spotStance(input, mv.to, pose, t, b);
      how.f = smooth(sit);
      how.narrowA = 1;
      how.arc = RISE_ARC * (1 - input.duck);
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
