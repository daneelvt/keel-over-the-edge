// SPDX-License-Identifier: AGPL-3.0-only

// The features' voices, as numbers and events: what the sound engine plays
// near them. A waterfall roars, louder the higher it falls; a blowhole
// booms with each spout, louder the higher the sea, at the moment the page
// draws the spout; a colony's birds call by day, gannets harshly, boobies in
// whistles, frigatebirds in a rattle. Each is placed where it is: panned by
// its bearing from where the camera looks, and fainter with distance, a
// point source's 6 dB each time the distance doubles, heard within the
// catalog's reach. When a boom or a call comes is drawn from world time and
// the feature's own numbers, so every phone hears the islands alike.

import blowhole from '../../../art/sound/blowhole.json';
import colony from '../../../art/sound/colony.json';
import waterfall from '../../../art/sound/waterfall.json';
import { type At, panOf, pointLevel } from './harbour';

export interface FeatureRecipes {
  waterfall: typeof waterfall;
  blowhole: typeof blowhole;
  colony: typeof colony;
}

export const FEATURE_RECIPES: FeatureRecipes = { waterfall, blowhole, colony };

/** A colony's call, as its birds' catalog entry names it. */
export type Call = 'harsh' | 'whistle' | 'rattle';

/** What the features sound like from here, now. */
export interface FeaturesInput {
  /** World time, s; whether the sun is up at the listener. */
  seconds: number;
  day: boolean;
  /** The listener, and the bearing the camera looks along, radians. */
  listener: At;
  look: number;
  /** The sea's significant height, m, and its waves' period, s. */
  seaHeight: number;
  period: number;
  /** The falls near, each with how far it drops, m. */
  falls: (At & { drop: number })[];
  /** The blowholes near, each with its own numbers. */
  blowholes: (At & { seed: number })[];
  /** The colonies near, each with its call and its own number. */
  colonies: (At & { call: Call; seed: number })[];
}

/** A sound to play once. */
export interface FeatureEvent {
  kind: 'boom' | Call;
  at: number;
  level: number;
  pan: number;
  seed: number;
}

/** Where in its cycle a blowhole's spout begins, a share of the waves' period: from its own numbers, as the page draws it. */
export function spoutOffset(seed: number, east: number): number {
  const v = Math.sin(seed * 12.9898 + 78.233 + east * 0.01) * 43758.5453;
  return v - Math.floor(v);
}

/** The loudest fall's roar now: its level and pan. */
export function roarNow(
  r: FeatureRecipes['waterfall'],
  x: FeaturesInput,
): { level: number; pan: number } {
  let best = { level: 0, pan: 0 };
  for (const f of x.falls) {
    const d = Math.hypot(f.east - x.listener.east, f.north - x.listener.north);
    const level = r.level * Math.min(f.drop / r.height, 1) * pointLevel(d, r.near, r.reach);
    if (level > best.level) {
      best = { level, pan: panOf(x.listener, f, x.look) };
    }
  }
  return best;
}

/** A number in [0, 1) of slot n of a voice: the same on every phone. */
function draw(n: number, voice: number): number {
  const v = Math.sin(n * 12.9898 + voice * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * The events due between world seconds from and to: each blowhole's boom
 * when its spout begins, and by day the colonies' calls, a few a minute
 * from each.
 */
export function featureEvents(
  r: FeatureRecipes,
  x: FeaturesInput,
  from: number,
  to: number,
): FeatureEvent[] {
  const out: FeatureEvent[] = [];
  if (!(to > from)) {
    return out;
  }
  const sea = Math.min(Math.max(x.seaHeight / r.blowhole.seaHeight, 0.15), 1);
  for (const b of x.blowholes) {
    const d = Math.hypot(b.east - x.listener.east, b.north - x.listener.north);
    const level = r.blowhole.level * sea * pointLevel(d, r.blowhole.near, r.blowhole.reach);
    if (!(level > 0)) {
      continue;
    }
    const off = spoutOffset(b.seed, b.east);
    // The spout begins where the cycle's phase passes nought.
    for (let k = Math.ceil(from / x.period + off); (k - off) * x.period < to; k++) {
      out.push({
        kind: 'boom',
        at: (k - off) * x.period,
        level,
        pan: panOf(x.listener, b, x.look),
        seed: k,
      });
    }
  }
  if (!x.day) {
    return out;
  }
  const slot = 60 / Math.max(r.colony.perMinute, 0.01);
  for (const c of x.colonies) {
    const d = Math.hypot(c.east - x.listener.east, c.north - x.listener.north);
    const level = r.colony.level * pointLevel(d, r.colony.near, r.colony.reach);
    if (!(level > 0)) {
      continue;
    }
    for (let n = Math.ceil(from / slot); n * slot < to; n++) {
      if (draw(n, c.seed + 11) < 0.7) {
        out.push({
          kind: c.call,
          at: n * slot + draw(n, c.seed + 12) * slot * 0.5,
          level,
          pan: panOf(x.listener, c, x.look),
          seed: n,
        });
      }
    }
  }
  return out;
}
