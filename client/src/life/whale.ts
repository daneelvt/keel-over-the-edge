// SPDX-License-Identifier: AGPL-3.0-only

// A whale's round, as the server keeps it (internal/life/whale.go, held to
// its testdata/whales.json): each whale of a group, by the group's seed and
// its number in it, is down for one of its kind's dives, then up at the
// surface for a bout of its kind's breaths, a blow at each, its kind's
// blowEvery apart, and down again, raising its flukes on its kind's share
// of its dives; in a share of its bouts it breaches between two blows, or
// slaps the water with its tail. A whale that drifts (a sperm whale logging
// at the surface) is met for its one long bout, about 9 min blowing about
// five times a minute, and flukes up at its end (Watwood and others 2006).
// Every phone and the server find the same blows at the same times.

import type { LifeKind, SwimLook } from '../catalog/types.gen';
import type { LifeSeen } from '../net/messages';
import { hash32, lerp, own } from './flock';

/** Ticks a second of world time. */
const STEPS = 30;

/** The events of a whale's round. */
export const WHALE_BLOW = 0;
export const WHALE_BREACH = 1;
export const WHALE_SLAP = 2;
export const WHALE_FLUKE = 3;

/** How long before its first blow its head comes up, and its dive from the surface takes, s. */
export const WHALE_UP = 6;
export const WHALE_DIVE = 8;
/** A breach from its start to its fall back, and when it hits the water; a slap's turn of the tail, hitting at its middle, s. */
export const WHALE_BREACH_TIME = 7;
export const WHALE_FALL = 4.4;
export const WHALE_SLAP_TIME = 4;
/** How long before a drifting whale's end its dive ends, s. */
const LEAVE = 6;

/** The own numbers of a whale's round. */
const OWN_ROUND = 60;
const BOUT_SALT = 9000;
const BOUT_BLOWS = 1;
const BOUT_EVERY = 2;
const BOUT_DIVE = 3;
const BOUT_FLUKE = 4;
const BOUT_BURST = 5;
const BOUT_WHERE = 6;

/** A whale's bout: its start (its first blow), s into the group's life; its blows and their gap, s; its breach's or slap's start (−1 for neither); and whether its dive raises its flukes. */
export interface Bout {
  start: number;
  blows: number;
  every: number;
  breach: number;
  slap: number;
  fluke: boolean;
}

export function newBout(): Bout {
  return { start: 0, blows: 0, every: 0, breach: -1, slap: -1, fluke: false };
}

/** How long a bout is at the surface, from its first blow to the dive after its last. */
export function surfaceOf(b: Bout): number {
  return b.blows * b.every;
}

/** A float made an int32, truncating toward zero and saturating, as the server's toInt32. */
function toInt32(f: number): number {
  if (Number.isNaN(f)) {
    return 0;
  }
  if (f >= 2147483647) {
    return 2147483647;
  }
  if (f <= -2147483648) {
    return -2147483648;
  }
  return Math.trunc(f);
}

function pairAt(p: readonly number[] | undefined, u: number, or: number): number {
  if (p === undefined || p.length === 0) {
    return or;
  }
  if (p.length === 1) {
    return p[0] as number;
  }
  return lerp(p[0] as number, p[1] as number, u);
}

function intPairAt(p: readonly number[] | undefined, u: number, or: number): number {
  if (p === undefined || p.length === 0) {
    return or;
  }
  if (p.length === 1) {
    return p[0] as number;
  }
  return toInt32(Math.floor(lerp(p[0] as number, p[1] as number, u) + 0.5));
}

/** Whale i's own seed in a group of seed. */
export function whaleSeed(seed: number, i: number): number {
  return hash32((seed ^ hash32(2000 + i)) >>> 0);
}

