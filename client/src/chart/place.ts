// SPDX-License-Identifier: AGPL-3.0-only

// A place's weather is measured on the water about it, as a boat there
// would meet it: at its centre and eight points a quarter of a nautical
// mile beyond an island's bounds, or about a port or a light, the mean
// wind, its typical strongest gust, the rain, the visibility and what is
// near each; and the pressure at its centre. The server's twin is
// internal/weather/place.go: the same points, the same fields from the
// same module, so the box, the board and the world page give one place
// the same words.

import type { Physics } from '../predict/physics';
import type { PlaceSample, PlaceWeather } from './words';
import { NEAR } from './words';

/** How far beyond a place's bounds, or about it, its weather is measured, m. */
const REACH = 0.25 * 1852;

/**
 * The points a place's weather is measured at: its centre, then the
 * corners and the middles of the sides of its bounds (west, south, east,
 * north, m) grown by a quarter of a mile, from the north clockwise; with
 * no bounds, eight points a quarter of a mile about it.
 */
export function placePoints(
  east: number,
  north: number,
  bounds: readonly number[] | null,
): [number, number][] {
  const out: [number, number][] = [[east, north]];
  if (bounds === null || bounds.length < 4) {
    for (let i = 0; i < 8; i++) {
      const a = i * (Math.PI / 4);
      out.push([east + REACH * Math.sin(a), north + REACH * Math.cos(a)]);
    }
    return out;
  }
  const w = (bounds[0] ?? 0) - REACH;
  const s = (bounds[1] ?? 0) - REACH;
  const e = (bounds[2] ?? 0) + REACH;
  const n = (bounds[3] ?? 0) + REACH;
  const mx = 0.5 * (w + e);
  const my = 0.5 * (s + n);
  out.push([mx, n], [e, n], [e, my], [e, s], [mx, s], [w, s], [w, my], [w, n]);
  return out;
}

/**
 * A place's weather from a module set to the time (windDrawAt): its
 * points', and the pressure at its centre then, 5 and 15 minutes before.
 */
export function placeAt(
  physics: Physics,
  points: readonly [number, number][],
  pressures: readonly [number, number, number],
): PlaceWeather {
  const flat = points.flat();
  const typical = physics.typicalSample(flat, new Float64Array(3 * points.length));
  const rain = physics.rainSample(flat, new Float64Array(points.length));
  const samples: PlaceSample[] = points.map(([x, y], i) => ({
    mean: typical[3 * i] ?? 0,
    from: typical[3 * i + 1] ?? 0,
    gust: typical[3 * i + 2] ?? 0,
    rain: rain[i] ?? 0,
    visibility: physics.visibilityAt(x, y),
    near: physics.nearAt(x, y),
  }));
  const [cx, cy] = points[0] ?? [0, 0];
  return {
    points: samples,
    pressure: pressures[0],
    before: pressures[1],
    quarter: pressures[2],
    cyclonic: (physics.nearAt(cx, cy) & NEAR.storm) !== 0,
  };
}
