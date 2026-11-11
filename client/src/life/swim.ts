// SPDX-License-Identifier: AGPL-3.0-only

// Where each animal of a group in the water is, from its record, its own
// number, world time and the pose of the boat it is with: about the
// group's middle (flock.ts), each by numbers of its own, so every phone
// draws the same animal in the same place. Its height is from the water's
// surface where it is, which the page adds.
//
// - A pod (dolphins, a school of tarpon): each swims a little apart from
//   the others, down at its kind's depth between breaths, and comes up to
//   breathe in rolls that break the surface with its back, its kind's
//   breaths at a time. Faster than about 3.5 m/s a dolphin leaps rather
//   than swims, porpoising: each leap a ballistic arc under gravity, out
//   and back in (Au and Weihs 1980). Now and then one leaps clear, its
//   kind's leaps a minute; a spinner spins about its length in the air,
//   2–5 times a leap (NOAA Fisheries). A pod that stays mills about its
//   patch; one with a boat rides its bow: up to eight at once, 2.4 on
//   average (Fiori and others 2024), a metre or two ahead of the stem and
//   to either side, in the pressure of the bow wave, the rest alongside.
// - A turtle wanders slowly about its patch, down for a minute or two,
//   then rises, takes its 3–6 breaths at the surface, head up, and dives
//   again (ICM-CSIC).
// - A flying fish breaks the surface where its flush begins, taxis with
//   its tail in the water for half a second as its wings open, and glides
//   20–50 m a metre or so up, at 10–15 m/s; now and then it touches its
//   tail down and glides on, up to 150 m in all, and is gone (Britannica).
//
// Each one's heading and pitch are its path's either side in time, as a
// bird's are (birds.ts).

