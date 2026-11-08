// SPDX-License-Identifier: AGPL-3.0-only

// Where each bird of a group of the sea's life is, from its record, its
// own number, world time and the pose of the boat it is with: about the
// group's middle (flock.ts), each by numbers of its own, so no two are on
// one point and every phone draws the same bird in the same place.
//
// - Passing: a loose flock along the group's line, each bird wandering a
//   little in it, a few metres a few seconds.
// - Soaring: slow wide circles, 40 to 140 m across, about the middle, the
//   frigatebird's on the rising air under the cumulus, "rarely beating its
//   wings"; it drifts in with its middle and out again.
// - Skimming: a shearwater's dynamic soaring, arcs across the line from
//   just over the swell up to its height and down again, banked, the
//   climb into the wind and the run down it (Richardson 2011); a
//   pelican's line, one behind another just over the waves, carried on the
//   updraft of the swell's face (Stokes and Lucas).
// - Working: wheeling low over a patch of water, both ways about it, as
//   terns over fish driven up from below.
// - With a boat: wheeling about a place astern of it, now wide, now hanging
//   in the boat's air close astern, as gulls follow a fishing boat for its
//   scraps; coming in from far off and going on beyond, as the middle does.
// - Plunges, each bird its kind's number a minute: it checks and climbs to
//   its height, folds and falls into the water as a booby does, from 10
//   to 25 m, is under a second or two, and comes up and flies on, falling
//   behind its group and catching it up again.
//
// A bird is never in the water but in a plunge: it keeps at least
// max(0.5, 0.6 × the sea's significant height) m up, over the crests.

import type { LifeKind } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import {
  type FlockPlace,
  flockAt,
  flockHeight,
  hash32,
  lerp,
  own,
  type Pose,
  pathOf,
} from './flock';

/** Ticks a second of world time. */
const STEPS = 30;
/** The pull of gravity, m/s². */
const G = 9.81;
/** How far either side in time a bird's heading, pitch and bank are found from, s. */
const DT = 0.25;
/** How deep a plunging bird goes, m below the surface. */
const DEPTH = 0.6;
/** No plunge begins this near either end of a group's life, s: it comes in and goes out flying. */
const PLUNGE_MARGIN = 30;
/** A plunge's parts, s: the check and climb before it, the bird coming up, and the share of its delay it catches up in. */
const CHECK = 2.5;
const RISE = 3;
const CATCH = 2.5;
/** The most a bank is, radians. */
const BANK = 0.9;

/** A boat a group is with: its pose, its speed over the ground along its heading, m/s, and how far its stem is ahead of its middle, m, if known. */
export interface BoatAt extends Pose {
  speed?: number;
  bow?: number;
}

/** Where a bird is and how it flies. */
export interface BirdPlace {
  /** m east, north and up. */
  east: number;
  north: number;
  up: number;
  /** Its heading, radians clockwise from north; its pitch, bill down, and its bank, right wing down, radians. */
  heading: number;
  pitch: number;
  bank: number;
  /** Whether it is in a plunge: from its fall's start until it is back at its height. */
  plunge: boolean;
  /** Whether it is falling, its wings folded. */
  folded: boolean;
  /** Whether it is under the water, and not seen. */
  under: boolean;
}

/** A new place, to be set. */
export function newBirdPlace(): BirdPlace {
  return {
    east: 0,
    north: 0,
    up: 0,
    heading: 0,
    pitch: 0,
    bank: 0,
    plunge: false,
    folded: false,
    under: false,
  };
}

/** The least height a bird keeps over the water outside a plunge, m, in a sea of significant height h, m. */
export function floorOver(h: number): number {
  return Math.max(0.5, 0.6 * Math.max(h, 0));
}

/** A bird's own number: the group's seed and its place in the group, mixed. */
export function birdSeed(seed: number, k: number): number {
  return hash32((seed ^ hash32(1000 + k)) >>> 0);
}

/** The phase of a bird's wingbeat and glides, 0 to 1. */
export function birdPhase(seed: number, k: number): number {
  return own(birdSeed(seed, k), 30);
}

/** How far a group's birds spread about its middle, m. */
export function spreadOf(count: number): number {
  return 8 + 6 * Math.sqrt(Math.max(count, 1));
}

/** How a bird's plunge stands at a time: its delay behind its path, s, and its height's part. */
interface Plunge {
  /** s behind where its path would have it. */
  lag: number;
  /** 0 none, 1 checking and climbing, 2 falling, 3 under, 4 coming up. */
  part: number;
  /** s into that part, and the part's length. */
  into: number;
  length: number;
  /** The height it falls from, m. */
  from: number;
}

