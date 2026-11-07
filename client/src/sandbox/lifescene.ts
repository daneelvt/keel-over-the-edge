// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's encounters with the sea's life, by hand: ?life=<kind id>
// puts one group of that kind by the boat as the page loads, so a picture
// of it can be taken however still the boat lies. A free group's middle
// comes to a point 200 m ahead of the boat 40 s after the load: one that
// passes crosses there, square to the boat's heading; one that soars or
// works has come in by then and stays over it for the most its kind
// stays. A kind that follows boats is with the own boat (with: 1), in
// astern of it by 40 s and staying its kind's most. The tests raise one
// again at now with keel.raiseLife, its middle there at once.

import type { Life } from '../catalog/types.gen';
import { arrive, hash32, lingers } from '../life/flock';
import type { LifeSeen } from '../net/messages';

/** Ticks a second of world time. */
const STEPS = 30;
/** How far ahead of the boat a free group's middle comes, m, and how long after the load, s. */
export const AHEAD = 200;
export const DELAY = 40;

/** The kind ?life names, by its index in the catalog's life; −1 for none. */
export function lifeKindFromQuery(query: URLSearchParams, life: Life): number {
  const id = query.get('life');
  return id === null ? -1 : life.kinds.findIndex((k) => k.id === id);
}

/** The boat a scene's group is placed by: m east and north, and its heading, radians clockwise from north. */
export interface SceneBoat {
  east: number;
  north: number;
  heading: number;
}

/**
 * A group of kind by the boat at tick now, its middle at the point east
 * and north of the boat (200 m ahead by default) delay s after now; the
 * n-th raised, which makes its id and seed its own.
 */
export function lifeScene(
  life: Life,
  kind: number,
  now: number,
  boat: SceneBoat,
  n: number,
  delay = DELAY,
  offset?: { east: number; north: number },
): LifeSeen | null {
  const k = life.kinds[kind];
  if (k === undefined) {
    return null;
  }
  const speed = ((k.speed[0] ?? 10) + (k.speed[1] ?? 10)) / 2;
  const a = arrive(k, speed);
  const stay = k.stay[1] ?? 0;
  const lo = k.group[0] ?? 1;
  const hi = k.group[1] ?? lo;
  const at = now + delay * STEPS;
  const follows = k.binds === 'follow';
  const east = boat.east + (offset?.east ?? Math.sin(boat.heading) * AHEAD);
  const north = boat.north + (offset?.north ?? Math.cos(boat.heading) * AHEAD);
  // Each is at its point a, its coming in, after it begins: one that
  // passes crosses square to the boat's heading and goes on as far; one
  // that follows comes up from astern along it, and one that stays comes
  // in so, and each stays its kind's most before going on.
  const stays = follows || lingers(k);
  const start = Math.floor(at - a * STEPS);
  const span = stays ? 2 * a + stay : 2 * a;
  return {
    id: `sandbox-${n}`,
    rev: 0,
    kind,
    start,
    end: start + Math.ceil(span * STEPS),
    east,
    north,
    heading: stays ? boat.heading : boat.heading + Math.PI / 2,
    speed,
    count: Math.max(lo, Math.ceil((lo + hi) / 2)),
    seed: hash32((kind + 1) * 7919 + n),
    with: follows ? 1 : 0,
    over: '',
  };
}