import type { LifeKind, SwimLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import type { BoatAt } from './birds';
import { type FlockPlace, flockAt, hash32, lerp, lingersOn, own, pathOf, rides } from './flock';
import {
  newBout,
  round,
  surfaceOf,
  WHALE_BREACH_TIME,
  WHALE_DIVE,
  WHALE_FALL,
  WHALE_SLAP_TIME,
  WHALE_UP,
} from './whale';

/** Ticks a second of world time. */
const STEPS = 30;
/** The pull of gravity, m/s². */
export const G = 9.81;
/** How far either side in time an animal's heading and pitch are found from, s. */
const DT = 0.1;
/** Above this, a dolphin leaps rather than swims, m/s (Au and Weihs 1980). */
export const PORPOISE_FROM = 3.5;
/** The most of a group drawn. */
export const MOST_DRAWN = 24;
/** The most riding a bow at once (Fiori and others 2024). */
const MOST_RIDING = 8;
/** How long a pod takes to come in to a bow or leave it, s. */
const RIDE_IN = 12;
/** How long an animal that stays takes to settle to its milling, s. */
const SETTLE = 10;
/** How deep a pod's animal rolls from to breathe, m, and how long a roll and the gap after it are, s. */
const ROLL_FROM = 0.35;
const ROLL_GAP = 0.8;

/** Where an animal in the water is and how it swims. */
export interface SwimPlace {
  /** m east and north, and up from the water's surface there (its middle). */
  east: number;
  north: number;
  up: number;
  /** Its heading, radians clockwise from north; its pitch, nose up, and roll, right side down, radians. */
  heading: number;
  pitch: number;
  roll: number;
  /** How strongly its tail beats, 0 to 1, and the beat's phase, radians. */
  wave: number;
  beat: number;
  /** How far its wings are folded, 0 spread to 1 folded; how far its paddles stroke, 0 to 1. */
  fold: number;
  stroke: number;
  /** Whether it is there to be drawn: a flying fish before it breaks the surface and after it is back in is not. */
  shown: boolean;
  /** Whether it is breathing now, its blowhole clear. */
  breath: boolean;
}

/** A new place, to be set. */
export function newSwimPlace(): SwimPlace {
  return {
    east: 0,
    north: 0,
    up: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    wave: 0,
    beat: 0,
    fold: 0,
    stroke: 0,
    shown: false,
    breath: false,
  };
}

/** An animal's own number: the group's seed and its place in it, mixed. */
export function swimSeed(seed: number, i: number): number {
  return hash32((seed ^ hash32(2000 + i)) >>> 0);
}

/** How many of a group are drawn: no more than the most, and half of them, rounded up, on a low tier. */
export function swimCount(e: LifeSeen, low: boolean): number {
  const n = Math.min(Math.max(e.count, 0), MOST_DRAWN);
  return low ? Math.ceil(n / 2) : n;
}

function smooth(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
}

function wave(u: number, period: number, phase: number): number {
  return Math.sin((2 * Math.PI * u) / period + phase * 2 * Math.PI);
}

/** A pair's value at a share u of the way from its first to its second. */
function between(p: readonly number[] | undefined, u: number, or: number): number {
  return lerp(p?.[0] ?? or, p?.[1] ?? p?.[0] ?? or, u);
}

/** Where an animal is at an instant, before its heading and pitch are found. */
interface Spot {
  east: number;
  north: number;
  up: number;
  roll: number;
  fold: number;
  stroke: number;
  shown: boolean;
  breath: boolean;
  /** Its heading, if its path says it outright (riding, milling); NaN to find it from its way. */
  heading: number;
  /** Its pitch, if its path says it outright (a whale fluking up, a breach); NaN to find it from its way. */
  pitch: number;
}

function newSpot(): Spot {
  return {
    east: 0,
    north: 0,
    up: 0,
    roll: 0,
    fold: 0,
    stroke: 0,
    shown: false,
    breath: false,
    heading: Number.NaN,
    pitch: Number.NaN,
  };
}

const mid: FlockPlace = { east: 0, north: 0, up: 0 };
const midA: FlockPlace = { east: 0, north: 0, up: 0 };
const midB: FlockPlace = { east: 0, north: 0, up: 0 };

/** A leap's part: its height over the surface, its time in the air and its spins, by the animal's own numbers. */
export interface Leap {
  /** s from the leap's start, its time in the air, s, and its rise's speed, m/s. */
  at: number;
  air: number;
  rise: number;
  spins: number;
}

/**
 * A porpoising animal's height at u s along its own cycle at speed v,
 * m/s: out of the water in a ballistic arc under gravity, launched at
 * 30–35° a little faster than it swims, and down under for the rest of
 * the cycle. Its time in the air, s, and the height, m, go to out.
 */
export function porpoiseAt(
  v: number,
  s: number,
  u: number,
  out: { up: number; air: boolean },
): void {
  const launch = v * 1.15;
  const angle = lerp(0.52, 0.62, own(s, 40));
  const rise = launch * Math.sin(angle);
  const air = (2 * rise) / G;
  const cycle = air + lerp(0.9, 1.8, own(s, 41));
  const x = (((u + own(s, 42) * cycle) % cycle) + cycle) % cycle;
  if (x < air) {
    out.up = rise * x - (G * x * x) / 2;
    out.air = true;
  } else {
    out.up = -0.8 * Math.sin((Math.PI * (x - air)) / (cycle - air));
    out.air = false;
  }
}

/**
 * Sets out to the leap clear of the water an animal is in at u s, if any:
 * one in each window of 60 / leaps s, at a time of its own in it.
 */
function leapAt(swim: SwimLook, s: number, u: number, life: number, out: Leap): boolean {
  const leaps = swim.leaps ?? 0;
  if (!(leaps > 0)) {
    return false;
  }
  const w = 60 / leaps;
  const k = Math.floor((u + own(s, 50) * w) / w);
  const ks = hash32((s ^ hash32(5000 + k)) >>> 0);
  const height = lerp(0.8, 2.6, own(ks, 1));
  const rise = Math.sqrt(2 * G * height);
  const air = (2 * rise) / G;
  const start = k * w - own(s, 50) * w + own(ks, 2) * Math.max(w - air - 2, 0) + 1;
  const into = u - start;
  if (into < 0 || into >= air || start < 20 || start + air > life - 20) {
    return false;
  }
  const spins = swim.spins;
  out.at = into;
  out.air = air;
  out.rise = rise;
  out.spins = spins === undefined ? 0 : Math.round(between(spins, own(ks, 3), 0));
  return true;
}

const leap: Leap = { at: 0, air: 0, rise: 0, spins: 0 };
const porpoise = { up: 0, air: false };

/** A pod animal's height and breath as it swims, breathing in rolls, u s into its life. */
function breathing(swim: SwimLook, s: number, u: number, length: number, at: Spot): void {
  const depth = swim.depth * lerp(0.7, 1.2, own(s, 6));
  const roll = 1.1 + 0.2 * length;
  const breaths = Math.round(between(swim.breaths, own(s, 7), 1));
  const down = between(swim.dive, own(s, 8), 20);
  const cycle = down + breaths * (roll + ROLL_GAP);
  const x = (((u + own(s, 9) * cycle) % cycle) + cycle) % cycle;
  at.breath = false;
  if (x < down) {
    const rising = smooth((x - (down - 3)) / 3);
    const falling = 1 - smooth(x / 3);
    const near = Math.max(rising, falling);
    at.up = -lerp(depth, ROLL_FROM, near) + 0.1 * wave(u, 7, own(s, 10));
    return;
  }
  const y = (x - down) % (roll + ROLL_GAP);
  if (y >= roll) {
    at.up = -ROLL_FROM;
    return;
  }
  // A roll: up until its back breaks the surface, its blowhole clear at
  // the top, and down again.
  const q = y / roll;
  const crest = 0.03 * length;
  at.up = -ROLL_FROM + (ROLL_FROM + crest) * Math.sin(Math.PI * q);
  at.breath = q > 0.35 && q < 0.6;
}

/** Sets at to where pod animal i is at tick t. */
function podSpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  boat: BoatAt | null,
  at: Spot,
): boolean {
  if (!flockAt(e, k, t, boat, mid)) {
    return false;
  }
  const s = swimSeed(e.seed, i);
  const u = (t - e.start) / STEPS;
  const life = (e.end - e.start) / STEPS;
  const length = swim.length * lerp(0.9, 1.1, own(s, 1));
  const n = Math.max(e.count, 1);
  const spread = 3 + 2.2 * Math.sqrt(n);
  // The group's way: its middle's either side in time.
  const step = DT * STEPS;
  let gh = e.heading;
  let gv = 0;
  if (
    flockAt(e, k, Math.max(t - step, e.start), boat, midA) &&
    flockAt(e, k, Math.min(t + step, e.end - 1e-6), boat, midB)
  ) {
    const de = midB.east - midA.east;
    const dn = midB.north - midA.north;
    const span = (Math.min(t + step, e.end - 1e-6) - Math.max(t - step, e.start)) / STEPS;
    if (Math.hypot(de, dn) > 1e-4 && span > 0) {
      gh = Math.atan2(de, dn);
      gv = Math.hypot(de, dn) / span;
    }
  }
  // Each a little apart from the others along the group's way and across it, wandering.
  const along =
    (own(s, 2) - 0.5) * spread * 1.4 + 1.5 * wave(u, lerp(18, 30, own(s, 3)), own(s, 4));
  const across = (own(s, 5) - 0.5) * spread + 1.2 * wave(u, lerp(14, 26, own(s, 11)), own(s, 12));
  const sh = Math.sin(gh);
  const ch = Math.cos(gh);
  let east = mid.east + sh * along + ch * across;
  let north = mid.north + ch * along - sh * across;
  at.heading = Number.NaN;
  at.roll = 0;
  at.fold = 1;
  at.stroke = 0.2;
  at.shown = true;
  let speed = gv;
  const path = pathOf(k, e);
  const a = Math.min(k.range / Math.max(e.speed, 0.1), life / 2);
  if (boat !== null && rides(k)) {
    // At the bow, coming in to it and going out from it.
    const w = smooth((u - (a - RIDE_IN)) / RIDE_IN) * (1 - smooth((u - (life - a)) / RIDE_IN));
    const riding = Math.min(n, 2 + (hash32(e.seed) % 5), MOST_RIDING);
    const bs = Math.sin(boat.heading);
    const bc = Math.cos(boat.heading);
    const bow = boat.bow ?? 3;
    let ahead: number;
    let side: number;
    let depth: number;
    if (i < riding) {
      ahead =
        bow +
        0.3 * length +
        lerp(0, 1.5, own(s, 13)) +
        0.4 * wave(u, lerp(5, 9, own(s, 14)), own(s, 15));
      side =
        (i % 2 === 0 ? 1 : -1) *
        (lerp(0.5, 2.2, own(s, 16)) + 0.3 * wave(u, lerp(6, 11, own(s, 17)), own(s, 18)));
      depth = lerp(0.35, 0.8, own(s, 19));
    } else {
      ahead = lerp(-bow * 3 - 8, bow, own(s, 13)) + 2 * wave(u, 20, own(s, 15));
      side = (i % 2 === 0 ? 1 : -1) * lerp(4, 14, own(s, 16));
      depth = swim.depth;
    }
    const re = boat.east + bs * ahead + bc * side;
    const rn = boat.north + bc * ahead - bs * side;
    east = lerp(east, re, w);
    north = lerp(north, rn, w);
    speed = lerp(gv, boat.speed ?? gv, w);
    if (w > 0.5) {
      at.heading = boat.heading;
    }
    if (i < riding && w > 0.99) {
      at.east = east;
      at.north = north;
      // Riding: held in the bow wave, up to breathe now and then.
      const cycle = lerp(8, 20, own(s, 20));
      const x = (((u + own(s, 21) * cycle) % cycle) + cycle) % cycle;
      const roll = 1.6;
      const q = x / roll;
      at.up =
        q < 1
          ? -depth + (depth + 0.03 * length) * Math.sin(Math.PI * q)
          : -depth + 0.1 * wave(u, 3, own(s, 22));
      at.breath = q > 0.35 && q < 0.6;
      at.stroke = 0.1;
      return true;
    }
  } else if (lingersOn(path)) {
    // Milling about its patch once in.
    const w = smooth((u - a) / SETTLE) * (1 - smooth((u - (life - a - SETTLE)) / SETTLE));
    if (w > 0) {
      const r = lerp(3, 3 + spread, own(s, 23));
      const v = lerp(0.5, 1, own(s, 24));
      const dir = own(s, 25) < 0.5 ? 1 : -1;
      const ang = own(s, 26) * 2 * Math.PI + (dir * v * u) / r;
      const me = mid.east + r * Math.sin(ang);
      const mn = mid.north + r * Math.cos(ang);
      east = lerp(east, me, w);
      north = lerp(north, mn, w);
      speed = lerp(gv, v, w);
      if (w > 0.5) {
        at.heading = ang + (dir * Math.PI) / 2;
      }
    }
  }
  at.east = east;
  at.north = north;
  if (leapAt(swim, s, u, life, leap)) {
    // Clear of the water, from a little under it.
    const x = leap.at;
    at.up = -0.3 + leap.rise * x - (G * x * x) / 2 + 0.3 * (x / leap.air);
    at.roll = leap.spins * 2 * Math.PI * smooth(x / leap.air);
    at.breath = false;
    return true;
  }
  if (speed > PORPOISE_FROM && k.binds === 'ride') {
    porpoiseAt(speed, s, u, porpoise);
    at.up = porpoise.up;
    at.breath = porpoise.air;
    return true;
  }
  breathing(swim, s, u, length, at);
  return true;
}

