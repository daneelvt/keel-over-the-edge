// SPDX-License-Identifier: AGPL-3.0-only

// The signal gun's smoke: a report throws a burst of white puffs out of the
// muzzle, which the air stops within a fraction of a second; each is then
// a thermal of hot gas, gathering its rise, rising as the wind carries it
// and slowing as it takes in air and grows (Scorer, 1957: a thermal's rise
// falls off as it widens). Its rise w = w₀ / (1 + t/τ) gives a height of
// w₀ τ ln(1 + t/τ), halved after τ and still climbing slowly, taken up
// over its first seconds by t² / (t² + g²): so the burst hangs by the
// muzzle a moment, then stands high enough to be seen over the horizon
// from far off, drifting down the wind and thinning as it goes. Each puff
// is where world time puts it, from the report's own number, so every
// phone shows the same smoke.

import type { CommitteeGun } from '../catalog/types.gen';

/** A report: where its muzzle was, m east, north and up; the way the muzzle pointed (a unit vector east and north); when, world s; how loud (1 a signal); its own number. */
export interface Burst {
  east: number;
  north: number;
  up: number;
  wayEast: number;
  wayNorth: number;
  at: number;
  loud: number;
  seed: number;
}

/** A puff of a burst: m east, north and up from the muzzle; its width, m; how thick it still is, 0 to 1. */
export interface BurstPuff {
  east: number;
  north: number;
  up: number;
  width: number;
  thick: number;
}

/** A fixed draw in [0, 1) for a burst's puff and a purpose. */
function draw(seed: number, i: number, k: number): number {
  const x = Math.sin(seed * 12.9898 + i * 78.233 + k * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

/** How many puffs a report as loud as this throws. */
export function puffsOf(cat: CommitteeGun, loud: number): number {
  return Math.max(1, Math.round(cat.puffs * Math.max(loud, 0.25)));
}

/**
 * Where puff i of a burst is at age seconds, in a wind of speed m/s from
 * from (radians clockwise from north): thrown along the muzzle's way and
 * stopped by the air, risen as a thermal, carried down the wind; or null
 * once it has faded.
 */
export function burstPuff(
  cat: CommitteeGun,
  b: Burst,
  i: number,
  age: number,
  speed: number,
  from: number,
): BurstPuff | null {
  if (age < 0 || age > cat.life) {
    return null;
  }
  const loud = Math.max(b.loud, 0.25);
  // Thrown out of the muzzle, fanning out a little, and stopped by the air.
  const turn = (draw(b.seed, i, 1) - 0.5) * 0.9;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const wayE = b.wayEast * c + b.wayNorth * s;
  const wayN = -b.wayEast * s + b.wayNorth * c;
  const v0 = cat.throw * (0.3 + 0.7 * draw(b.seed, i, 2)) * Math.sqrt(loud);
  const thrown = v0 * cat.drag * (1 - Math.exp(-age / cat.drag));
  const lift = (draw(b.seed, i, 3) - 0.3) * 0.35 * thrown;
  // Then a thermal, rising and slowing, carried with the air.
  const gathered = (age * age) / (age * age + cat.gathers * cat.gathers);
  const rise =
    cat.rise *
    (0.7 + 0.5 * draw(b.seed, i, 4)) *
    cat.slows *
    Math.log1p(age / cat.slows) *
    gathered;
  const downE = -Math.sin(from) * speed * age;
  const downN = -Math.cos(from) * speed * age;
  const share = age / cat.life;
  const [s0, s1] = cat.size as [number, number];
  const width =
    (s0 + (s1 - s0) * Math.sqrt(share)) * (0.7 + 0.6 * draw(b.seed, i, 5)) * Math.cbrt(loud);
  // The cloud spreads as its puffs grow: each wanders off its way by up
  // to half its width.
  const spreadE = (draw(b.seed, i, 6) - 0.5) * width;
  const spreadN = (draw(b.seed, i, 7) - 0.5) * width;
  return {
    east: wayE * thrown + downE + spreadE,
    north: wayN * thrown + downN + spreadN,
    up: lift + rise,
    width,
    thick: 1 - share * share,
  };
}
