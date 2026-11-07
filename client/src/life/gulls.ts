// SPDX-License-Identifier: AGPL-3.0-only

// The harbour's gulls: a few laughing gulls wheel over each town by day, as
// a colony's birds wheel over it, so that the gulls heard in a harbour are
// seen there. Each town's wheel is over its square, its harbourmaster's
// house, or over its quay where it has no square: the one of its
// buildings standing there of the lowest own number, then east, then
// north; their number, paths and calls are drawn from the town's number
// and that building's. Every phone, and the server's twin
// (internal/lookout), finds the same gulls in the same places.

import type { BuildingKind, LifeTowns } from '../catalog/types.gen';
import { hash32, lerp, own } from './flock';

/** A building as the gulls' wheel is found from it. */
export interface GullBuilding {
  kind: number;
  east: number;
  north: number;
  seed: number;
  town: number;
}

/** A town's gulls: their wheel's centre, m east and north, its ground's height, m, and their own number. */
export interface GullTown {
  town: number;
  east: number;
  north: number;
  level: number;
  seed: number;
}

/** Where a gull is: m east, north and up, and its heading, radians clockwise from north. */
export interface GullPlace {
  east: number;
  north: number;
  up: number;
  heading: number;
}

/** Which stands a town's wheel is over, the first found of them. */
const OVER: readonly BuildingKind['stands'][] = ['square', 'quay', 'edge'];

/**
 * Each town's gulls, from the buildings held: over its square, else its
 * quay, else its bollards' edge; towns with none of them have none.
 */
export function gullTowns(
  buildings: Iterable<GullBuilding & { level?: number }>,
  kinds: readonly BuildingKind[],
): GullTown[] {
  const best = new Map<number, { rank: number; b: GullBuilding & { level?: number } }>();
  for (const b of buildings) {
    const kind = kinds[b.kind];
    if (kind === undefined || b.town < 0) {
      continue;
    }
    const rank = OVER.indexOf(kind.stands);
    if (rank < 0 || (kind.stands === 'square' && kind.prop === true)) {
      continue;
    }
    const held = best.get(b.town);
    if (
      held === undefined ||
      rank < held.rank ||
      (rank === held.rank &&
        (b.seed < held.b.seed ||
          (b.seed === held.b.seed &&
            (b.east < held.b.east || (b.east === held.b.east && b.north < held.b.north)))))
    ) {
      best.set(b.town, { rank, b });
    }
  }
  const out: GullTown[] = [];
  for (const [town, { b }] of best) {
    out.push({
      town,
      east: b.east,
      north: b.north,
      level: b.level ?? 0,
      seed: hash32((town ^ hash32(b.seed + 1)) >>> 0),
    });
  }
  out.sort((a, b) => a.town - b.town);
  return out;
}

/** How many gulls wheel over a town. */
export function gullCount(t: GullTown, r: LifeTowns): number {
  const lo = r.count[0] ?? 0;
  const hi = r.count[1] ?? lo;
  return lo + (hash32((t.seed ^ hash32(1)) >>> 0) % (Math.max(hi - lo, 0) + 1));
}

/** Sets out to where a town's gull k is at world time t, s. */
export function gullAt(t: GullTown, r: LifeTowns, k: number, time: number, out: GullPlace): void {
  const s = hash32((t.seed ^ hash32(100 + k)) >>> 0);
  const speed = 7 + 4 * own(s, 1);
  const radius = lerp(r.wheel[0] ?? 25, r.wheel[1] ?? 70, own(s, 2));
  const dir = own(s, 3) < 0.5 ? 1 : -1;
  const a = own(s, 4) * 2 * Math.PI + dir * (speed / radius) * time;
  const reach = radius * (0.8 + 0.2 * Math.sin(a * 0.6 + own(s, 5) * 6));
  out.east = t.east + reach * Math.sin(a);
  out.north = t.north + reach * Math.cos(a);
  out.up =
    t.level +
    lerp(r.height[0] ?? 8, r.height[1] ?? 28, own(s, 6)) +
    3 * Math.sin(a * 1.1 + own(s, 7) * 6);
  out.heading = a + (dir * Math.PI) / 2;
}
