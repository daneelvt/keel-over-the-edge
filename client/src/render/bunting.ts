// SPDX-License-Identifier: AGPL-3.0-only

// The crowd's cheers seen: a burst of bunting from a boat's masthead, a
// strand of signal flags for each cheer up to a few, flung out round the
// mast and up, the air slowing them, drifting down the wind as they rise
// and flutter, and gone within seconds, as the gun's smoke is. The flags
// are the committee's own, from the same catalog, flown by the same draw.
// Each strand is where world time puts it, from the burst's own number.

import type { SignalSeen } from './flags';
import { HOIST_GAP } from './flags';

/** A burst of bunting: where it bursts, m east, north and up; when, world s; how many strands; its own number. */
export interface BuntingBurst {
  east: number;
  north: number;
  top: number;
  at: number;
  strands: number;
  seed: number;
}

/** How long a burst's bunting flies, s. */
export const BUNTING_LIFE = 5;
/** The most strands one burst throws, and the flags of a strand. */
export const BUNTING_STRANDS = 8;
export const STRAND_FLAGS = 3;
/** Bunting's flags against the committee's signal flags: a festive string's, smaller. */
export const BUNTING_SCALE = 0.5;
/** How far a strand is flung out, m, and how high it rises, m, at most; it bursts from this share of the masthead's height. */
const FLUNG = 4;
const RISE = 2.5;
const FROM = 0.7;
/** The air's stop on a strand, s: its throw dies over this. */
const DRAG = 0.8;

/** A fixed draw in [0, 1) for a burst, a strand and a purpose. */
function draw(seed: number, i: number, k: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233 + k * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

/** How many strands a burst of count cheers throws. */
export function strandsOf(count: number): number {
  return Math.max(1, Math.min(BUNTING_STRANDS, Math.round(1 + 2 * Math.log2(Math.max(count, 1)))));
}

/**
 * The flags of a burst flying at world time s, in a wind of speed m/s
 * from from (radians clockwise from north), its designs drawn from those
 * of designs (catalog indices): appended to out, each strand's flags hung
 * one under another from its head. Nothing once the burst has flown.
 */
export function buntingFlags(
  b: BuntingBurst,
  time: number,
  speed: number,
  from: number,
  designs: readonly number[],
  hoists: readonly number[],
  out: SignalSeen[],
): void {
  const age = time - b.at;
  if (age < 0 || age > BUNTING_LIFE || designs.length === 0) {
    return;
  }
  // Down the wind: the way it blows to.
  const downE = -Math.sin(from);
  const downN = -Math.cos(from);
  const thrown = DRAG * (1 - Math.exp(-age / DRAG));
  const drift = speed * 0.2 * age;
  const n = Math.min(b.strands, BUNTING_STRANDS);
  for (let j = 0; j < n; j++) {
    const a = 2 * Math.PI * (j / n + draw(b.seed, j, 1) * 0.3);
    const out1 = (FLUNG * (0.5 + 0.5 * draw(b.seed, j, 2))) / DRAG;
    const up = (RISE * (0.6 + 0.4 * draw(b.seed, j, 3))) / DRAG;
    const east = b.east + Math.sin(a) * out1 * thrown + downE * drift;
    const north = b.north + Math.cos(a) * out1 * thrown + downN * drift;
    let head = b.top * FROM + up * thrown + 0.15 * age;
    for (let k = 0; k < STRAND_FLAGS; k++) {
      const d = Math.floor(draw(b.seed, j, 10 + k) * designs.length);
      const flag = designs[d] as number;
      out.push({
        east,
        north,
        top: head,
        speed: Math.max(speed, 3),
        from,
        flag,
        seed: b.seed + j * 7 + k,
        scale: BUNTING_SCALE,
      });
      head -= ((hoists[d] ?? 0.6) + HOIST_GAP) * BUNTING_SCALE;
    }
  }
}
