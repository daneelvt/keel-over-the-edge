// SPDX-License-Identifier: AGPL-3.0-only

// The sea's life's voices, as numbers and events: what the sound engine
// plays of the groups about the boat. By day each group of a kind that
// calls calls a few times a minute: a laughing gull's laugh, "a raucous,
// laughing ha-ha-ha" (the Cornell Lab's All About Birds), sooty terns'
// nasal "ker-wacki-wah" or "wide-awake", a brown booby's thin whistle.
// Each call comes from a group that is there, from its middle where the
// group is as it calls (flockAt, the server's twin), panned by its bearing
// from where the camera looks and fainter with distance, a point source's
// 6 dB each time the distance doubles. When a group calls is drawn from
// world time and the group's own number, at most once in a slot of its
// rate, so every phone, and the server (internal/lookout), hears the same
// calls from the same places.

import seabirds from '../../../art/sound/seabirds.json';
import type { LifeKind } from '../catalog/types.gen';
import { type FlockPlace, flockAt, own, type Pose } from '../life/flock';
import type { LifeSeen } from '../net/messages';
import { type At, panOf, pointLevel } from './harbour';

export type LifeRecipes = typeof seabirds;

export const LIFE_RECIPES: LifeRecipes = seabirds;

/** A call of the sea's life that the recipes voice. */
export type LifeCall = 'laugh' | 'tern' | 'whistle';

/** Whether a bird's call is one of the sea's life's recipes. */
export function isLifeCall(c: string): c is LifeCall {
  return c === 'laugh' || c === 'tern' || c === 'whistle';
}

/** A group of the sea's life near: its record, its kind, and the pose of the boat it is with (null for none). */
export interface LifeGroup {
  record: LifeSeen;
  kind: LifeKind;
  pose: Pose | null;
}

/** What the sea's life sounds like from here, now. */
export interface LifeInput {
  /** World time, s; whether the sun is up at the listener. */
  seconds: number;
  day: boolean;
  /** The listener, and the bearing the camera looks along, radians. */
  listener: At;
  look: number;
  groups: LifeGroup[];
}

/** A call to play once: which, when (world seconds), how loud, panned how, and its own number. */
export interface LifeEvent {
  kind: LifeCall;
  at: number;
  level: number;
  pan: number;
  seed: number;
}

/** Ticks a second of world time. */
const STEPS = 30;

/** Which of a group's own numbers its calls' slots are drawn by. */
const VOICE = 21;

/** A number in [0, 1) of slot n of a voice: the same on every phone. */
function draw(n: number, voice: number): number {
  const v = Math.sin(n * 12.9898 + voice * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

const middle: FlockPlace = { east: 0, north: 0, up: 0 };

/**
 * The calls due between world seconds from and to, by day: each group's,
 * of a kind that calls, at most one in each slot of its rate, heard from
 * where its middle is then.
 */
export function lifeEvents(r: LifeRecipes, x: LifeInput, from: number, to: number): LifeEvent[] {
  const out: LifeEvent[] = [];
  if (!(to > from) || !x.day) {
    return out;
  }
  for (const g of x.groups) {
    const call = g.kind.look?.call;
    if (call === undefined || !isLifeCall(call)) {
      continue;
    }
    const per = r[call].perMinute;
    if (!(per > 0)) {
      continue;
    }
    const slot = 60 / per;
    const voice = 300 + own(g.record.seed, VOICE) * 100;
    for (let n = Math.ceil(from / slot); n * slot < to; n++) {
      if (!(draw(n, voice) < 0.7)) {
        continue;
      }
      const at = n * slot + draw(n, voice + 1) * slot * 0.5;
      if (!flockAt(g.record, g.kind, at * STEPS, g.pose, middle)) {
        continue;
      }
      const d = Math.hypot(middle.east - x.listener.east, middle.north - x.listener.north);
      out.push({
        kind: call,
        at,
        level: r.level * pointLevel(d, r.near, r.reach),
        pan: panOf(x.listener, middle, x.look),
        seed: n,
      });
    }
  }
  return out;
}
