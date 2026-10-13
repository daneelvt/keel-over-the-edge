// SPDX-License-Identifier: AGPL-3.0-only

// Foam, as the sea's shader lays it. Five things make it: the detail band
// where it folds; whitecaps on the boat band's crests, broken into patches;
// streaks blown down the wind in a gale; the hulls; and the wakes in the
// foam map. Their sum is an amount, 0 to 1. The amount is not drawn as a
// grey: it sets how much of a pattern of lace shows, so a little foam is a
// few threads and a lot is a sheet. And it is held within its tile: over
// the tile's rim it fades to a fifth, so a patch of foam reads as a cluster
// of white tiles.

import { Vector2 } from 'three';
import { clamp, dot, float, max, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { look } from '../render/sky';
import { FOAM } from './look';
import { FINE_CELLS } from './pattern';

/** The floating origin's place in the pattern: the pattern is laid over the world, not the scene. */
export const patternOrigin = uniform(new Vector2());
/** The direction the streaks run in, east and north, and the floating origin's place along and across them. */
export const streakToward = uniform(new Vector2(0, -1));
export const streakOrigin = uniform(new Vector2());
/** 1 while any sea area in view has streaks: the shader looks for them only then. */
export const streaksOn = uniform(0);
/** 1 to draw foam; 0 for none (the developer panel, the tests). */
export const foamOn = uniform(1);

/** How far the pattern's coordinates advance a metre down the streaks, and a metre across them. */
export const STREAK_ALONG = 0.9 / FOAM.streakStretch / FINE_CELLS;
export const STREAK_ACROSS = 0.9 / FINE_CELLS;

/**
 * Where a point reads the pattern, which repeats every FOAM.patternSpan
 * metres: p is its offset from the floating origin in the scene (x, z), and
 * anchored is 1 to lay the pattern over the world, 0 to read it at p alone.
 */
export function patternAt(p: Node<'vec2'>, anchored: Node<'float'> | number = 1): Node<'vec2'> {
  return patternOrigin.mul(anchored).add(p.mul(1 / FOAM.patternSpan)) as unknown as Node<'vec2'>;
}

/**
 * Where a point reads the pattern's fine noise for the streaks: the noise
 * stretched down the wind, FOAM.streakStretch times longer than across, a
 * cell of it 1.1 m across.
 */
export function streakAt(p: Node<'vec2'>): Node<'vec2'> {
  const toward = streakToward as unknown as Node<'vec2'>;
  const across = vec2(toward.y.negate(), toward.x);
  // East and north of the origin.
  const q = vec2(p.x, p.y.negate());
  return streakOrigin.add(
    vec2(dot(q, toward).mul(STREAK_ALONG), dot(q, across).mul(STREAK_ACROSS)),
  ) as unknown as Node<'vec2'>;
}

export interface FoamParts {
  /** The sea area's foam here: whitecaps, streaks, folding. */
  area: Node<'vec3'>;
  /** The boat band's height in half significant heights, and the detail band's in three of its standard deviations. */
  crest: Node<'float'>;
  detail: Node<'float'>;
  /** How far the crest lightens the water, 0 to 1: streaks show most on crests. */
  lightened: Node<'float'>;
  /** The detail band's folding foam here. */
  folding: Node<'float'>;
  /** The pattern here: lace, fine noise, coarse noise. */
  pattern: Node<'vec4'>;
  /** The fine noise read along the wind (streakAt), or null without streaks. */
  streak: Node<'float'> | null;
  /** Foam from the hulls and the wakes. */
  boats: Node<'float'>;
}

/** The whitecaps: where the crest stands high for its sea, in patches. */
export function whitecaps(f: FoamParts): Node<'float'> {
  const [from, to] = FOAM.crest;
  return f.area.x
    .mul(smoothstep(from, to, f.crest.add(f.detail.mul(FOAM.crestDetail))))
    .mul(f.pattern.z.mul(0.6).add(0.55)) as unknown as Node<'float'>;
}

/** The streaks: long threads of the noise, stronger on the crests. */
export function streaks(f: FoamParts): Node<'float'> {
  if (f.streak === null) {
    return float(0) as unknown as Node<'float'>;
  }
  return f.area.y
    .mul(smoothstep(0.6, 0.82, f.streak))
    .mul(f.lightened.mul(0.7).add(0.3)) as unknown as Node<'float'>;
}

/** The foam's amount, 0 to 1. */
export function foamAmount(f: FoamParts): Node<'float'> {
  const sea = smoothstep(0.12, 1, f.folding.mul(f.area.z).add(whitecaps(f)).add(streaks(f)));
  return clamp(sea.add(f.boats), 0, 1).mul(foamOn) as unknown as Node<'float'>;
}

/** How much of the water an amount of foam covers here, by the pattern. */
export function foamCover(amount: Node<'float'>, pattern: Node<'vec4'>): Node<'float'> {
  const lace = pattern.x.mul(0.55).add(pattern.y.mul(0.45));
  const shows = float(1).sub(amount);
  return smoothstep(shows, shows.add(0.14), lace).mul(
    smoothstep(0.05, 0.25, amount),
  ) as unknown as Node<'float'>;
}

/** How much of its cover foam keeps at a tile's rim; fade is 0 in the tile's middle and 1 at its edge. */
export function foamMargin(fade: Node<'float'>): Node<'float'> {
  const [from, to, loss] = FOAM.margin;
  return float(1).sub(smoothstep(from, to, fade).mul(loss)) as unknown as Node<'float'>;
}

/** The clouds' colour by day: the foam is as white as they are, and as dark by night. */
const DAY_CLOUD = [0.97, 0.96, 0.93] as const;

/**
 * The foam's colour under the main light on a surface with normal N
 * (display values): the foam's own white, lit as the clouds are at the
 * hour, so it dims with them at dusk and is grey under the moon.
 */
export function foamColour(normal: Node<'vec3'>): Node<'vec3'> {
  const [r, g, b] = FOAM.colour;
  const tint = vec3(r / DAY_CLOUD[0], g / DAY_CLOUD[1], b / DAY_CLOUD[2]);
  return (look.cloud as unknown as Node<'vec3'>)
    .mul(tint)
    .mul(max(dot(normal, look.light), 0).mul(0.32).add(0.72))
    .add(look.lightColour.mul(0.04)) as unknown as Node<'vec3'>;
}