/** Sets at to where turtle i is at tick t: wandering, down, then up for its breaths. */
function turtleSpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  at: Spot,
): boolean {
  if (!flockAt(e, k, t, null, mid)) {
    return false;
  }
  const s = swimSeed(e.seed, i);
  const u = (t - e.start) / STEPS;
  const r = lerp(5, 20, own(s, 1));
  const v = lerp(k.speed[0] ?? 0.3, k.speed[1] ?? 0.5, own(s, 2)) * 0.5;
  const dir = own(s, 3) < 0.5 ? 1 : -1;
  const ang = own(s, 4) * 2 * Math.PI + (dir * v * u) / r;
  at.east = mid.east + r * Math.sin(ang);
  at.north = mid.north + r * Math.cos(ang);
  at.heading = Number.NaN;
  at.roll = 0.05 * wave(u, 6, own(s, 5));
  at.fold = 0;
  at.shown = true;
  const c = turtleCycle(swim, s, u);
  const depth = swim.depth;
  at.breath = false;
  if (c.part === 0) {
    // Down, then rising in the last of it.
    const rise = smooth((c.into - (c.length - RISE_S)) / RISE_S);
    const dive = 1 - smooth(c.into / DIVE_S);
    at.up = -lerp(depth, TURTLE_AWASH, Math.max(rise, dive));
    at.stroke = 1;
  } else {
    // At the surface, its shell awash, lifting its head at each breath.
    at.up = -TURTLE_AWASH + 0.04 * Math.sin((2 * Math.PI * c.into) / BREATH_S);
    at.stroke = 0.3;
    at.breath = c.into % BREATH_S < 1;
  }
  return true;
}

