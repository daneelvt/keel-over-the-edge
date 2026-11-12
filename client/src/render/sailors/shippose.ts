// SPDX-License-Identifier: AGPL-3.0-only

// What a ship's company's bodies are posed in, for what her rules have each
// doing (shiprules.ts): at a station, one of its pose's idles (her deck's
// clips, ship.ts) or two blended as one goes over into the next; sat on a
// hatch or stood up from it, blended; stepping off into the walk, walking
// along her ways at the walk's own pace, and stepping into the stance at
// the walk's end; gone on a ladder or the climb aloft. Standing and in the
// top they are kept near plumb against her heel and pitch (SEA_LEGS); sat
// and leaning on her rail they go with her.

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BoatStation } from '../../catalog';
import type { Clip } from './clips';
import { blend, type CrewBody, type Life, placeStance, type Stance } from './crewbody';
import { feetTogether } from './crewpose';
import { NOT_FOR_MACHINES, WALK_SPEED } from './ship';
import {
  IDLES,
  idleAt,
  RELIEF,
  SEA_LEGS,
  type ShipMember,
  type ShipRules,
  type ShipSpot,
  type ShipWork,
  standPoint,
  TALKING,
  WHEEL,
  WORK,
} from './shiprules';
import { turnOf, yardFrame } from './shipwork';

/** What posing a ship's member needs: the look's clips, whether a machine's, the moment, the vertical. */
export interface ShipPoseInput {
  rules: ShipRules;
  clips: Map<string, Clip>;
  machine: boolean;
  /** The person's own clips' time, seconds (their phase); the world's, for their idle. */
  time: number;
  world: number;
  life: Life;
  /** Up, in the ship model's frame, already kept within SEA_LEGS of her own: what standing figures are kept plumb to. */
  up: Vector3;
  a: Stance;
  b: Stance;
}

const Y = new Vector3(0, 1, 0);
const m = new Matrix4();
const m2 = new Matrix4();
const v = new Vector3();
const q = new Quaternion();
const q2 = new Quaternion();
const theBlend = blend();
const idle = { now: 0, was: 0, f: 1 };
const where = new Vector3();
const spotNow: ShipSpot = { at: new Vector3(), facing: 0, side: 1 };

/** The vertical in a ship's model's frame, from her model's matrix: kept within SEA_LEGS of her own up, into out. */
export function plumbOf(model: Matrix4, out: Vector3): Vector3 {
  // Her matrix's turn, undone, on the world's up.
  m.extractRotation(model).transpose();
  out.copy(Y).applyMatrix4(m).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, out.y)));
  if (angle > SEA_LEGS) {
    q2.setFromUnitVectors(Y, out);
    q.identity().slerp(q2, SEA_LEGS / angle);
    out.copy(Y).applyQuaternion(q);
  }
  return out;
}

/** The clips a station's pose plays, as this person can: machines have not some, and talking needs someone near. */
function canPlay(input: ShipPoseInput, clip: string, company: boolean): boolean {
  if (!input.clips.has(clip)) {
    return false;
  }
  if (input.machine && NOT_FOR_MACHINES.includes(clip)) {
    return false;
  }
  return company || !TALKING.includes(clip);
}

/** How a station is held: its pose, or standing at its stand point when the pose's clip is not to be had (or it is stood up from). */
function heldAs(
  input: ShipPoseInput,
  st: BoatStation,
  sat: boolean,
): 'standing' | 'leaning' | 'seated' | 'aloft' {
  switch (st.pose) {
    case 'leaning':
      return canPlay(input, 'leaning', true) ? 'leaning' : 'standing';
    case 'seated':
      return sat && canPlay(input, 'hatch-sit', true) ? 'seated' : 'standing';
    case 'aloft':
      return input.clips.has('aloft') ? 'aloft' : 'standing';
    default:
      return 'standing';
  }
}

/** The idle a held pose plays now, by the seat and the world's time: the was and now clips and how far between. */
function idleOf(
  input: ShipPoseInput,
  member: ShipMember,
  held: 'standing' | 'leaning' | 'seated' | 'aloft',
  spot: ShipSpot,
): { now: string; was: string; f: number } {
  const set = IDLES[held] as readonly string[];
  // Talking with someone near; not standing at her rail looking out (the hands would go over it).
  const company = member.ship.company && !(held === 'standing' && facesOut(spot));
  idleAt(member.seat, input.world, set.length, idle);
  const pick = (i: number): string => {
    const c = set[i] as string;
    return canPlay(input, c, company) ? c : (set[0] as string);
  };
  return { now: pick(idle.now), was: pick(idle.was), f: idle.f };
}

