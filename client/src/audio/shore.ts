// SPDX-License-Identifier: AGPL-3.0-only

// Two sounds of being near the land, which only the page plays: the
// halyards of the boats in port tapping their masts as the wind sets them
// swinging, and the surf breaking on a shore the boat sails near, heard as
// the water shoals under it. The halyards' taps are drawn from world time,
// so every phone in port hears them alike; they come in pairs (a halyard
// swings to the mast and back), oftener in a stronger wind. The surf
// swells and falls at a long sea's period.

import type { MixRecipe } from './mix';

/** 0 below from, rising smoothly to 1 at full. */
function ramp(from: number, full: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (full - from)));
  return t * t * (3 - 2 * t);
}

/** A number from 0 to 1 for a slot and a draw, the same on every phone. */
function unit(slot: number, k: number): number {
  const v = Math.sin(slot * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/** A halyard's tap: when (world seconds), how loud (a gain) and its own number. */
export interface Tap {
  at: number;
  level: number;
  seed: number;
}

/** How long a slot of the halyards' time is, s: at most one swing in each. */
const SLOT = 0.5;

/** The halyards' level in port in an apparent wind (m/s): none at sea or in a calm. */
export function halyardsLevel(r: MixRecipe['halyards'], inPort: boolean, wind: number): number {
  return inPort ? r.level * ramp(r.wind[0] ?? 2, r.wind[1] ?? 9, wind) : 0;
}

/**
 * The taps due from from to to, world seconds, at level: a swing every
 * so often (every, s, from a light wind to a strong one), each a tap and,
 * half the time, its answer a pair's gap later.
 */
export function halyardTaps(
  r: MixRecipe['halyards'],
  from: number,
  to: number,
  level: number,
  wind: number,
): Tap[] {
  const out: Tap[] = [];
  if (!(level > 0) || !(to > from)) {
    return out;
  }
  const every =
    (r.every[0] ?? 2.5) +
    ((r.every[1] ?? 0.8) - (r.every[0] ?? 2.5)) * ramp(r.wind[0] ?? 2, r.wind[1] ?? 9, wind);
  const p = Math.min(1, SLOT / every);
  // From the slot before: its answer may fall in this one.
  for (let slot = Math.floor(from / SLOT) - 1; slot * SLOT < to; slot++) {
    if (unit(slot, 1) >= p) {
      continue;
    }
    const at = (slot + 0.8 * unit(slot, 2)) * SLOT;
    const l = level * (0.6 + 0.4 * unit(slot, 3));
    if (at >= from && at < to) {
      out.push({ at, level: l, seed: slot });
    }
    const answer = at + r.pair * (0.8 + 0.4 * unit(slot, 5));
    if (unit(slot, 4) < 0.5 && answer >= from && answer < to) {
      out.push({ at: answer, level: 0.6 * l, seed: slot + 0.5 });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The surf's level with the water depth m deep under the boat (none over
 * land or out of sight of a shore) and the sea's height m, at world time s:
 * louder as the water shoals and the sea rises, swelling at the period.
 */
export function surfLevel(
  r: MixRecipe['surf'],
  depth: number,
  seaHeight: number,
  time: number,
): number {
  if (!(depth > 0)) {
    return 0;
  }
  const near = 1 - ramp(r.depth[1] ?? 3, r.depth[0] ?? 12, depth);
  const sea = ramp(r.height[0] ?? 0.15, r.height[1] ?? 1.5, seaHeight);
  const s = Math.sin((Math.PI * time) / r.period);
  return r.level * near * sea * (0.35 + 0.65 * s * s);
}
