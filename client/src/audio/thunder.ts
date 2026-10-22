// SPDX-License-Identifier: AGPL-3.0-only

// Thunder, as numbers and events: what the sound engine plays after each
// flash. Every flash thunders, whether it strikes the sea or stays in its
// cloud, and is heard within the catalog's reach of it. The sound sets out
// from the whole of the channel at once, so it first arrives from the
// channel's nearest point, the distance over the speed of sound after the
// flash (the NWS's five seconds a mile), and goes on arriving from farther
// stretches until its farthest: thunder rolls as long as the channel's
// spread in distance takes the sound to cross, at most the catalog's
// longest (Glassner 2000). Near, it begins with a crack; far, it is a
// rumble only ("a sharp crack or click" near, "a rumble" far, the NWS).
//
// A channel to the sea stands from its cloud's base at the strike to the
// sea; one in the cloud lies along the cloud's base about its place, its
// way drawn from the flash's seed. Each is placed by the bearing of its
// nearest point from where the camera looks, fainter with distance, a
// point source's 6 dB each time the distance doubles, and duller, the air
// absorbing its highs (audio/air.ts).

import thunder from '../../../art/sound/thunder.json';
import { catalog } from '../catalog';
import type { WeatherThunder } from '../catalog/types.gen';
import { STEPS_PER_SECOND } from '../game/clock';
import { airCutoff } from './air';
import { type At, panOf, pointLevel } from './harbour';

export type ThunderRecipe = typeof thunder;

export const THUNDER_RECIPE: ThunderRecipe = thunder;

/** The catalog's thunder: heard within, NM; the speed of sound, m/s; the longest roll, s; a crack within, m. */
export type ThunderRule = WeatherThunder;

export const THUNDER_RULE: ThunderRule = catalog.weather.thunder;

/** A flash as the thunder hears it. */
export interface ThunderFlash extends At {
  /** When its first stroke strikes, ticks of world time. */
  tick: number;
  /** Whether it strikes the sea, or stays in its cloud. */
  sea: boolean;
  /** Its cloud's base, m. */
  base: number;
  seed: number;
}

/** What the thunder sounds like from here, now. */
export interface ThunderInput {
  /** World time, s. */
  seconds: number;
  /** The listener, and the bearing the camera looks along, radians. */
  listener: At;
  look: number;
  /** The flashes of the last minute. */
  flashes: Iterable<ThunderFlash>;
}

/** A thunder to play once, as the listener hears it. */
export interface ThunderEvent {
  /** When it is first heard, world s, and how long it rolls, s. */
  at: number;
  length: number;
  /** How far its channel's nearest point is, m, and whether it begins with a crack. */
  distance: number;
  crack: boolean;
  level: number;
  pan: number;
  /** The air's low-pass over its distance, Hz. */
  cutoff: number;
  seed: number;
}

/** A channel: its nearest and farthest points' distances from the listener, m, and where its nearest lies. */
export interface Reach {
  near: number;
  far: number;
  at: At;
}

/** The way a cloud's channel lies, radians from north: drawn from its flash's seed. */
export function stretchWay(seed: number): number {
  const v = Math.sin(seed * 12.9898 + 4.1414) * 43758.5453;
  return (v - Math.floor(v)) * Math.PI;
}

/**
 * How near and far a flash's channel is from a listener on the sea: one
 * to the sea stands from the sea to its cloud's base; one in the cloud is
 * a stretch of length m along its base, centred on its place.
 */
export function channelReach(f: ThunderFlash, listener: At, length: number): Reach {
  const dx = f.east - listener.east;
  const dy = f.north - listener.north;
  const h = Math.hypot(dx, dy);
  if (f.sea) {
    return { near: h, far: Math.hypot(h, f.base), at: { east: f.east, north: f.north } };
  }
  const way = stretchWay(f.seed);
  const ue = Math.sin(way);
  const un = Math.cos(way);
  const half = length / 2;
  // The nearest point of the stretch, seen from above, and its ends.
  const s = Math.min(Math.max(-(dx * ue + dy * un), -half), half);
  const ne = dx + s * ue;
  const nn = dy + s * un;
  const ends = Math.max(
    Math.hypot(dx + half * ue, dy + half * un),
    Math.hypot(dx - half * ue, dy - half * un),
  );
  return {
    near: Math.hypot(Math.hypot(ne, nn), f.base),
    far: Math.hypot(ends, f.base),
    at: { east: listener.east + ne, north: listener.north + nn },
  };
}

/** The thunders first heard between world seconds from and to. */
export function thunderEvents(
  r: ThunderRecipe,
  c: ThunderRule,
  x: ThunderInput,
  from: number,
  to: number,
): ThunderEvent[] {
  const out: ThunderEvent[] = [];
  if (!(to > from)) {
    return out;
  }
  const reach = c.heard * 1852;
  for (const f of x.flashes) {
    const ch = channelReach(f, x.listener, r.stretch);
    if (ch.near > reach) {
      continue;
    }
    const at = f.tick / STEPS_PER_SECOND + ch.near / c.speed;
    if (!(at >= from && at < to)) {
      continue;
    }
    out.push({
      at,
      length: Math.min((ch.far - ch.near) / c.speed, c.longest),
      distance: ch.near,
      crack: ch.near <= c.crack,
      level: r.level * pointLevel(ch.near, r.near, reach),
      pan: panOf(x.listener, ch.at, x.look),
      cutoff: airCutoff(r.absorption, r.cutoff.least, r.cutoff.most, ch.near),
      seed: f.seed,
    });
  }
  return out;
}
