// SPDX-License-Identifier: AGPL-3.0-only

// The pocket chart's weather: the rain, the fog and the systems over the
// disk now, simplified for a picture a few centimetres across, from the
// forecast's own module set to the present. No wind and no forecast: the
// chart has those.

import type { Forecasting } from './forecasting';
import { frontsAt, gridPoints, type SceneFront, type SceneSystem, systemsOfKeys } from './weather';
import { weatherLooks } from './weatherlayer';

/** The weather the pocket chart draws: a coarse grid of rain and fog, the systems and the fronts. */
export interface PocketWeather {
  n: number;
  lip: number;
  rain: Float64Array;
  /** The fog banks' visibility, m. */
  fog: Float64Array;
  systems: SceneSystem[];
  fronts: SceneFront[];
}

/** The grid's points a side. */
const N = 24;

let points: Float64Array | null = null;

/** The pocket chart's weather now, or null while the forecast's module is made. */
export function pocketWeather(src: Forecasting): PocketWeather | null {
  const fields = src.fields();
  if (fields === null) {
    return null;
  }
  const look = weatherLooks().scene;
  const tick = src.tick();
  const present = src.present();
  fields.truthAt(present.keys, present.spells, tick);
  points ??= gridPoints(N, look.lip);
  const p = fields.physics;
  const rain = p.rainSample(points, new Float64Array(N * N));
  const fog = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const air = p.airAt(points[2 * k] ?? 0, points[2 * k + 1] ?? 0, 2);
    fog[k] = look.contrast / Math.max((air[0] ?? 0) + (air[1] ?? 0), 1e-9);
  }
  return {
    n: N,
    lip: look.lip,
    rain,
    fog,
    systems: systemsOfKeys(present.keys, tick, look.kinds),
    fronts: frontsAt(present.spells, tick, p.frontReach(), null),
  };
}
