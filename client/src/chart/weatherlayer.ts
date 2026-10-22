// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather brought to the slider's moment: painted afresh when
// the moment, the issue, the layers or what is kept change, and once a
// second while it shows now or the past, which move on; between, the
// canvas is left as it is, so the paper and the weather cost nothing a
// frame.

import { catalog } from '../catalog';
import { issueOf } from '../predict/forecast';
import { risksOf } from './place';
import {
  gridPoints,
  kindDraws,
  type Layers,
  type Moment,
  momentOf,
  type SceneLook,
  sampleScene,
  type TimeMode,
  useMoment,
  type WeatherScene,
  type WeatherSource,
} from './weather';
import { paintWeather, type WeatherLook } from './weatherpaint';

/** The slider and the switches, as the chart holds them. */
export interface WeatherChoice {
  mode: TimeMode;
  step: number;
  layers: Layers;
}

/** The scene's and the painter's looks, from the catalog. */
export function weatherLooks(): { scene: SceneLook; paint: WeatherLook } {
  const w = catalog.weather;
  const look = catalog.world.chart.look;
  const lip = catalog.world.disk.radius;
  const { risks, fog } = risksOf(w);
  const calmKind = w.systems.find((k) => k.shape === 'none' && !k.night);
  return {
    scene: {
      lip,
      n: look.wind,
      kinds: kindDraws(w.systems),
      perHour: w.forecast.cone.perHour * 1852,
      forming: w.forecast.cone.forming * 1852,
      front: w.forecast.cone.front,
      galeGrid: w.forecast.gale.grid * 1852,
      risks,
      fog,
      calm: ((calmKind?.calmBelow ?? 0) * 1852) / 3600,
      marks: w.regimes.map((r) => w.forecast.risks.find((x) => x.regime === r.id)?.marks ?? []),
      contrast: w.visibility.contrast,
    },
    paint: {
      ink: look.ink,
      rain: look.weather.rain,
      fog: look.weather.fog,
      front: look.weather.front,
      squall: look.weather.squall,
      storm: look.weather.storm,
      gusts: (look.weather.gusts * 1852) / 3600,
      lip,
      rainWords: w.clouds.rainWords,
      visibility: w.visibility.words,
    },
  };
}

export class ChartWeather {
  readonly canvas: HTMLCanvasElement;
  /** The scene last painted, or null before the first. */
  scene: WeatherScene | null = null;
  /** How long the last paint took, ms, its sampling and its painting. */
  took = { sample: 0, paint: 0 };
  /** How many times it was painted (the tests). */
  paints = 0;
  readonly #src: WeatherSource;
  readonly #choice: () => WeatherChoice;
  readonly #scene: SceneLook;
  readonly #paint: WeatherLook;
  readonly #points: Float64Array;
  #key = '';
  #at = Number.NEGATIVE_INFINITY;

  constructor(src: WeatherSource, choice: () => WeatherChoice, size: number) {
    this.#src = src;
    this.#choice = choice;
    const looks = weatherLooks();
    this.#scene = looks.scene;
    this.#paint = looks.paint;
    this.#points = gridPoints(this.#scene.n, this.#scene.lip);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
  }

  /** The moment the slider shows now. */
  moment(): Moment {
    const c = this.#choice();
    return momentOf(c.mode, c.step, this.#src);
  }

  /** Brings the weather to the slider's moment; true if it was painted afresh. */
  update(now: number): boolean {
    const fields = this.#src.fields();
    if (fields === null) {
      return false;
    }
    const c = this.#choice();
    const m = momentOf(c.mode, c.step, this.#src);
    const layers = Object.entries(c.layers)
      .map(([k, v]) => (v ? k : ''))
      .join();
    const key = `${m.kind}:${m.step}:${m.issue === null ? 0 : issueOf(m.issue)}:${layers}:${this.#src.forecasts.version}`;
    const moving = m.kind !== 'forecast';
    if (key === this.#key && !(moving && now - this.#at >= 1000)) {
      return false;
    }
    if (!useMoment(fields, m, this.#src)) {
      return false;
    }
    this.#key = key;
    this.#at = now;
    const t0 = performance.now();
    this.scene = sampleScene(fields, m, this.#src, this.#scene, this.#points);
    const t1 = performance.now();
    paintWeather(this.canvas, this.scene, this.#paint, c.layers);
    this.took = { sample: t1 - t0, paint: performance.now() - t1 };
    this.paints++;
    return true;
  }

  /** Paints again at the next update, whatever has changed. */
  invalidate(): void {
    this.#key = '';
  }
}
