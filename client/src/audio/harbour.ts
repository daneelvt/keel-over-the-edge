// SPDX-License-Identifier: AGPL-3.0-only

// The harbour's voices, as numbers and events: what the sound engine plays
// in port or near a town. The water laps at the quays and piers at the
// waves' period; the harbour bell strikes the watches by the world's clock,
// the same for everyone ("strike the bell: … as many times as there are
// half hours of the watch elapsed … The watch of four hours is eight
// bells", Smyth, The Sailor's Word-Book, 1867), its strokes in pairs; gulls
// call by day, a few a minute, each call from one of the gulls wheeling
// over the nearest town, where it is as it calls; the shipyard's mallets
// knock at Port Royal by day. Each is placed where it is: panned by its bearing from where the
// camera looks, and fainter with distance, a point source's 6 dB each time
// the distance doubles. Which call and which blow comes when is drawn from
// world time, so every phone hears the harbour alike.

import bell from '../../../art/sound/bell.json';
import gulls from '../../../art/sound/gulls.json';
import lapping from '../../../art/sound/lapping.json';
import mallets from '../../../art/sound/mallets.json';
import { catalog } from '../catalog';
import { type GullPlace, type GullTown, gullAt, gullCount } from '../life/gulls';

export interface HarbourRecipes {
  bell: typeof bell;
  gulls: typeof gulls;
  lapping: typeof lapping;
  mallets: typeof mallets;
}

export const HARBOUR_RECIPES: HarbourRecipes = { bell, gulls, lapping, mallets };

/** A place, m east and north. */
export interface At {
  east: number;
  north: number;
}

/** What the harbour sounds like from here, now. */
export interface HarbourInput {
  /** World time, s, and the world's hour, 0 to 24, noon at 12. */
  seconds: number;
  hour: number;
  /** Whether the sun is up at the listener. */
  day: boolean;
  /** The listener, and the bearing the camera looks along, radians. */
  listener: At;
  look: number;
  /** Whether the listener is in port; how far the nearest of a town's buildings is, m. */
  inPort: boolean;
  nearTown: number;
  /** The harbour's bell, the shipyard's slip, the nearest quay's edge: null for none near. */
  bell: At | null;
  yard: At | null;
  quay: At | null;
  /** The towns' gulls held (gullTowns). */
  gulls: readonly GullTown[];
  /** The sea's significant height and its waves' period, m and s. */
  seaHeight: number;
  period: number;
}

/** A sound to play once: which, when (world seconds), how loud, panned how, and its own number. */
export interface HarbourEvent {
  kind: 'bell' | 'gull' | 'mallet';
  at: number;
  level: number;
  pan: number;
  seed: number;
}

/** The harbour is heard in port, or within this of a town's buildings, m. */
export const HEARD_WITHIN = 300;

/** The half hour of the world's day an hour is in, from midnight: 0 to 47. */
export function halfHour(hour: number): number {
  return Math.floor((((hour % 24) + 24) % 24) * 2);
}

/** How many strokes the bell strikes at the half hour it is in: one to eight, eight at a watch's end. */
export function bellStrokes(hour: number): number {
  const n = halfHour(hour) % 8;
  return n === 0 ? 8 : n;
}

/** When each stroke of a striking falls, s after it begins: in pairs, the odd one last. */
export function strokeTimes(strokes: number, r: HarbourRecipes['bell']): number[] {
  const out: number[] = [];
  for (let i = 0; i < strokes; i++) {
    out.push(Math.floor(i / 2) * (r.stroke + r.pair) + (i % 2) * r.stroke);
  }
  return out;
}

/** The bell's partials, Hz: its prime times the ideal tuning's ratios. */
export function bellPartials(r: HarbourRecipes['bell']): number[] {
  return r.partials.map((k) => k * r.prime);
}

/** A point source's level at d m: whole within near, falling as near / d (6 dB a doubling), nothing beyond reach. */
export function pointLevel(d: number, near: number, reach: number): number {
  if (d > reach) {
    return 0;
  }
  return Math.min(1, near / Math.max(d, 1e-6));
}

/** A source's pan from the listener: by its bearing from where the camera looks, −1 left to 1 right. */
export function panOf(listener: At, source: At, look: number): number {
  const b = Math.atan2(source.east - listener.east, source.north - listener.north);
  return Math.sin(b - look);
}

/** Whether the harbour is heard at all: in port, or near a town. */
export function heard(x: HarbourInput): boolean {
  return x.inPort || x.nearTown <= HEARD_WITHIN;
}