/** How long a turtle takes to rise and to dive, how long a breath is at the surface, s, and how far under its middle lies awash, m. */
const RISE_S = 6;
const DIVE_S = 4;
const BREATH_S = 2.5;
const TURTLE_AWASH = 0.12;

/** Where a turtle is in its cycle of dives and breaths: down (0) or up (1), s into it, its length, and its breaths. */
export interface TurtleCycle {
  part: number;
  into: number;
  length: number;
  breaths: number;
}

const cycle: TurtleCycle = { part: 0, into: 0, length: 0, breaths: 0 };

/**
 * A turtle's cycle u s into its life: dives of its kind's dive and
 * surfacings of its kind's breaths, each drawn afresh, from a start of
 * its own in the first dive.
 */
export function turtleCycle(
  swim: SwimLook,
  s: number,
  u: number,
  out: TurtleCycle = cycle,
): TurtleCycle {
  let x = u + own(s, 6) * between(swim.dive, 0.5, 90);
  for (let k = 0; ; k++) {
    const ks = hash32((s ^ hash32(7000 + k)) >>> 0);
    const down = between(swim.dive, own(ks, 1), 90);
    const breaths = Math.round(between(swim.breaths, own(ks, 2), 4));
    const up = breaths * BREATH_S;
    if (x < down) {
      out.part = 0;
      out.into = x;
      out.length = down;
      out.breaths = breaths;
      return out;
    }
    x -= down;
    if (x < up) {
      out.part = 1;
      out.into = x;
      out.length = up;
      out.breaths = breaths;
      return out;
    }
    x -= up;
  }
}