/** Whale s's n-th bout, starting at start, into out; its dive before it, s. */
function bout(sw: SwimLook, s: number, n: number, start: number, out: Bout): number {
  const ks = hash32((s ^ hash32(BOUT_SALT + n)) >>> 0);
  out.start = start;
  out.breach = -1;
  out.slap = -1;
  out.blows = Math.max(intPairAt(sw.breaths, own(ks, BOUT_BLOWS), 1), 1);
  out.every = pairAt(sw.blowEvery, own(ks, BOUT_EVERY), 30);
  const dive = pairAt(sw.dive, own(ks, BOUT_DIVE), 300);
  out.fluke = own(ks, BOUT_FLUKE) < (sw.fluke ?? 0);
  if (out.blows >= 2 && out.every >= WHALE_BREACH_TIME + 2) {
    const gaps = out.blows - 1;
    const j = Math.min(toInt32(own(ks, BOUT_WHERE) * gaps), gaps - 1);
    const at = (long: number): number => start + j * out.every + out.every / 2 - long / 2;
    const burst = own(ks, BOUT_BURST);
    const br = sw.breach ?? 0;
    if (burst < br) {
      out.breach = at(WHALE_BREACH_TIME);
    } else if (burst < br + (sw.slap ?? 0)) {
      out.slap = at(WHALE_SLAP_TIME);
    }
  }
  return dive;
}

const first = newBout();

/**
 * Sets out to whale i's bout at u s into a group's life of life s: the
 * bout at the surface u is in, or the next after its dive; false for none.
 */
export function round(
  k: LifeKind,
  seed: number,
  i: number,
  u: number,
  life: number,
  out: Bout,
): boolean {
  const sw = k.swim;
  if (sw === undefined) {
    return false;
  }
  const s = whaleSeed(seed, i);
  if (k.path === 'drift') {
    const every = pairAt(sw.blowEvery, own(s, BOUT_EVERY), 30);
    const span = life - WHALE_UP - WHALE_DIVE - LEAVE;
    out.start = WHALE_UP;
    out.every = every;
    out.breach = -1;
    out.slap = -1;
    out.fluke = (sw.fluke ?? 0) > 0;
    out.blows = Math.max(toInt32(Math.floor(span / every)), 1);
    return u < life;
  }
  const d0 = bout(sw, s, 0, 0, first);
  let start = -(own(s, OWN_ROUND) * (d0 + surfaceOf(first) + WHALE_DIVE));
  for (let n = 0; start < life && n < 10000; n++) {
    const dive = bout(sw, s, n, 0, out);
    out.start = start + dive + WHALE_UP;
    if (out.breach >= 0) {
      out.breach += out.start;
    }
    if (out.slap >= 0) {
      out.slap += out.start;
    }
    if (u < out.start + surfaceOf(out) + WHALE_DIVE) {
      return out.start - WHALE_UP < life;
    }
    start = out.start + surfaceOf(out) + WHALE_DIVE;
  }
  return false;
}

const scratch = newBout();

/**
 * Calls add with each event of whale i of a group whose time, s into the
 * group's life, is in [from, to): its blows, a breach's fall, a slap's
 * hit and a dive with its flukes raised.
 */
export function whaleEvents(
  k: LifeKind,
  e: LifeSeen,
  i: number,
  from: number,
  to: number,
  add: (event: number, at: number) => void,
): void {
  const life = (e.end - e.start) / STEPS;
  const lo = Math.max(from, 0);
  const hi = Math.min(to, life);
  let u = lo;
  const b = scratch;
  while (u < hi) {
    if (!round(k, e.seed, i, u, life, b)) {
      return;
    }
    for (let j = 0; j < b.blows; j++) {
      const at = b.start + j * b.every;
      if (at >= lo && at < hi) {
        add(WHALE_BLOW, at);
      }
    }
    const fall = b.breach + WHALE_FALL;
    if (b.breach >= 0 && fall >= lo && fall < hi) {
      add(WHALE_BREACH, fall);
    }
    const hit = b.slap + WHALE_SLAP_TIME / 2;
    if (b.slap >= 0 && hit >= lo && hit < hi) {
      add(WHALE_SLAP, hit);
    }
    const dive = b.start + surfaceOf(b);
    if (b.fluke && dive >= lo && dive < hi) {
      add(WHALE_FLUKE, dive);
    }
    const next = dive + WHALE_DIVE;
    if (!(next > u)) {
      return;
    }
    u = next;
  }
}
