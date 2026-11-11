// SPDX-License-Identifier: AGPL-3.0-only

// What comes aboard a boat, drawn where her model is as the page draws her
// (heeled, pitched and lifted by the sea):
//
// - A booby that perches: it flies in from its range to the boat's perch,
//   coming down onto it a little clumsily, wings up and wobbling as it
//   grips; it stands facing the wind, as a perched bird does, or by night
//   sleeps with its head under its wing; and at its time it drops off and
//   flies on. Boobies perch on yachts for a night or many, often on a
//   pulpit or a rail (sailboat-cruising.com).
// - A flying fish that lands on a lit deck at night: it hits the deck with
//   a thump, flaps for a while, and lies still till it is gone
//   (yachtingworld.com).
//
// Each is a pure function of the record, world time and the boat's pose,
// so every page draws the same bird on the same boat.

import type { LifeKind } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import type { BoatAt } from './birds';
import { lerp, own } from './flock';

/** Ticks a second of world time. */
const STEPS = 30;
/** A booby's landing: its last glide down onto the perch, and the wobble after, s. */
export const LANDING = 2;
const WOBBLE = 1.6;
/** How long a fish aboard flaps before lying still, s. */
const FLAPS = 20;

/** A point of a boat's model in the world, as the page draws her: m east, north and up. */
export interface BoatPoint {
  east: number;
  north: number;
  up: number;
}

/** A boat as what is aboard reads it: her pose as drawn, and her perch, deck and centre of gravity, in her model's frame. */
export interface Aboard {
  perch: readonly number[];
  deck: readonly number[];
  cog: number;
}

/**
 * Sets out to a point of a boat's model (x to starboard, y up, z aft) in
 * the world: heeled and pitched about her centre of gravity, turned to her
 * heading and lifted by her heave, as her model is placed.
 */
export function boatPoint(
  boat: BoatAt,
  point: readonly number[],
  cog: number,
  out: BoatPoint,
): BoatPoint {
  const x0 = point[0] ?? 0;
  const y0 = (point[1] ?? 0) - cog;
  const z0 = point[2] ?? 0;
  // Heel about her length (z), to starboard down for a heel to starboard.
  const zr = -(boat.heel ?? 0);
  const cz = Math.cos(zr);
  const sz = Math.sin(zr);
  const x1 = x0 * cz - y0 * sz;
  const y1 = x0 * sz + y0 * cz;
  // Pitch about her beam (x), bow up.
  const xr = boat.pitch ?? 0;
  const cx = Math.cos(xr);
  const sx = Math.sin(xr);
  const y2 = y1 * cx - z0 * sx;
  const z2 = y1 * sx + z0 * cx;
  const y3 = y2 + cog;
  // Turned to her heading: her bow (−z) toward it.
  const sh = Math.sin(boat.heading);
  const ch = Math.cos(boat.heading);
  out.east = boat.east + x1 * ch - z2 * sh;
  out.north = boat.north - x1 * sh - z2 * ch;
  out.up = (boat.heave ?? 0) + y3;
  return out;
}

/** Where a perching bird is: flying to or from the perch, or on it, and how it stands. */
export interface PerchPlace {
  /** On the perch: drawn as its body; else flying, drawn as a bird. */
  perched: boolean;
  east: number;
  north: number;
  up: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Its wings, 0 spread to 1 folded, as it flies in or out. */
  folded: boolean;
}

export function newPerchPlace(): PerchPlace {
  return {
    perched: false,
    east: 0,
    north: 0,
    up: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    folded: false,
  };
}

const at: BoatPoint = { east: 0, north: 0, up: 0 };
const deckPoint = [0, 0, 0];

/**
 * Sets out to where a perching bird of a group with a boat is at tick t,
 * the boat at boat, her perch's point and centre of gravity in aboard, the
 * wind from windFrom, radians: false where it is not alive. It comes in
 * along its record's heading from its kind's range, lands, and goes on
 * along the same heading.
 */
export function perchAt(
  e: LifeSeen,
  k: LifeKind,
  t: number,
  boat: BoatAt,
  aboard: Aboard,
  windFrom: number,
  out: PerchPlace,
): boolean {
  if (t < e.start || t >= e.end) {
    return false;
  }
  const u = (t - e.start) / STEPS;
  const life = (e.end - e.start) / STEPS;
  const v = Math.max(e.speed, 0.1);
  const a = Math.min(k.range / v, life / 2);
  boatPoint(boat, aboard.perch, aboard.cog, at);
  const height = lerp(k.height[0] ?? 6, k.height[1] ?? 20, own(e.seed, 3));
  const sh = Math.sin(e.heading);
  const ch = Math.cos(e.heading);
  out.roll = 0;
  out.folded = false;
  if (u < a || u > life - a) {
    // Flying in along its heading, coming down to the perch over its last
    // stretch; or dropping off it and flying on, climbing.
    const coming = u < a;
    const d = coming ? v * (a - u) : v * (u - (life - a));
    const s = coming ? -d : d;
    const rise = height * Math.min(d / Math.max(k.range * 0.5, 1), 1);
    out.perched = false;
    out.east = at.east + sh * s;
    out.north = at.north + ch * s;
    out.up = at.up + 0.25 + rise * (coming ? 1 : 0.8) + (coming ? 0 : Math.min(d, 2) * 0.3);
    out.heading = e.heading;
    out.pitch = coming ? 0.15 + 0.4 * Math.max(0, 1 - d / (v * LANDING)) : -0.1;
    return true;
  }
  // On the perch, facing the wind; wobbling as it grips after landing.
  const on = u - a;
  const wob = on < WOBBLE ? Math.exp(-3 * on) : 0;
  out.perched = true;
  out.east = at.east;
  out.north = at.north;
  out.up = at.up + 0.06 * wob * Math.abs(Math.sin(9 * on));
  out.heading = windFrom + 0.25 * (own(e.seed, 5) - 0.5);
  out.pitch = 0.45 * wob * Math.sin(11 * on);
  out.roll = 0.3 * wob * Math.sin(7 * on + 1);
  return true;
}

/** Where a fish aboard lies: on the deck, how it flaps. */
export interface DeckPlace {
  east: number;
  north: number;
  up: number;
  heading: number;
  /** How hard it flaps, 0 to 1. */
  flap: number;
}

export function newDeckPlace(): DeckPlace {
  return { east: 0, north: 0, up: 0, heading: 0, flap: 0 };
}

/**
 * Sets out to where a fish landed on a boat's deck lies at tick t: by the
 * deck's point, a little off it by its own numbers, turned as it fell;
 * flapping hard at first and dying down. False where it is not alive.
 */
export function deckAt(
  e: LifeSeen,
  t: number,
  boat: BoatAt,
  aboard: Aboard,
  out: DeckPlace,
): boolean {
  if (t < e.start || t >= e.end) {
    return false;
  }
  const u = (t - e.start) / STEPS;
  const p = aboard.deck;
  const point = deckPoint;
  point[0] = (p[0] ?? 0) + (own(e.seed, 1) - 0.5) * 0.3;
  point[1] = (p[1] ?? 0) + 0.03;
  point[2] = (p[2] ?? 0) + (own(e.seed, 2) - 0.5) * 0.4;
  boatPoint(boat, point, aboard.cog, at);
  out.east = at.east;
  out.north = at.north;
  out.up = at.up;
  out.heading = boat.heading + own(e.seed, 3) * 2 * Math.PI;
  out.flap = u < FLAPS ? (1 - u / FLAPS) * (0.5 + 0.5 * Math.abs(Math.sin(1.7 * u))) : 0;
  return true;
}