/** A flying fish's flight: where it breaks the surface, its heading, speed and height, and its glides' lengths. */
export interface Flight {
  /** s after the flush's start it breaks the surface. */
  delay: number;
  east: number;
  north: number;
  heading: number;
  speed: number;
  height: number;
  /** Its glides, m each; how many. */
  glides: number[];
  count: number;
}

/** A flying fish's taxi with its tail in the water before each glide, s. */
export const TAXI = 0.5;
/** Its tail's touch between linked glides, s. */
export const TOUCH = 0.25;

/** A new flight, to be set. */
export function newFlight(): Flight {
  return {
    delay: 0,
    east: 0,
    north: 0,
    heading: 0,
    speed: 0,
    height: 0,
    glides: [0, 0, 0, 0, 0, 0],
    count: 0,
  };
}

/** Sets out to fish i's flight of a flush. */
export function flightOf(e: LifeSeen, k: LifeKind, swim: SwimLook, i: number, out: Flight): Flight {
  const s = swimSeed(e.seed, i);
  out.delay = own(s, 1) * 1.2;
  const along = (own(s, 2) - 0.5) * 6;
  const across = (own(s, 3) - 0.5) * 8;
  const sh = Math.sin(e.heading);
  const ch = Math.cos(e.heading);
  out.east = e.east + sh * along + ch * across;
  out.north = e.north + ch * along - sh * across;
  out.heading = e.heading + (own(s, 4) - 0.5) * 0.8;
  out.speed = between(k.speed, own(s, 5), 12);
  out.height = between(k.height, own(s, 6), 1);
  const lo = swim.glide?.[0] ?? 20;
  const hi = swim.glide?.[1] ?? lo;
  const most = swim.linked ?? hi;
  // Now and then glides linked, one after another, to the most.
  if (own(s, 7) < 0.3 && most > hi) {
    const total = lerp(hi, most, own(s, 8));
    let left = total;
    out.count = 0;
    while (left > 0 && out.count < out.glides.length) {
      const g = Math.min(lerp(lo, hi, own(s, 20 + out.count)), left);
      out.glides[out.count++] = Math.max(g, Math.min(lo, left));
      left -= g;
    }
  } else {
    out.glides[0] = lerp(lo, hi, own(s, 9));
    out.count = 1;
  }
  return out;
}

const flight = newFlight();

/** Sets at to where flying fish i is at tick t. */
function glideSpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  at: Spot,
): boolean {
  if (t < e.start || t >= e.end) {
    return false;
  }
  const f = flightOf(e, k, swim, i, flight);
  let x = (t - e.start) / STEPS - f.delay;
  at.heading = f.heading;
  at.roll = 0;
  at.stroke = 0;
  at.breath = false;
  at.east = f.east;
  at.north = f.north;
  at.up = -0.3;
  at.fold = 1;
  at.shown = false;
  if (x < 0) {
    return true;
  }
  let gone = 0;
  const sh = Math.sin(f.heading);
  const ch = Math.cos(f.heading);
  for (let g = 0; g < f.count; g++) {
    const len = f.glides[g] ?? 0;
    const taxi = g === 0 ? TAXI : TOUCH;
    // Its tail in the water, beating hard, its wings opening.
    if (x < taxi) {
      const d = gone + (g === 0 ? (f.speed * x * x) / (4 * taxi) : f.speed * x);
      at.east = f.east + sh * d;
      at.north = f.north + ch * d;
      at.up = g === 0 ? lerp(-0.15, 0.05, x / taxi) : 0.05;
      at.fold = g === 0 ? 1 - x / taxi : 0;
      at.shown = true;
      return true;
    }
    x -= taxi;
    gone += g === 0 ? (f.speed * taxi) / 4 : f.speed * taxi;
    const tg = len / f.speed;
    if (x < tg) {
      const d = f.speed * x;
      at.east = f.east + sh * (gone + d);
      at.north = f.north + ch * (gone + d);
      at.up = 0.05 + (f.height - 0.05) * Math.min(1, d / 6) * Math.min(1, (len - d) / 8);
      at.fold = 0;
      at.shown = true;
      return true;
    }
    x -= tg;
    gone += len;
  }
  // Back in the water.
  at.east = f.east + sh * gone;
  at.north = f.north + ch * gone;
  at.up = -0.3;
  at.fold = 1;
  at.shown = x < 0.15;
  return true;
}