/** The town whose gulls wheel nearest the listener within the gulls' reach, null for none. */
export function nearestGulls(x: HarbourInput, reach: number): GullTown | null {
  let best: GullTown | null = null;
  let bd = reach;
  for (const t of x.gulls) {
    const d = Math.hypot(t.east - x.listener.east, t.north - x.listener.north);
    if (d <= bd) {
      best = t;
      bd = d;
    }
  }
  return best;
}

const gull: GullPlace = { east: 0, north: 0, up: 0, heading: 0 };

/** A number in [0, 1) of slot n of a voice: the same on every phone. */
function draw(n: number, voice: number): number {
  const v = Math.sin(n * 12.9898 + voice * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The events due between world seconds from and to, as the listener hears
 * them: the bell's strokes when a half hour of the world's day begins, the
 * gulls' calls by day, the mallets' blows by day.
 */
export function harbourEvents(
  r: HarbourRecipes,
  x: HarbourInput,
  from: number,
  to: number,
  secondsPerHour: number,
): HarbourEvent[] {
  const out: HarbourEvent[] = [];
  if (!heard(x) || !(to > from)) {
    return out;
  }
  // The bell: a half hour begins in the interval if the world's hour
  // crossed one.
  if (x.bell !== null) {
    const hourFrom = x.hour - (to - from) / secondsPerHour;
    if (halfHour(hourFrom) !== halfHour(x.hour)) {
      const d = Math.hypot(x.bell.east - x.listener.east, x.bell.north - x.listener.north);
      const level = r.bell.level * pointLevel(d, r.bell.near, r.bell.reach);
      if (level > 0) {
        for (const t of strokeTimes(bellStrokes(x.hour), r.bell)) {
          out.push({
            kind: 'bell',
            at: to + t,
            level,
            pan: panOf(x.listener, x.bell, x.look),
            seed: halfHour(x.hour),
          });
        }
      }
    }
  }
  if (!x.day) {
    return out;
  }
  // The gulls: in each slot of a few seconds, a call or none, from one of
  // the gulls wheeling over the nearest town, where it is then.
  const town = nearestGulls(x, r.gulls.reach);
  const count = town === null ? 0 : gullCount(town, catalog.life.towns);
  const slot = 60 / Math.max(r.gulls.perMinute, 0.01) / 2;
  for (let n = Math.ceil(from / slot); n * slot < to && town !== null && count > 0; n++) {
    if (draw(n, 1) < 0.5) {
      const k = Math.min(Math.floor(draw(n, 2) * count), count - 1);
      gullAt(town, catalog.life.towns, k, n * slot, gull);
      const dist = Math.hypot(gull.east - x.listener.east, gull.north - x.listener.north);
      const level = r.gulls.level * pointLevel(dist, r.gulls.near, r.gulls.reach);
      out.push({
        kind: 'gull',
        at: n * slot,
        level,
        pan: panOf(x.listener, gull, x.look),
        seed: n,
      });
    }
  }
  // The mallets: runs of blows a beat apart, rests between, at the slip.
  if (x.yard !== null) {
    const d = Math.hypot(x.yard.east - x.listener.east, x.yard.north - x.listener.north);
    const level = r.mallets.level * pointLevel(d, r.mallets.near, r.mallets.reach);
    const beat = r.mallets.beat;
    for (let n = Math.ceil(from / beat); n * beat < to && level > 0; n++) {
      // Which run a blow is in: runs of 3 to 8, rests of 2 to 6, drawn in
      // cycles of twelve beats.
      const cycle = Math.floor(n / 12);
      const [lo, hi] = [r.mallets.run[0] ?? 3, r.mallets.run[1] ?? 8];
      const run = Math.round(lo + draw(cycle, 4) * (hi - lo));
      if (n % 12 < run) {
        out.push({
          kind: 'mallet',
          at: n * beat,
          level,
          pan: panOf(x.listener, x.yard, x.look),
          seed: n,
        });
      }
    }
  }
  return out;
}

/** The water's lapping now: its level and pan, swelling and falling at the waves' period. */
export function lappingNow(
  r: HarbourRecipes['lapping'],
  x: HarbourInput,
): { level: number; pan: number } {
  if (!heard(x) || x.quay === null) {
    return { level: 0, pan: 0 };
  }
  const d = Math.hypot(x.quay.east - x.listener.east, x.quay.north - x.listener.north);
  const sea = Math.min(Math.max(x.seaHeight / r.level.seaHeight, 0), 1);
  const base = r.level.calm + (r.level.most - r.level.calm) * sea;
  const period = Math.min(Math.max(x.period, r.period[0] ?? 2.5), r.period[1] ?? 6);
  const swell = 0.5 + 0.5 * Math.sin((2 * Math.PI * x.seconds) / period);
  return {
    level: base * swell * pointLevel(d, r.near, r.reach),
    pan: panOf(x.listener, x.quay, x.look),
  };
}
