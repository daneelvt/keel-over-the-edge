// SPDX-License-Identifier: AGPL-3.0-only

// The forecast as the page uses it: the issues and the truth kept
// (predict/forecast.ts), the forecast's own module, made the first time
// something asks for a field, and what the chart, a place's box, the board
// and the barometer need besides: the world's tick, the present's spells
// and keyframes, the sun at a place and the world's end. Online the server
// sends the issues; offline the sandbox makes its own (sandbox/forecast.ts).

import { catalog } from '../catalog';
import type { BoatPhysics } from '../catalog/types.gen';
import { Fields, Forecasts } from '../predict/forecast';
import type { Keyframe, Physics } from '../predict/physics';
import { BODY, SKY } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import type { WeatherSource } from './weather';

/** What forecasting reads of the game: the first module, the boat's physics, the clock and the present. */
export interface ForecastingParts {
  physics: Physics;
  boat: BoatPhysics;
  /** The world's tick now, fractional. */
  tick: () => number;
  /** The spells in play and the keyframes held now. */
  present: () => { keys: readonly Keyframe[]; spells: readonly ArrayLike<number>[] };
  /** Sky time at a tick, µs, or null before the sky is known. */
  skyTime: (tick: number) => number | null;
  /** The world's last tick, 0 for none known. */
  end: () => number;
}

export class Forecasting implements WeatherSource {
  readonly forecasts = new Forecasts();
  readonly #parts: ForecastingParts;
  #fields: Fields | null = null;
  #making: Promise<Fields> | null = null;

  constructor(parts: ForecastingParts) {
    this.#parts = parts;
  }

  tick(): number {
    return this.#parts.tick();
  }

  present(): { keys: readonly Keyframe[]; spells: readonly ArrayLike<number>[] } {
    return this.#parts.present();
  }

  end(): number {
    return this.#parts.end();
  }

  /** The sun's height at a point at a tick, rad: −1 before the sky is known, as by night. */
  sun(tick: number, east: number, north: number): number {
    const t = this.#parts.skyTime(tick);
    if (t === null) {
      return -1;
    }
    return this.#parts.physics.skyAt(t, east, north)[SKY.sun + BODY.altitude] ?? -1;
  }

  /** The forecast's module, or null while it is made: the first ask starts it. */
  fields(): Fields | null {
    if (this.#fields === null && this.#making === null) {
      void this.made();
    }
    return this.#fields;
  }

  /** The forecast's module, made if it is not. */
  made(): Promise<Fields> {
    if (this.#making === null) {
      this.#making = this.#parts.physics.twin().then((p) => {
        preparePhysics(p, this.#parts.boat, catalog.weather, catalog.world);
        this.#fields = new Fields(p);
        return this.#fields;
      });
    }
    return this.#making;
  }
}