/** The group's way at tick t: its middle's heading and speed either side in time, to out. */
function groupWay(
  e: LifeSeen,
  k: LifeKind,
  t: number,
  out: { heading: number; speed: number },
): void {
  const step = DT * STEPS;
  out.heading = e.heading;
  out.speed = 0;
  const t1 = Math.max(t - step, e.start);
  const t2 = Math.min(t + step, e.end - 1e-6);
  if (flockAt(e, k, t1, null, midA) && flockAt(e, k, t2, null, midB)) {
    const de = midB.east - midA.east;
    const dn = midB.north - midA.north;
    const span = (t2 - t1) / STEPS;
    if (Math.hypot(de, dn) > 1e-4 && span > 0) {
      out.heading = Math.atan2(de, dn);
      out.speed = Math.hypot(de, dn) / span;
    }
  }
}

const way = { heading: 0, speed: 0 };
const bout = newBout();

/** Places at about its group's middle at its own place in the group, spread m across, along the group's way. */
function inGroup(e: LifeSeen, s: number, u: number, spread: number, at: Spot): void {
  const along =
    (own(s, 2) - 0.5) * spread * 1.4 + 1.5 * wave(u, lerp(25, 40, own(s, 3)), own(s, 4));
  const across = (own(s, 5) - 0.5) * spread + 1.2 * wave(u, lerp(20, 35, own(s, 11)), own(s, 12));
  const sh = Math.sin(way.heading);
  const ch = Math.cos(way.heading);
  at.east = mid.east + sh * along + ch * across;
  at.north = mid.north + ch * along - sh * across;
  at.heading = Number.isNaN(e.heading) ? Number.NaN : way.heading;
}

/**
 * Sets at to where whale i is at tick t, by its round (whale.ts): down
 * between bouts, rising to blow; at the surface its back rolling over
 * after each blow and under till the next, or for one that logs lying
 * awash; a breach, up two thirds out of the water and over onto its side;
 * a slap, its tail up and down onto the water; and its dive, its flukes
 * raised as its head goes down.
 */
function whaleSpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  at: Spot,
): boolean {
  if (!flockAt(e, k, t, null, mid)) {
    return false;
  }
  const s = swimSeed(e.seed, i);
  const u = (t - e.start) / STEPS;
  const life = (e.end - e.start) / STEPS;
  const length = swim.length * lerp(0.92, 1.05, own(s, 1));
  const n = Math.max(e.count, 1);
  groupWay(e, k, t, way);
  inGroup(e, s, u, length * (swim.logs === true ? 0.7 : 1.2) * (0.5 + 0.5 * Math.sqrt(n)), at);
  at.heading = way.heading;
  at.roll = 0;
  at.fold = 0;
  at.stroke = 0.2;
  at.shown = true;
  at.breath = false;
  const top = 0.1 * length;
  const awash = -top + 0.35;
  const deep = -Math.max(swim.depth, 3);
  if (!round(k, e.seed, i, u, life, bout)) {
    at.up = deep;
    return true;
  }
  const dive = bout.start + surfaceOf(bout);
  if (u < bout.start - WHALE_UP) {
    at.up = deep;
  } else if (u < bout.start) {
    // Rising to blow, head a little up.
    const q = smooth((u - (bout.start - WHALE_UP)) / WHALE_UP);
    at.up = lerp(deep, awash, q);
    at.pitch = 0.12 * Math.sin(Math.PI * q);
  } else if (u < dive) {
    const x = u - bout.start;
    const y = x - Math.floor(x / bout.every) * bout.every;
    at.breath = y < 1.5;
    if (swim.logs === true) {
      // Logging: awash, the head lifting a little at each blow.
      at.up = awash - 0.12 + 0.12 * Math.cos((2 * Math.PI * y) / bout.every);
      at.pitch = 0.03 * Math.sin((2 * Math.PI * y) / bout.every);
    } else {
      // Its back rolls over after the blow and under, and up again for the next.
      const under =
        smooth((y - 2) / Math.max(bout.every * 0.35, 1)) * (1 - smooth((y - (bout.every - 4)) / 3));
      at.up = awash - (top + 1.4) * under;
      at.pitch = -0.08 * Math.sin(Math.PI * Math.min(y / Math.max(bout.every - 3, 1), 1));
    }
    if (bout.breach >= 0 && u >= bout.breach && u < bout.breach + WHALE_BREACH_TIME) {
      breach(u - bout.breach, length, awash, at);
    } else if (bout.slap >= 0 && u >= bout.slap && u < bout.slap + WHALE_SLAP_TIME) {
      slap(u - bout.slap, length, awash, at);
    }
  } else if (u < dive + WHALE_DIVE) {
    const z = u - dive;
    if (bout.fluke) {
      // Fluking up: the head goes down and the flukes come up and over.
      at.pitch = -1.35 * smooth(z / 4.5);
      at.up = awash - 0.3 * length * smooth(z / 4) - 1.5 * Math.max(z - 4, 0);
    } else {
      at.pitch = -0.3 * smooth(z / 3) * (1 - smooth((z - 5) / 3));
      at.up = lerp(awash, deep, smooth(z / WHALE_DIVE));
    }
  } else {
    at.up = deep;
  }
  return true;
}

