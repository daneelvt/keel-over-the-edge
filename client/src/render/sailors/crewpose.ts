// SPDX-License-Identifier: AGPL-3.0-only

// What a crew member's body is posed in, for what the rules have them
// doing (crewrules.ts): at a station, its clip sitting up and its clip
// leaning out, blended by how far they lean; getting up from a place into
// the crouch's walk at the start of a path, walking along it, and sitting
// down out of it at its end, each blended. The clips are their look's: the
// helm's seated, the first hiking depth's, standing-idle, and the rail's
// and the crouch's (rail.ts).

import { Matrix4, Vector3 } from 'three';
import type { BoatStation, StationPose } from '../../catalog';
import { type Clip, Pose } from './clips';
import { blend, type CrewBody, type Life, placeStance, type Stance } from './crewbody';
import { type CrewMember, type CrewPath, type CrewSpot, moveAt } from './crewrules';
import type { FleetSeat } from './fleetlooks';
import { CROUCH_CLIPS, CROUCH_SPEED, RAIL_CLIPS, railPlace } from './rail';
import type { Rig } from './rig';
import { CLIPS } from './runtime';

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
}

/**
 * A place's stance (a station's, or the helm's, -1, as station 0's) on a
 * side, sitting up (0) or leaning out (1), at t seconds into its clip, into
 * into; false if its clip is not there.
 */
export function spotStance(
  input: Pick<PoseInput, 'stations' | 'seat' | 'clips'>,
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

/** Each walk's time with the feet side by side, its steps begun and ended there. */
const together = new WeakMap<Clip, number>();

/** The time in a walk where its feet are nearest side by side, fore and aft: found once. */
export function feetTogether(clip: Clip, rig: Rig): number {
  let t0 = together.get(clip);
  if (t0 === undefined) {
    const pose = new Pose(rig.names.length);
    const l = rig.bone('foot_l');
    const r = rig.bone('foot_r');
    let best = Number.POSITIVE_INFINITY;
    t0 = 0;
    for (let k = 0; k < 120; k++) {
      const t = (clip.duration * k) / 120;
      pose.rest(rig);
      clip.sample(t, pose);
      pose.to(rig);
      rig.fk();
      const d = Math.abs(rig.position(l, v).z - rig.position(r, w).z);
      if (d < best) {
        best = d;
        t0 = t;
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
  into.t = (c === null ? 0 : feetTogether(c, rig)) + s / CROUCH_SPEED;
  into.at.set(along.x, along.y, along.z);
  into.yaw = yaw;
  into.tilt.identity();
  return c !== null;
}

/** Poses a member's body for what the rules have them doing. */
export function poseMember(body: CrewBody, member: CrewMember, input: PoseInput): void {
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