/** The height a bird of the group plunges from, m: up from a low path, down from a high one. */
function plungeFrom(k: LifeKind, e: LifeSeen, s: number): number {
  return Math.min(Math.max(flockHeight(k, e.seed), 10), 22) + 3 * own(s, 42);
}

/**
 * Sets out to how bird s's plunges stand u s into a life of life s: one
 * in each cycle of 60 / dives s, at a time of its own in it, none near
 * either end of the life.
 */
function plungeAt(k: LifeKind, e: LifeSeen, s: number, u: number, life: number, out: Plunge): void {
  out.lag = 0;
  out.part = 0;
  out.into = 0;
  out.length = 0;
  const dives = k.dives ?? 0;
  if (!(dives > 0)) {
    return;
  }
  // It falls as a stone falls, a little slowed; is under a second or two;
  // and is delayed most by six tenths of its time down and back up.
  const from = plungeFrom(k, e, s);
  const check = CHECK;
  const fall = 1.1 * Math.sqrt((2 * (from + DEPTH)) / G);
  const under = 1 + own(s, 41);
  const rise = RISE;
  const inLength = check + fall + under + rise;
  const most = 0.6 * inLength;
  const whole = inLength + CATCH * most;
  const cycle = Math.max(60 / dives, whole + 1);
  const shift = own(s, 40) * cycle;
  const n = Math.floor((u + shift) / cycle);
  const begin = n * cycle - shift + own(hash32((s ^ hash32(n + 7)) >>> 0), 1) * (cycle - whole);
  const t = u - begin;
  if (t < 0 || t >= whole || begin < PLUNGE_MARGIN || begin + whole > life - PLUNGE_MARGIN) {
    return;
  }
  out.from = from;
  // Its delay grows smoothly as it checks, falls and is under, the bird
  // all but still in the water; and shrinks as smoothly as it catches up.
  out.lag =
    t < inLength
      ? most * smooth(t / inLength)
      : most * (1 - smooth((t - inLength) / (whole - inLength)));
  if (t < check) {
    out.part = 1;
    out.into = t;
    out.length = check;
  } else if (t < check + fall) {
    out.part = 2;
    out.into = t - check;
    out.length = fall;
  } else if (t < check + fall + under) {
    out.part = 3;
    out.into = t - check - fall;
    out.length = under;
  } else if (t < inLength) {
    out.part = 4;
    out.into = t - check - fall - under;
    out.length = rise;
  }
}

/** Hermite's smooth step of x in [0, 1]. */
function smooth(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
}

/** A sine of a period of its own, s, at u s. */
function wave(u: number, period: number, phase: number): number {
  return Math.sin((2 * Math.PI * u) / period + phase * 2 * Math.PI);
}

/** Whether a group of a record is with a boat. */
export function withBoat(e: LifeSeen): boolean {
  return e.with !== 0;
}

/** The group's own way round, 1 or −1: a group soaring circles together. */
function groupTurn(e: LifeSeen): number {
  return own(e.seed, 20) < 0.5 ? 1 : -1;
}

/** Scratch, for one bird's places along its path. */
const mid: FlockPlace = { east: 0, north: 0, up: 0 };
const plunge: Plunge = { lag: 0, part: 0, into: 0, length: 0, from: 0 };

/** A bird's place alone: m east, north and up, and its plunge's state. */
interface Spot {
  east: number;
  north: number;
  up: number;
  plunge: boolean;
  folded: boolean;
}

/**
 * Sets out to where bird i of a group is at tick t, about a boat at pose
 * for a group with one, over a sea of significant height sea, m; false
 * where the group is not alive then or its boat is not known.
 */