/** Whether a station drawn at spot faces out over her side: within 45° of abeam, toward its own side. */
function facesOut(spot: ShipSpot): boolean {
  const f = (spot.facing * Math.PI) / 180;
  return Math.abs(Math.sin(f)) > Math.SQRT1_2 && Math.sign(Math.sin(f)) === Math.sign(spot.at.x);
}

/**
 * A clip's stance at a station drawn at spot, held as held, into into: an
 * idle standing at its stand point facing its way; leaning, sat or aloft by
 * the clip's own place from the station's point.
 */
function heldStance(
  input: ShipPoseInput,
  st: BoatStation,
  spot: ShipSpot,
  held: 'standing' | 'leaning' | 'seated' | 'aloft',
  clipName: string,
  t: number,
  into: Stance,
): boolean {
  const clips = input.clips;
  const f = (spot.facing * Math.PI) / 180;
  if (held === 'aloft') {
    const c = clips.get(spot.side < 0 ? 'aloft-port' : 'aloft') ?? clips.get('aloft') ?? null;
    if (c?.place == null) {
      return false;
    }
    into.clip = c;
    into.t = t;
    m.makeTranslation(spot.at.x, spot.at.y, spot.at.z).multiply(c.place);
    placeStance(into, m);
    return true;
  }
  const c = clips.get(clipName) ?? null;
  if (c === null) {
    return false;
  }
  into.clip = c;
  into.t = t;
  if (held === 'leaning' && c.place !== null) {
    // Staged on her starboard rail facing outboard: turned to face the station's way.
    m.makeTranslation(spot.at.x, spot.at.y, spot.at.z)
      .multiply(m2.makeRotationY(Math.PI / 2 - f))
      .multiply(c.place);
  } else if (held === 'seated' && c.place !== null) {
    // Staged on the hatch's forward edge facing forward.
    m.makeTranslation(spot.at.x, spot.at.y, spot.at.z)
      .multiply(m2.makeRotationY(-f))
      .multiply(c.place);
  } else {
    // Standing: the figure faces +z, turned to the station's way, its feet on the stand point.
    standPoint(st, spot, v);
    m.makeTranslation(v.x, v.y, v.z).multiply(m2.makeRotationY(Math.PI - f));
  }
  placeStance(into, m);
  return true;
}

/** A yaw (atan2 of a way's x and z) as a facing, degrees clockwise from the bow. */
function facingOf(yaw: number): number {
  return ((Math.PI - yaw) * 180) / Math.PI;
}

/**
 * Hauling on a brace at a place, into into: the hauling clip (or its
 * mirror, whichever has the rail on the same hand) turned from the way it
 * was staged facing the main brace's lead to the way this place faces, its
 * hands on the fall here. Null if this person cannot haul (a machine).
 */
function haulStance(input: ShipPoseInput, work: ShipWork, into: Stance): boolean {
  const place = work.haul;
  if (place === null || input.machine) {
    return false;
  }
  // The staged hauler had her rail on the left hand, facing aft.
  const railLeft = place.side * Math.cos(place.yaw) > 0;
  const c = input.clips.get(railLeft ? 'haul' : 'haul-port') ?? null;
  const brace = input.rules.company.brace;
  if (c?.place == null) {
    return false;
  }
  const staged = Math.atan2(brace.lead.x - brace.fall.x, brace.lead.z - brace.fall.z);
  into.clip = c;
  into.t = input.time;
  m.makeTranslation(place.hands.x, place.hands.y, place.hands.z)
    .multiply(m2.makeRotationY(place.yaw - (railLeft ? staged : -staged)))
    .multiply(c.place);
  placeStance(into, m);
  return true;
}

