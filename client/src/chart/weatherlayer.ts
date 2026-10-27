// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather brought to the slider's moment: painted afresh when
// the moment, the issue, the layers or what is kept change, and once a
// second while it shows now, which is live; between, the canvas is left as
// it is, so the paper and the weather cost nothing a frame. A moment moved
// on before the last paint is done waiting is painted no sooner than the
// last paint took, so Play goes no faster than the painter keeps up.

import { catalog } from '../catalog';
import { issueOf } from '../predict/forecast';
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

/** The slider and the switches, as the chart holds them: its way, its minutes from now, the layers. */
export interface WeatherChoice {
  mode: TimeMode;
  minutes: number;
  layers: Layers;
}

/** The scene's and the painter's looks, from the catalog. */
export function weatherLooks(): { scene: SceneLook; paint: WeatherLook } {
  const w = catalog.weather;
  const look = catalog.world.chart.look;
  const lip = catalog.world.disk.radius;
  return {
    scene: {
      lip,
      n: look.wind,
      kinds: kindDraws(w.systems),
      galeGrid: w.forecast.gale.grid * 1852,
      contrast: w.visibility.contrast,
    },
    paint: {
      ink: look.ink,
      rain: look.weather.rain,
      fog: look.weather.fog,
      cold: look.weather.cold,
      warm: look.weather.warm,
      squall: look.weather.squall,
      storm: look.weather.storm,
      paper: look.paper,
      wash: look.weather.wash,
      barbs: look.weather.barbs * 1852,
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
    return momentOf(c.mode, c.minutes, this.#src);
  }

  /** Brings the weather to the slider's moment; true if it was painted afresh. */
  update(now: number): boolean {
    const fields = this.#src.fields();
    if (fields === null) {
      return false;
    }
    const c = this.#choice();
    const m = momentOf(c.mode, c.minutes, this.#src);
    const layers = Object.entries(c.layers)
      .map(([k, v]) => (v ? k : ''))
      .join();
    const key = `${m.kind}:${m.kind === 'now' ? 0 : m.tick}:${m.issue === null ? 0 : issueOf(m.issue)}:${layers}:${this.#src.forecasts.version}`;
    if (key === this.#key && !(m.kind === 'now' && now - this.#at >= 1000)) {
      return false;
    }
    // A moment moved on by the slider waits as long as the last paint took.
    const last = this.took.sample + this.took.paint;
    if (this.#key !== '' && key !== this.#key && now - this.#at < last) {
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