function spotAt(
  e: LifeSeen,
  k: LifeKind,
  i: number,
  t: number,
  pose: Pose | null,
  sea: number,
  out: Spot,
): boolean {
  if (t < e.start || t >= e.end) {
    return false;
  }
  const s = birdSeed(e.seed, i);
  const life = (e.end - e.start) / STEPS;
  plungeAt(k, e, s, (t - e.start) / STEPS, life, plunge);
  const tb = Math.max(t - plunge.lag * STEPS, e.start);
  if (!flockAt(e, k, tb, pose, mid)) {
    return false;
  }
  const u = (tb - e.start) / STEPS;
  const floor = floorOver(sea);
  const n = Math.max(e.count, 1);
  const spread = spreadOf(n);
  let east = mid.east;
  let north = mid.north;
  let up = mid.up;
  // Along and across the line it is set on, m: ahead and to its right.
  let along = 0;
  let across = 0;
  let line = e.heading;
  if (withBoat(e) && pose !== null) {
    // Wheeling about the place astern, in the boat's frame: wide, then
    // closing in to hang in the boat's air.
    line = pose.heading;
    const hang = smooth((wave(u, lerp(20, 40, own(s, 12)), own(s, 13)) - 0.1) / 0.6);
    const shrink = 1 - 0.75 * hang;
    const ra = lerp(10, 30, own(s, 1)) * shrink;
    const rc = lerp(6, 20, own(s, 2)) * shrink;
    const dir = own(s, 3) < 0.5 ? 1 : -1;
    const speed = lerp(5, 8, own(s, 9));
    const a = own(s, 4) * 2 * Math.PI + (dir * speed * u) / lerp(10, 30, own(s, 1));
    along = -own(s, 5) * 15 + ra * Math.cos(a);
    across = (own(s, 6) - 0.5) * 10 + rc * Math.sin(a);
    up =
      lerp(Math.min(4, mid.up), mid.up, own(s, 7)) +
      2 * wave(u, lerp(6, 11, own(s, 8)), own(s, 10));
  } else {
    switch (pathOf(k, e)) {
      case 'soar': {
        const r = lerp(40, 140, own(s, 1));
        const speed = lerp(7, 10, own(s, 2));
        const a = own(s, 4) * 2 * Math.PI + (groupTurn(e) * speed * u) / r;
        east += (own(s, 5) - 0.5) * 40 + r * Math.sin(a);
        north += (own(s, 6) - 0.5) * 40 + r * Math.cos(a);
        up += (own(s, 7) - 0.5) * 30 + 8 * Math.sin(a * 0.5 + own(s, 8) * 6);
        break;
      }
      case 'work': {
        const r0 = lerp(12, 50, own(s, 1));
        const r = r0 * (0.75 + 0.25 * wave(u, lerp(15, 30, own(s, 11)), own(s, 12)));
        const speed = lerp(7, 10, own(s, 2));
        const dir = own(s, 3) < 0.5 ? 1 : -1;
        const a = own(s, 4) * 2 * Math.PI + (dir * speed * u) / r0;
        east += (own(s, 5) - 0.5) * spread * 1.2 + r * Math.sin(a);
        north += (own(s, 6) - 0.5) * spread * 1.2 + r * Math.cos(a);
        up = lerp(3, Math.max(mid.up, 3), own(s, 7)) + 2 * Math.sin(a * 1.7 + own(s, 8) * 6);
        break;
      }
      case 'skim': {
        if (k.line === true) {
          // One behind another, each rising and falling a little after
          // the one ahead of it, as the swell's face passes along them.
          const span = k.look?.span ?? 1;
          along = ((n - 1) / 2 - i) * (2.5 * span + 2) + 1.5 * wave(u, 13, own(s, 1));
          across = (own(s, 2) - 0.5) * span * 1.5;
          up = Math.max(mid.up, floor + 0.3) + 0.4 * wave(u - i * 0.8, 7, own(e.seed, 21));
        } else {
          along =
            (own(s, 1) - 0.5) * 2 * spread * 0.8 + 3 * wave(u, lerp(9, 15, own(s, 11)), own(s, 12));
          across = (own(s, 2) - 0.5) * 2 * spread;
          const arc = (2 * Math.PI * u) / lerp(5, 8, own(s, 9)) + own(s, 10) * 2 * Math.PI;
          across += lerp(8, 18, own(s, 3)) * Math.sin(arc);
          const lo = floor;
          const hi = Math.max(mid.up * 1.3, lo + 2);
          up = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(arc));
        }
        break;
      }
      default: {
        // Passing: loose, each a little ahead or behind, out to either
        // side, wandering in the flock; or in a line.
        if (k.line === true) {
          const span = k.look?.span ?? 1;
          along = ((n - 1) / 2 - i) * (2.5 * span + 2);
          across = (own(s, 2) - 0.5) * span * 1.5;
        } else {
          along = (own(s, 1) - 0.5) * 2 * spread * 0.8;
          across = (own(s, 2) - 0.5) * 2 * spread;
        }
        along += 3 * wave(u, lerp(9, 17, own(s, 11)), own(s, 12));
        across += 4 * wave(u, lerp(11, 19, own(s, 13)), own(s, 14));
        up = mid.up * (0.8 + 0.4 * own(s, 7)) + 1.5 * wave(u, lerp(7, 13, own(s, 8)), own(s, 15));
        break;
      }
    }
  }
  const sin = Math.sin(line);
  const cos = Math.cos(line);
  east += sin * along + cos * across;
  north += cos * along - sin * across;
  up = Math.max(up, floor);
  out.east = east;
  out.north = north;
  out.plunge = false;
  out.folded = false;
  switch (plunge.part) {
    case 1:
      // It checks, and climbs or comes down to the height it falls from.
      up = lerp(up, plunge.from, smooth(plunge.into / plunge.length));
      break;
    case 2: {
      // Falling as a stone falls, from still.
      const x = plunge.into / plunge.length;
      up = plunge.from - (plunge.from + DEPTH) * x * x;
      out.plunge = true;
      out.folded = true;
      break;
    }
    case 3:
      up = -DEPTH;
      out.plunge = true;
      break;
    case 4:
      up = lerp(-DEPTH, up, smooth(plunge.into / plunge.length));
      out.plunge = true;
      break;
  }
  out.up = up;
  return true;
}