/** A breach z s in: up from under nearly upright, two thirds out of the water, and over onto its side, falling back at WHALE_FALL. */
function breach(z: number, length: number, awash: number, at: Spot): void {
  at.breath = false;
  if (z < 1.5) {
    const q = z / 1.5;
    at.up = lerp(-0.45 * length, -0.2 * length, q);
    at.pitch = 1.25 * smooth(q * 2);
    return;
  }
  if (z < WHALE_FALL) {
    const q = (z - 1.5) / (WHALE_FALL - 1.5);
    at.up = -0.2 * length + 0.32 * length * Math.sin(Math.PI * q);
    at.pitch = 1.25 * (1 - smooth(q));
    at.roll = 1.5 * smooth((q - 0.3) / 0.7);
    return;
  }
  const q = (z - WHALE_FALL) / (WHALE_BREACH_TIME - WHALE_FALL);
  at.up = lerp(-0.2 * length, awash, smooth(q));
  at.pitch = 0;
  at.roll = 1.5 * (1 - smooth(q));
}

/** A slap z s in: its head down and its tail raised, brought down hard onto the water at the middle, and up again. */
function slap(z: number, length: number, awash: number, at: Spot): void {
  const half = WHALE_SLAP_TIME / 2;
  const raise = z < half ? smooth(z / (half - 0.3)) : 1 - smooth((z - half) / 0.3);
  const settle = z < half ? 1 : 1 - smooth((z - half - 0.3) / (half - 0.3));
  at.pitch = -1.0 * raise - 0.35 * (1 - raise) * settle;
  at.up = lerp(awash, -0.28 * length, Math.max(raise, 0.6 * settle));
}

/**
 * Sets at to where ray i is at tick t: gliding in a loose school under
 * the surface, its wings beating slowly; now and then leaping clear, a
 * metre or two, wings flapping, and falling flat back onto the water with
 * a smack (scubadiverlife.com).
 */
function raySpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  at: Spot,
): boolean {
  if (!flockAt(e, k, t, null, mid)) {
    return false;
  }
  const s = swimSeed(e.seed, i);
  const u = (t - e.start) / STEPS;
  const life = (e.end - e.start) / STEPS;
  groupWay(e, k, t, way);
  inGroup(e, s, u, 4 + 3 * Math.sqrt(Math.max(e.count, 1)), at);
  at.heading = Number.NaN;
  at.roll = 0.1 * wave(u, lerp(5, 9, own(s, 13)), own(s, 14));
  at.fold = 0;
  at.stroke = 0.7;
  at.shown = true;
  at.breath = false;
  at.up = -swim.depth * lerp(0.7, 1.2, own(s, 6)) + 0.2 * wave(u, 8, own(s, 7));
  if (leapAt(swim, s, u, life, leap)) {
    const x = leap.at;
    at.up = -0.2 + leap.rise * x - (G * x * x) / 2 + 0.2 * (x / leap.air);
    at.pitch = 0.35 * (1 - (2 * x) / leap.air);
    at.roll = 0.5 * (own(s, 15) - 0.5) * Math.sin((Math.PI * x) / leap.air);
    at.stroke = 1;
  }
  return true;
}

/**
 * Sets at to where a shark is at tick t: slow at the surface, its fin and
 * the top of its back out, its tail sweeping it on a weaving course.
 */
function finSpot(
  e: LifeSeen,
  k: LifeKind,
  swim: SwimLook,
  i: number,
  t: number,
  at: Spot,
): boolean {
  if (!flockAt(e, k, t, null, mid)) {
    return false;
  }
  const s = swimSeed(e.seed, i);
  const u = (t - e.start) / STEPS;
  groupWay(e, k, t, way);
  const across = 4 * wave(u, lerp(30, 50, own(s, 1)), own(s, 2)) + (own(s, 5) - 0.5) * 6 * i;
  const sh = Math.sin(way.heading);
  const ch = Math.cos(way.heading);
  at.east = mid.east + ch * across;
  at.north = mid.north - sh * across;
  at.heading = Number.NaN;
  at.roll = 0;
  at.fold = 0;
  at.stroke = 0.15;
  at.shown = true;
  at.breath = false;
  at.up = -swim.depth + 0.03 * wave(u, 3, own(s, 3));
  return true;
}

