// SPDX-License-Identifier: AGPL-3.0-only

// Where a group of the sea's life is, from its record and world time
// alone, or from its record, world time and the pose of the boat it is
// with, as the server finds it (internal/life/flock.go, held to its
// testdata/flocks.json): every phone draws the same group in the same
// place. A group comes in from its range and goes out to it, so nothing
// appears or vanishes near anyone: one passing crosses its centre at the
// middle of its life; one that soars, works or stays comes in along its
// heading, stays over its centre and goes on; one that drifts goes along
// its heading from its centre as it began; one with a boat comes in to a
// place astern of it, or to the boat itself for one riding its bow, keeps
// there, and goes on.

import type { LifeKind, LifePath } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';

/** Ticks a second of world time. */
const STEPS = 30;

/** A word mixed (Wellons' lowbias32), as the server's draws are. */
export function hash32(x: number): number {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A number in [0, 1) from a draw's top 24 bits, exactly. */
export function unit(h: number): number {
  return (h >>> 8) / (1 << 24);
}

/** A group's own number i in [0, 1), from its seed. */
export function own(seed: number, i: number): number {
  return unit(hash32((seed ^ hash32(i)) >>> 0));
}

/** A share u of the way from lo to hi. */
export function lerp(lo: number, hi: number, u: number): number {
  return lo + (hi - lo) * u;
}

/** Whether a path stays over its patch: it soars, works or stays. */
export function lingersOn(path: LifePath): boolean {
  return path === 'soar' || path === 'work' || path === 'stay';
}

/** Whether a kind stays over its patch, by its own path. */
export function lingers(k: LifeKind): boolean {
  return lingersOn(k.path);
}

/** The path a group follows: over the patch of a group it comes with, its kind's over if it has one, else its own. */
export function pathOf(k: LifeKind, e: LifeSeen): LifePath {
  return e.over !== '' && k.over !== undefined ? k.over : k.path;
}

/** Whether a kind rides a boat's bow. */
export function rides(k: LifeKind): boolean {
  return k.binds === 'ride';
}

/** How long a group of the kind takes to come in from its range at speed v, s. */
export function arrive(k: LifeKind, v: number): number {
  return k.range / Math.max(v, 0.1);
}

/** How far astern of its boat a group that follows it keeps, m. */
export function behind(seed: number): number {
  return 15 + 20 * own(seed, 2);
}

/** How high a group of the kind flies, m. */
export function flockHeight(k: LifeKind, seed: number): number {
  return lerp(k.height[0] ?? 0, k.height[1] ?? 0, own(seed, 3));
}

/** A boat as a group with it moves about it: m east and north, and its heading, radians clockwise from north. */
export interface Pose {
  east: number;
  north: number;
  heading: number;
}

/** Where a group's middle is: m east, north and up. */
export interface FlockPlace {
  east: number;
  north: number;
  up: number;
}

/**
 * Sets out to where a group's middle is at tick t and says whether it is
 * alive then: a group with a boat moves about pose, and is nowhere
 * without one.
 */
export function flockAt(
  e: LifeSeen,
  k: LifeKind,
  t: number,
  pose: Pose | null,
  out: FlockPlace,
): boolean {
  if (t < e.start || t >= e.end) {
    return false;
  }
  const u = (t - e.start) / STEPS;
  const life = (e.end - e.start) / STEPS;
  const v = e.speed;
  const a = Math.min(arrive(k, v), life / 2);
  const sin = Math.sin(e.heading);
  const cos = Math.cos(e.heading);
  out.up = flockHeight(k, e.seed);
  let cx = e.east;
  let cy = e.north;
  const path = pathOf(k, e);
  if (e.with !== 0) {
    if (pose === null) {
      return false;
    }
    cx = pose.east;
    cy = pose.north;
    if (!rides(k)) {
      const b = behind(e.seed);
      cx -= Math.sin(pose.heading) * b;
      cy -= Math.cos(pose.heading) * b;
    }
  } else if (path === 'drift') {
    out.east = cx + sin * v * u;
    out.north = cy + cos * v * u;
    return true;
  } else if (!lingersOn(path)) {
    const s = v * (u - life / 2);
    out.east = cx + sin * s;
    out.north = cy + cos * s;
    return true;
  }
  let s = 0;
  if (u < a) {
    s = -v * (a - u);
  } else if (u > life - a) {
    s = v * (u - (life - a));
  }
  out.east = cx + sin * s;
  out.north = cy + cos * s;
  return true;
}