const s0: Spot = { east: 0, north: 0, up: 0, plunge: false, folded: false };
const s1: Spot = { east: 0, north: 0, up: 0, plunge: false, folded: false };
const s2: Spot = { east: 0, north: 0, up: 0, plunge: false, folded: false };
const ahead: Pose = { east: 0, north: 0, heading: 0 };

/** The pose a boat at speed will have dt s on. */
function poseOn(pose: BoatAt | null, dt: number): Pose | null {
  if (pose === null) {
    return null;
  }
  const v = pose.speed ?? 0;
  ahead.east = pose.east + Math.sin(pose.heading) * v * dt;
  ahead.north = pose.north + Math.cos(pose.heading) * v * dt;
  ahead.heading = pose.heading;
  return ahead;
}

/**
 * Sets out to where bird i of a group is at tick t and how it flies, with
 * the boat it is with at pose, over a sea of significant height sea, m:
 * false where the group is not alive or its boat is not known. Its
 * heading, pitch and bank are its path's a quarter second either side.
 */
export function birdAt(
  e: LifeSeen,
  k: LifeKind,
  i: number,
  t: number,
  pose: BoatAt | null,
  sea: number,
  out: BirdPlace,
): boolean {
  if (!spotAt(e, k, i, t, pose, sea, s0)) {
    return false;
  }
  out.east = s0.east;
  out.north = s0.north;
  out.up = s0.up;
  out.plunge = s0.plunge;
  out.folded = s0.folded;
  out.under = s0.up < 0;
  const step = DT * STEPS;
  const t1 = Math.max(t - step, e.start);
  const t2 = Math.min(t + step, e.end - 1e-6);
  const d1 = (t1 - t) / STEPS;
  const d2 = (t2 - t) / STEPS;
  const ok1 = d1 < 0 && spotAt(e, k, i, t1, poseOn(pose, d1), sea, s1);
  const ok2 = d2 > 0 && spotAt(e, k, i, t2, poseOn(pose, d2), sea, s2);
  const a = ok1 ? s1 : s0;
  const b = ok2 ? s2 : s0;
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const flat = Math.hypot(de, dn);
  const span = (ok2 ? d2 : 0) - (ok1 ? d1 : 0);
  out.heading = flat > 1e-6 ? Math.atan2(de, dn) : e.heading;
  out.pitch = flat > 1e-9 || b.up !== a.up ? Math.atan2(a.up - b.up, flat) : 0;
  out.bank = 0;
  if (ok1 && ok2 && span > 0) {
    // Banked into its turn as a body turning steadily is: tan φ = v ω / g.
    const h1 = Math.atan2(s0.east - s1.east, s0.north - s1.north);
    const h2 = Math.atan2(s2.east - s0.east, s2.north - s0.north);
    let turn = h2 - h1;
    turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
    const v = flat / span;
    const w = turn / (span / 2);
    out.bank = Math.min(Math.max(Math.atan((v * w) / G), -BANK), BANK);
  }
  return true;
}

/** How many birds of a group are drawn: half of them, rounded up, on a low tier. */
export function drawnCount(e: LifeSeen, low: boolean): number {
  const n = Math.max(e.count, 0);
  return low ? Math.ceil(n / 2) : n;
}
