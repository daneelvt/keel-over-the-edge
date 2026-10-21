// SPDX-License-Identifier: AGPL-3.0-only

// The water's signs of the wind. The sea lags the wind: its waves follow
// the wind of the last few minutes (the sea areas' wave wind), so where the
// wind is suddenly stronger than the sea has caught up with, as under a
// squall's gust front, the water roughens and darkens before its waves
// build, and where it is suddenly lighter, as in a patch of light air, the
// ripples die and the water goes glassy. A few times a second the module
// samples the mean wind on a grid about the floating origin; each point's
// sign is how much stronger or lighter it is than its sea area's wave wind,
// from −1, glassy, to 1, a gust front, and the tiles take it with the gust
// field's own roughening and darkening.
//
// The same grid carries the rain at each point, as its share of heavy rain
// (10 mm an hour): under it the sea goes flat and grey, pocked with drops.
// Rain damps the waves longer than 10 cm and raises those under 5 cm with
// its rings, stalks and crowns (Melsheimer and others, as Long and Nie give
// it), and "at the onset of a heavy rain the white-capping disappears very
// rapidly", which is what sailors mean by "rain calms the sea" (Cavaleri
// and others 2015). Beyond the grid the far sea takes the rain at the
// camera.

import { DataTexture, LinearFilter, RGFormat, UnsignedByteType, Vector2 } from 'three';
import { Fn, float, texture, uniform, vec2 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import type { WeatherWater } from '../catalog/types.gen';
import { SEA } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';

/** The wind's share over the wave wind's at which a sign shows in full, and under which it shows not at all. */
export const SIGN_LOOK = { full: 0.5, from: 0.1 };

/** The sign of a wind of a share of its sea's wave wind: −1 to 1. */
export function signOf(share: number): number {
  const x = Math.max(-1, Math.min(1, (share - 1) / SIGN_LOOK.full));
  const a = Math.abs(x);
  const t = Math.max(0, Math.min(1, (a - SIGN_LOOK.from) / (1 - SIGN_LOOK.from)));
  return Math.sign(x) * t * t * (3 - 2 * t);
}

/** A sign of nothing, as a texel: the signs from −1 to 1 are 0 to 254. */
const ZERO = 127;

/** Rain of this rate, mm an hour, shows in full on the water: heavy rain (WMO-No. 8). */
export const RAIN_FULL = 10;

/** The share of rain of a rate the water shows, 0 to 1. */
export function rainShare(rate: number): number {
  return Math.min(Math.max(rate / RAIN_FULL, 0), 1);
}

/** The middle area's column and row, which is centred on the world's centre. */
const MIDDLE = (SEA.areas - 1) / 2;

export class WaterSigns {
  readonly points: number;
  readonly spacing: number;
  readonly texture: DataTexture;
  /**
   * The grid's centre from the floating origin, in the scene's frame (x
   * east, y south), and the grid's span, m.
   */
  readonly at = uniform(new Vector2());
  readonly span: UniformNode<'float', number>;
  /** 0 to draw no signs: no weather, or the developer panel's. */
  readonly on: UniformNode<'float', number> = uniform(0);
  /** 1 to draw the signs; 0 to draw the water without them. */
  shown = 1;
  /** The rain's share on the far sea: the rain at the camera. */
  readonly rainFar: UniformNode<'float', number> = uniform(0);
  /** 1 while the grid holds rain. */
  readonly rainOn: UniformNode<'float', number> = uniform(0);
  /** A rain a developer holds everywhere, mm an hour, or null for the weather's. */
  heldRain: number | null = null;

  readonly #every: number;
  readonly #data: Uint8Array<ArrayBuffer>;
  readonly #grid: Float64Array;
  readonly #mean: Float64Array;
  readonly #rain: Float64Array;
  #last = Number.NEGATIVE_INFINITY;
  #east = 0;
  #north = 0;

  constructor(water: WeatherWater) {
    this.points = water.points;
    this.spacing = water.spacing;
    this.#every = 1 / water.rate;
    const n = this.points;
    this.#data = new Uint8Array(2 * n * n);
    for (let p = 0; p < n * n; p++) {
      this.#data[2 * p] = ZERO;
    }
    this.texture = new DataTexture(this.#data, n, n, RGFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.needsUpdate = true;
    this.span = uniform(n * this.spacing);
    this.#grid = new Float64Array(2 * n * n);
    this.#mean = new Float64Array(2 * n * n);
    this.#rain = new Float64Array(n * n);
  }

  /**
   * Samples the signs again if it is time, at a time in ticks and seconds,
   * about the floating origin, from the module's weather and the sea it
   * holds; and brings the grid's place in the scene up to date. With no
   * spell of weather with gusts (a steady wind, which stills the systems
   * too) there are no signs; the rain is sampled whatever the wind.
   */
  update(
    gusty: boolean,
    physics: Physics | null,
    seas: Seas | null,
    tick: number,
    seconds: number,
    originEast: number,
    originNorth: number,
  ): void {
    if (physics === null || seas === null) {
      this.on.value = 0;
      this.rainOn.value = 0;
      return;
    }
    if (seconds - this.#last >= this.#every || seconds < this.#last) {
      this.#last = seconds;
      this.#sample(physics, seas, tick, originEast, originNorth, gusty);
    }
    this.on.value = gusty ? this.shown : 0;
    this.at.value.set(this.#east - originEast, -(this.#north - originNorth));
  }

  #sample(
    physics: Physics,
    seas: Seas,
    tick: number,
    east: number,
    north: number,
    gusty: boolean,
  ): void {
    const n = this.points;
    const s = this.spacing;
    this.#east = east;
    this.#north = north;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = 2 * (j * n + i);
        // Texel (i, j) at the scene's x east and y south of the grid's centre.
        this.#grid[k] = east + (i + 0.5 - n / 2) * s;
        this.#grid[k + 1] = north - (j + 0.5 - n / 2) * s;
      }
    }
    physics.windDrawAt(tick);
    physics.rainSample(this.#grid, this.#rain);
    let any = false;
    for (let p = 0; p < n * n; p++) {
      const r = rainShare(this.heldRain ?? this.#rain[p] ?? 0);
      this.#data[2 * p + 1] = Math.round(255 * r);
      any ||= r > 0;
    }
    this.rainOn.value = any ? 1 : 0;
    if (!gusty) {
      this.texture.needsUpdate = true;
      return;
    }
    physics.meanSample(this.#grid, this.#mean);
    const slot = seas.slotAt(tick);
    const held = slot < 0 ? null : seas.held[slot];
    for (let p = 0; p < n * n; p++) {
      let sign = 0;
      if (held?.have) {
        const col = Math.floor((this.#grid[2 * p] ?? 0) / SEA.areaSize + MIDDLE + 0.5) - held.col;
        const row =
          Math.floor((this.#grid[2 * p + 1] ?? 0) / SEA.areaSize + MIDDLE + 0.5) - held.row;
        if (col >= 0 && row >= 0 && col < held.size && row < held.size) {
          const wave = (held.speed[row * held.size + col] ?? 0) * 0.01;
          // In a breath of air no sign is read: there is nothing to see.
          if (wave > 0.5) {
            sign = signOf((this.#mean[2 * p] ?? 0) / wave);
          }
        }
      }
      this.#data[2 * p] = Math.round(ZERO + ZERO * sign);
    }
    this.texture.needsUpdate = true;
  }
}

/**
 * The water's sign at a point of the scene, (x east, y south) from the
 * floating origin: from −1, glassy, to 1, a gust front; nothing beyond the
 * grid.
 */
export const waterSignAt = (w: WaterSigns): ((c: Node<'vec2'>) => Node<'float'>) =>
  Fn(([c]: [Node<'vec2'>]) => {
    const uv = c.sub(w.at).div(w.span).add(0.5);
    const inside = uv.x
      .greaterThan(0)
      .and(uv.x.lessThan(1))
      .and(uv.y.greaterThan(0))
      .and(uv.y.lessThan(1));
    const v = texture(w.texture, vec2(uv.x, uv.y))
      .level(float(0))
      .x.mul(255 / ZERO)
      .sub(1);
    // A texel's rounding is no sign.
    return inside.and(v.abs().greaterThan(0.01)).select(v.mul(w.on), float(0));
  }) as unknown as (c: Node<'vec2'>) => Node<'float'>;

/**
 * The rain's share on the water at a point of the scene, (x east, y south)
 * from the floating origin, 0 to 1: the grid's within it, the rain at the
 * camera's beyond.
 */
export const waterRainAt = (w: WaterSigns): ((c: Node<'vec2'>) => Node<'float'>) =>
  Fn(([c]: [Node<'vec2'>]) => {
    const uv = c.sub(w.at).div(w.span).add(0.5);
    const inside = uv.x
      .greaterThan(0)
      .and(uv.x.lessThan(1))
      .and(uv.y.greaterThan(0))
      .and(uv.y.lessThan(1));
    const v = texture(w.texture, vec2(uv.x, uv.y)).level(float(0)).y;
    return inside.and(w.rainOn.greaterThan(0)).select(v, w.rainFar);
  }) as unknown as (c: Node<'vec2'>) => Node<'float'>;
