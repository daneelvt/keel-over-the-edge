// SPDX-License-Identifier: AGPL-3.0-only

// A place's weather is measured on the water about it, as a boat there
// would meet it: at its centre and eight points a quarter of a nautical
// mile beyond an island's bounds, or about a port or a light, the mean
// wind, its typical strongest gust, the rain, the visibility and what is
// near each; the pressure at its centre; and the regime's risk there, its
// fog patches only where the fog's own rule lets a bank be born. The
// server's twin is internal/weather/place.go: the same points, the same
// fields from the same module, so the box, the board and the world page
// give one place the same words.

import type { Physics } from '../predict/physics';
import type { PlaceSample, PlaceWeather } from './words';
import { NEAR, SKIES } from './words';

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

/** A regime's risk: its sky's words, and whether it makes fog patches. */
export interface Risk {
  sky: string;
  fog: boolean;
}

/** When a fog bank may be born: in a mean wind under calm, m/s, by night or within dawn ticks of sunrise. */
export interface FogRule {
  calm: number;
  dawn: number;
}

/** The catalog's risks, by the regimes' indices, and the fog's rule, its night-born kind's. */
export function risksOf(weather: {
  regimes: readonly { id: string }[];
  systems: readonly { night: boolean; calmBelow: number; dawn: number }[];
  forecast: { risks: readonly { regime: string; sky: string; marks: readonly string[] }[] };
}): { risks: Risk[]; fog: FogRule } {
  const risks: Risk[] = weather.regimes.map(() => ({ sky: '', fog: false }));
  for (const r of weather.forecast.risks) {
    const i = weather.regimes.findIndex((g) => g.id === r.regime);
    const to = risks[i];
    if (to !== undefined) {
      to.sky = r.sky;
      to.fog = r.marks.includes('fog-patches');
    }
  }
  let fog: FogRule = { calm: 0, dawn: 0 };
  for (const k of weather.systems) {
    if (k.night) {
      fog = { calm: (k.calmBelow * 1852) / 3600, dawn: Math.round(k.dawn * 60 * 30) };
    }
  }
  return { risks, fog };
}

/**
 * The sky a regime's risk gives at a place: its words, but "fair" for fog
 * patches the fog's rule does not allow. mean is the mean wind there, m/s;
 * sun the sun's height there now and the fog's dawn before, rad.
 */
export function riskAt(
  r: Risk,
  fog: FogRule,
  mean: number,
  sun: readonly [number, number],
): string {
  if (r.fog && !(mean < fog.calm && (sun[0] < 0 || sun[1] < 0))) {
    return SKIES[0];
  }
  return r.sky;
}

/**
 * A place's weather from a module set to the time (windDrawAt): its
 * points', the pressure at its centre then, 5 and 15 minutes before, and
 * the risk of the regime in effect; sun is the sun's height at its centre
 * now and the fog's dawn before.
 */
export function placeAt(
  physics: Physics,
  points: readonly [number, number][],
  pressures: readonly [number, number, number],
  risks: readonly Risk[],
  fog: FogRule,
  sun: readonly [number, number],
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
  const regime = physics.regimeAt();
  const r = risks[regime];
  const [cx, cy] = points[0] ?? [0, 0];
  return {
    points: samples,
    pressure: pressures[0],
    before: pressures[1],
    quarter: pressures[2],
    risk: r === undefined ? '' : riskAt(r, fog, samples[0]?.mean ?? 0, sun),
    cyclonic: (physics.nearAt(cx, cy) & NEAR.storm) !== 0,
  };
}