/** Lying over a yard on its footrope, into into: the yard's clip on its side, placed in the yard's frame as the braces turn it and the reef lowers it. */
function yardStance(input: ShipPoseInput, work: ShipWork, into: Stance): boolean {
  const place = work.yard;
  const rules = input.rules;
  const y = place === null ? undefined : rules.company.yards[place.yard];
  if (place === null || y === undefined) {
    return false;
  }
  const c = input.clips.get(place.x < 0 ? 'yard-port' : 'yard') ?? null;
  if (c?.place == null) {
    return false;
  }
  into.clip = c;
  into.t = input.time;
  yardFrame(y, turnOf(y, rules.turns), rules.reef, m);
  m.multiply(m2.makeTranslation(place.x, 0, 0)).multiply(c.place);
  placeStance(into, m);
  return true;
}

/**
 * At work, into a (and b, blended by how): on the yard; at the brace,
 * standing at its fall facing its lead, blended into hauling as they haul.
 * Whether to keep plumb; false if not to be drawn.
 */
function workStance(
  input: ShipPoseInput,
  work: ShipWork,
  how: { f: number },
  a: Stance,
  b: Stance,
): { ok: boolean; two: boolean; plumb: boolean } {
  if (work.kind === 'aloft') {
    return { ok: yardStance(input, work, a), two: false, plumb: false };
  }
  const place = work.haul;
  if (place === null) {
    return { ok: false, two: false, plumb: true };
  }
  // Hauling (first, as the clip they are in), blended into standing as they leave off.
  if (work.pull > 0.01 && haulStance(input, work, a)) {
    const stood = standAt(input, place.feet, facingOf(place.yaw), IDLES.standing[0], input.time, b);
    how.f = smooth(1 - work.pull);
    return { ok: true, two: stood && work.pull < 0.99, plumb: work.pull < 0.5 };
  }
  const stood = standAt(input, place.feet, facingOf(place.yaw), IDLES.standing[0], input.time, a);
  return { ok: stood, two: false, plumb: true };
}

/** Standing at a point (not a station's) facing a way: behind the helmsman, or to leeward of the wheel. */
function standAt(
  input: ShipPoseInput,
  at: Vector3,
  facing: number,
  clip: string,
  t: number,
  into: Stance,
): boolean {
  const c = input.clips.get(clip) ?? input.clips.get(IDLES.standing[0]) ?? null;
  if (c === null) {
    return false;
  }
  into.clip = c;
  into.t = t;
  m.makeTranslation(at.x, at.y, at.z).multiply(
    m2.makeRotationY(Math.PI - (facing * Math.PI) / 180),
  );
  placeStance(into, m);
  return true;
}

/** The walk's stance s along a leg's path, into into, its steps begun with the feet together. */
function walkAt(
  input: ShipPoseInput,
  rig: CrewBody['rig'],
  path: NonNullable<import('./shiprules').ShipLeg['path']>,
  s: number,
  into: Stance,
  aside: { x: number; z: number } | null = null,
): boolean {
  const c = input.clips.get('walk') ?? null;
  if (c === null) {
    return false;
  }
  const p = { x: 0, y: 0, z: 0 };
  const yaw = path.at(s, p);
  into.clip = c;
  into.t = feetTogether(c, rig) + s / WALK_SPEED;
  // Stepped aside, to let someone by.
  into.at.set(p.x + (aside?.x ?? 0), p.y, p.z + (aside?.z ?? 0));
  into.yaw = yaw;
  into.tilt.identity();
  return true;
}

/**
 * The stance at a place a walk begins or ends (a station's, held as its
 * person holds it; behind the helmsman; to leeward of the wheel), into
 * into; the idle its pose plays now.
 */
function placeStanceOf(
  input: ShipPoseInput,
  member: ShipMember,
  place: number,
  spot: ShipSpot,
  into: Stance,
): boolean {
  if (place === WORK && member.ship.work !== null) {
    // Leaving or reaching the braces: standing at the fall.
    const w = member.ship.work;
    return w.haul !== null
      ? standAt(input, w.haul.feet, facingOf(w.haul.yaw), IDLES.standing[0], input.time, into)
      : false;
  }
  if (place === RELIEF || place === WHEEL) {
    const talk = canPlay(input, 'talking', true) ? 'talking' : IDLES.standing[0];
    return standAt(
      input,
      spot.at,
      0,
      place === RELIEF ? talk : IDLES.standing[0],
      input.time,
      into,
    );
  }
  const st = input.rules.stations[place];
  if (st === undefined) {
    return false;
  }
  const held = heldAs(input, st, member.ship.sat >= 0.5);
  const id = idleOf(input, member, held, spot);
  return heldStance(input, st, spot, held, id.now, input.time, into);
}