/** Sets at to where animal i of a group of the water is at tick t. */
function spotOf(
  e: LifeSeen,
  k: LifeKind,
  i: number,
  t: number,
  boat: BoatAt | null,
  at: Spot,
): boolean {
  const swim = k.swim;
  if (swim === undefined) {
    return false;
  }
  at.pitch = Number.NaN;
  switch (k.form) {
    case 'pod':
      return podSpot(e, k, swim, i, t, e.with === 0 ? null : boat, at);
    case 'turtle':
      return turtleSpot(e, k, swim, i, t, at);
    case 'glider':
      // A fish landed aboard lies on the deck, drawn there (perch.ts).
      return e.with === 0 && glideSpot(e, k, swim, i, t, at);
    case 'whale':
      return whaleSpot(e, k, swim, i, t, at);
    case 'ray':
      return raySpot(e, k, swim, i, t, at);
    case 'fin':
      return finSpot(e, k, swim, i, t, at);
  }
  return false;
}

const a0 = newSpot();
const a1 = newSpot();
const a2 = newSpot();
const aheadPose: BoatAt = { east: 0, north: 0, heading: 0, speed: 0, bow: 0 };

/** The pose a boat at speed will have dt s on. */
function poseOn(pose: BoatAt | null, dt: number): BoatAt | null {
  if (pose === null) {
    return null;
  }
  const v = pose.speed ?? 0;
  aheadPose.east = pose.east + Math.sin(pose.heading) * v * dt;
  aheadPose.north = pose.north + Math.cos(pose.heading) * v * dt;
  aheadPose.heading = pose.heading;
  aheadPose.speed = v;
  aheadPose.bow = pose.bow ?? 0;
  return aheadPose;
}

/**
 * Sets out to where animal i of a group in the water is at tick t and how
 * it swims, with the boat it is with at boat: false where the group is
 * not alive, is not of the water, or its boat is not known.
 */
export function swimAt(
  e: LifeSeen,
  k: LifeKind,
  i: number,
  t: number,
  boat: BoatAt | null,
  out: SwimPlace,
): boolean {
  if (e.with !== 0 && boat === null) {
    return false;
  }
  if (!spotOf(e, k, i, t, boat, a0)) {
    return false;
  }
  out.east = a0.east;
  out.north = a0.north;
  out.up = a0.up;
  out.roll = a0.roll;
  out.fold = a0.fold;
  out.stroke = a0.stroke;
  out.shown = a0.shown;
  out.breath = a0.breath;
  const step = DT * STEPS;
  const t1 = Math.max(t - step, e.start);
  const t2 = Math.min(t + step, e.end - 1e-6);
  const d1 = (t1 - t) / STEPS;
  const d2 = (t2 - t) / STEPS;
  const ok1 = d1 < 0 && spotOf(e, k, i, t1, poseOn(boat, d1), a1);
  const ok2 = d2 > 0 && spotOf(e, k, i, t2, poseOn(boat, d2), a2);
  const a = ok1 ? a1 : a0;
  const b = ok2 ? a2 : a0;
  const de = b.east - a.east;
  const dn = b.north - a.north;
  const flat = Math.hypot(de, dn);
  const span = (ok2 ? d2 : 0) - (ok1 ? d1 : 0);
  out.heading = Number.isNaN(a0.heading)
    ? flat > 1e-4
      ? Math.atan2(de, dn)
      : e.heading
    : a0.heading;
  // Pitched by its way up or down against its way along, as if it went
  // at least so fast along (2 m/s for a pod, half a metre a second for
  // the rest): a slow animal rising does not stand on its tail.
  out.pitch = !Number.isNaN(a0.pitch)
    ? a0.pitch
    : span > 0
      ? Math.atan2(b.up - a.up, Math.max(flat, (k.form === 'pod' ? 2 : 0.5) * span))
      : 0;
  const v = span > 0 ? flat / span : 0;
  const s = swimSeed(e.seed, i);
  const swim = k.swim;
  const beat = swim?.beat ?? 1;
  const u = (t - e.start) / STEPS;
  // Its tail beats faster the faster it swims, and barely in the air.
  out.wave = out.up > 0.2 ? 0.25 : Math.min(0.4 + 0.15 * v, 1);
  out.beat = 2 * Math.PI * beat * (0.7 + 0.1 * Math.min(v, 6)) * u + own(s, 30) * 2 * Math.PI;
  return true;
}

/** A boil of bait: its middle, how far it reaches, m, and how strongly it boils now, 0 to 1. */
export interface Boil {
  east: number;
  north: number;
  reach: number;
  strength: number;
}

/** Sets out to a boil of bait at tick t, its strength up over its first half minute and down over its last minute; false where it is not alive. */
export function boilAt(e: LifeSeen, k: LifeKind, t: number, reach: number, out: Boil): boolean {
  if (!flockAt(e, k, t, null, mid)) {
    return false;
  }
  out.east = mid.east;
  out.north = mid.north;
  out.reach = reach;
  out.strength = smooth((t - e.start) / STEPS / 30) * smooth((e.end - t) / STEPS / 60);
  return true;
}
