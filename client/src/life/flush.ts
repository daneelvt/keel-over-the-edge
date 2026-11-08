// SPDX-License-Identifier: AGPL-3.0-only

// The fish a boat flushes from a ground of flying fish, as the server
// finds them (internal/life/flush.go, held to its testdata/flushes.json):
// a pure function of the ground, the boat's id, the flushes' slot of time,
// the bow and the tick, so that a phone with no server flushes the same
// fish from the same inputs. A ground is never seen itself: every
// `flush.every` s, a boat sailing through it at the binding's speed or
// faster flushes some of its fish at the catalog's chance, by a draw of
// the ground's seed, the boat and the slot; they break the surface ahead
// of the bow and to either side of its course, heading near the boat's
// way, and are gone once they have glided their linked glides.

import type { Life, LifeKind } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { hash32, lerp, own, type Pose, unit } from './flock';

/** Ticks a second of world time. */
const STEPS = 30;

/** Keeps the flushes' draws apart from the schedule's. */
const FLUSH_SALT = 0x2f6e9a51;

/** How far a flush's heading may be from its boat's, rad. */
const FLUSH_TURN = 0.6;

/** How long a flush is kept after its fish have glided, s. */
const FLUSH_AFTER = 3;

/** Which of a group's own numbers draws how far its patch reaches. */
const OWN_PATCH = 30;

/** The draws' numbers, as the server's schedule numbers them. */
const DRAW_WHETHER = 0;
const DRAW_EAST = 2;
const DRAW_NORTH = 3;
const DRAW_HEADING = 4;
const DRAW_COUNT = 5;
const DRAW_SEED = 6;
const DRAW_SPEED = 7;

/** A key's i-th number. */
function n(d: number, i: number): number {
  return hash32((d ^ hash32(i)) >>> 0);
}

/** A chance as a draw's threshold: a draw below it happens. */
function threshold(c: number): number {
  if (!(c > 0)) {
    return 0;
  }
  if (c >= 1) {
    return 0xffffffff;
  }
  return (Math.trunc(c * 2 ** 31) << 1) >>> 0;
}

/** Seconds as whole ticks, rounded to the nearest. */
function ticks(s: number): number {
  return Math.floor(s * STEPS + 0.5);
}

/** An angle in [0, 2π). */
function turn(a: number): number {
  const whole = 2 * Math.PI;
  let t = a - Math.floor(a / whole) * whole;
  if (t < 0) {
    t += whole;
  }
  if (t >= whole) {
    t -= whole;
  }
  return t;
}

/** A 64-bit number's low and high words. */
function words(v: bigint | number): [number, number] {
  const u = BigInt.asUintN(64, BigInt(v));
  return [Number(u & 0xffffffffn), Number(u >> 32n)];
}

/** How far the patch of a group of the kind of its own seed reaches from its middle, m. */
export function patchOf(k: LifeKind, seed: number): number {
  return lerp(k.patch?.[0] ?? 0, k.patch?.[1] ?? 0, own(seed, OWN_PATCH));
}

/** How far a fish of the kind glides, its glides linked, m. */
export function linked(k: LifeKind): number {
  return k.swim?.linked ?? k.swim?.glide?.[1] ?? 0;
}

/** The flushes' slot a tick is in. */
export function flushSlot(life: Life, tick: number): number {
  return Math.floor(tick / Math.max(ticks(life.flush.every), 1));
}

/** Whether a point is within a ground's patch, reach m from its centre. */
export function inGround(ground: LifeSeen, reach: number, east: number, north: number): boolean {
  const dx = east - ground.east;
  const dy = north - ground.north;
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * The fish the boat of id boat, its bow at bow, flushes from a ground of
 * kind k in the flushes' slot at tick now, or null for none. The flush's
 * id is '' and its boat none: the caller gives it an id. The caller says
 * whether the boat is in the ground (inGround, by patchOf) and fast
 * enough (life.bind.speed).
 */
export function flush(
  life: Life,
  k: LifeKind,
  ground: LifeSeen,
  boat: bigint | number,
  slot: number,
  bow: Pose,
  now: number,
): LifeSeen | null {
  const [boatLo, boatHi] = words(boat);
  const [slotLo, slotHi] = words(slot);
  let key = hash32((ground.seed ^ FLUSH_SALT) >>> 0);
  key = hash32((key ^ boatLo) >>> 0);
  key = hash32((key ^ boatHi) >>> 0);
  key = hash32((key ^ slotLo) >>> 0);
  const d = hash32((key ^ slotHi) >>> 0);
  const f = life.flush;
  if (n(d, DRAW_WHETHER) >= threshold(f.chance)) {
    return null;
  }
  const ahead = lerp(f.ahead[0], f.ahead[1], unit(n(d, DRAW_EAST)));
  const beside = (2 * unit(n(d, DRAW_NORTH)) - 1) * f.beside;
  const sin = Math.sin(bow.heading);
  const cos = Math.cos(bow.heading);
  const east = bow.east + sin * ahead + cos * beside;
  const north = bow.north + cos * ahead - sin * beside;
  const heading = bow.heading + (2 * unit(n(d, DRAW_HEADING)) - 1) * FLUSH_TURN;
  const low = k.group[0];
  const span = Math.max(k.group[1] - low, 0) + 1;
  const start = now + ticks(f.lead);
  return {
    id: '',
    rev: 0,
    kind: ground.kind,
    start,
    end: start + Math.ceil((linked(k) / Math.max(k.speed[0], 0.1) + FLUSH_AFTER) * STEPS),
    east: Math.floor(east * 100 + 0.5) / 100,
    north: Math.floor(north * 100 + 0.5) / 100,
    heading: Math.fround(turn(heading)),
    speed: Math.fround(lerp(k.speed[0], k.speed[1], unit(n(d, DRAW_SPEED)))),
    count: low + (n(d, DRAW_COUNT) % span),
    seed: n(d, DRAW_SEED),
    with: 0,
    over: ground.id,
  };
}