/** Poses a ship's member for what her rules have them doing; false if they are not to be drawn (gone on a ladder or aloft). */
export function poseShip(body: CrewBody, member: ShipMember, input: ShipPoseInput): boolean {
  const d = member.ship;
  const how = theBlend;
  how.f = 0;
  how.via = null;
  how.arc = 0;
  how.narrowA = 0;
  how.narrowB = 0;
  how.carry = false;
  how.top = Number.NEGATIVE_INFINITY;
  let a: Stance = input.a;
  let b: Stance | null = input.b;
  let plumb = true;
  let upright = 0;
  const route = d.route;
  if (route === null && d.to === WORK && d.work !== null) {
    // At their work.
    const w = workStance(input, d.work, how, a, input.b);
    if (!w.ok) {
      return false;
    }
    if (!w.two) {
      b = null;
    }
    plumb = w.plumb;
  } else if (route === null) {
    // At their place.
    const st = input.rules.stations[member.station];
    if (st === undefined) {
      return false;
    }
    input.rules.spotOf(member.station, spotNow);
    const sat = d.sat;
    if (st.pose === 'seated' && sat > 0 && sat < 1) {
      // Sitting down or standing up.
      heldStance(input, st, spotNow, 'seated', IDLES.seated[0], input.time, a);
      heldStance(input, st, spotNow, 'standing', IDLES.standing[0], input.time, b);
      how.f = smooth(1 - sat);
      plumb = false;
      upright = 0.5;
    } else {
      const held = heldAs(input, st, sat >= 0.5);
      const id = idleOf(input, member, held, spotNow);
      if (!heldStance(input, st, spotNow, held, id.f < 1 ? id.was : id.now, input.time, a)) {
        return false;
      }
      if (
        id.f < 1 &&
        id.was !== id.now &&
        heldStance(input, st, spotNow, held, id.now, input.time, b)
      ) {
        how.f = smooth(id.f);
      } else {
        b = null;
      }
      plumb = held === 'standing' || held === 'aloft';
      upright = held === 'seated' ? 0.5 : 0;
    }
  } else {
    const t = Math.max(route.legs[0]?.t0 ?? 0, d.t);
    const now = route.at(t, where);
    if (now.gone) {
      return false;
    }
    const first = route.legs[0];
    const last = route.legs.at(-1);
    if (first !== undefined && d.t < first.t0 && first.path !== null) {
      // Stepping off from where they were.
      if (placeStanceOf(input, member, d.from, d.fromSpot, a)) {
        walkAt(input, body.rig, first.path, 0, input.b);
        b = input.b;
        how.f = smooth(d.t / Math.max(1e-6, first.t0));
      } else {
        walkAt(input, body.rig, first.path, 0, a);
        b = null;
      }
    } else if (last !== undefined && d.t >= last.t1 && last.path !== null) {
      // Stepping in at the walk's end.
      walkAt(input, body.rig, last.path, last.path.length, a);
      const into = input.b;
      if (d.to === RELIEF && d.t >= route.duration) {
        standAt(
          input,
          d.toSpot.at,
          0,
          canPlay(input, 'talking', true) ? 'talking' : IDLES.standing[0],
          input.time,
          a,
        );
        b = null;
      } else if (placeStanceOf(input, member, d.to, d.toSpot, into)) {
        b = into;
        how.f = smooth((d.t - last.t1) / Math.max(1e-6, route.duration - last.t1));
      } else {
        b = null;
      }
      const st = input.rules.stations[d.to];
      plumb = st === undefined || st.pose === 'standing' || how.f < 0.5;
    } else if (now.leg !== null && now.leg.path !== null) {
      walkAt(input, body.rig, now.leg.path, now.s, a, d.aside);
      b = null;
    } else {
      return false;
    }
  }
  if (a.clip === null && b !== null) {
    [a, b] = [b, null];
  }
  const life = input.life;
  const wasUp = life.upright;
  const wasPlumb = life.plumb;
  life.upright = upright;
  life.plumb = plumb ? input.up : null;
  body.pose(a, b, how, 0, life);
  life.upright = wasUp;
  life.plumb = wasPlumb ?? null;
  return true;
}

function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
