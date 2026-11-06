// SPDX-License-Identifier: AGPL-3.0-only

// The sea under the boat, for what is drawn of it beside the boat band: the
// wind that raises the waves there and its fetch, which the detail band's
// spectrum follows, and what the foam does at that wind. They are read from
// the window of sea areas the boat holds, blended between the four areas
// about the boat with the weights the boat band's amplitudes are blended
// by, and eased, so a sea that changes on a second's first tick is not seen
// to jump.
//
// Each area of the window also has its own foam: whitecaps, streaks and
// folding foam by its own wind, which the sea's shader blends between
// areas as it does the significant height. So a squall's sea whitens apart
// from the sea around it.
//
// The water's short waves answer a new wind in some ten of their periods,
// half a minute here, while the sea's peak takes a hundred, minutes (Uz
// and others, 2003): a squall's first minutes are steep, white chop, not
// height. So what is drawn of the sea beside the boat band, its foam and
// the detail band, follows the larger of the wave wind and the mean wind
// where it is, eased over LOCAL_EASE seconds: the mean wind at each area's
// centre for its foam, and at the boat for the detail band.

import { Vector4 } from 'three';
import { SEA, SEA_SPEED_STEP } from '../predict/layout.gen';
import { DETAIL, type FoamLook, foamAt, KNOT, newFoamLook } from './look';
import type { WaveWind } from './spectrum';

const AREAS = SEA.window * SEA.window;
const FROM_STEP = (2 * Math.PI) / SEA.fromSteps;
/** The drawn sea follows the mean wind where it is over this long, in seconds. */
export const LOCAL_EASE = 10;
/** Whitecaps, raised by a current, are held to at most this. */
const MOST_WHITECAPS = 5;

/** A window of sea areas and what raises each one's waves. */
export interface AreaInputs {
  readonly col: number;
  readonly row: number;
  readonly size: number;
  readonly speed: ArrayLike<number>;
  readonly from: ArrayLike<number>;
  readonly fetch: ArrayLike<number>;
}

/** The fraction of the way between two area centres, smoothed as the boat band's blend is. */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export class SeaUnder implements WaveWind {
  /** The wind that raises the waves under the boat, m/s, eased. */
  speed = 0;
  /** The direction the waves travel toward, a unit vector, eased. */
  east = 0;
  north = -1;
  /** The fetch, in metres, eased. */
  fetch = 0;
  /** The foam at that wind. */
  readonly foam: FoamLook = newFoamLook();
  /** Each area's foam: whitecaps, streaks and folding, for the shader to blend. */
  readonly areas: Vector4[] = Array.from({ length: AREAS }, () => new Vector4());

  /**
   * The mean wind at each area's centre and at the boat, m/s, as eased:
   * what is drawn follows it where it blows harder than the wave wind.
   */
  readonly local = new Float64Array(AREAS);
  localBoat = 0;

  #window: AreaInputs | null = null;
  #current: ArrayLike<number> | null = null;
  #settled = false;
  #localSettled = false;
  readonly #look = newFoamLook();
  /** The values the eased ones are on their way to. */
  readonly #to = { speed: 0, east: 0, north: -1, fetch: 0 };

  /**
   * The window of areas to read, or null for flat water. current, if
   * given, is how much the current raises each area's waves, its
   * significant height over the height it would have in still water: the
   * waves break more against a current, steeper (NDBC: all should break at
   * a steepness of 1/7), and less with one.
   */
  lay(window: AreaInputs | null, current: ArrayLike<number> | null = null): void {
    this.#window = window;
    this.#current = current;
    this.#foamAreas();
  }

  /**
   * The mean wind now at each area's centre, in the window's order, and at
   * the boat, m/s, dt seconds after the last: eased toward over
   * LOCAL_EASE seconds, there at once the first time, after a second or
   * more, or with time standing still.
   */
  setLocal(areas: ArrayLike<number>, boat: number, dt: number): void {
    const k = !this.#localSettled || dt >= 1 || !(dt > 0) ? 1 : 1 - Math.exp(-dt / LOCAL_EASE);
    this.#localSettled = true;
    for (let i = 0; i < AREAS; i++) {
      const was = this.local[i] as number;
      this.local[i] = was + ((areas[i] ?? 0) - was) * k;
    }
    this.localBoat += (boat - this.localBoat) * k;
    this.#foamAreas();
  }

  /** Forgets the local wind: what is drawn follows the wave wind alone until it is set again. */
  clearLocal(): void {
    this.local.fill(0);
    this.localBoat = 0;
    this.#localSettled = false;
    this.#foamAreas();
  }

  /** Each area's foam, by the larger of its wave wind and the mean wind at its centre. */
  #foamAreas(): void {
    const window = this.#window;
    const current = this.#current;
    for (let i = 0; i < AREAS; i++) {
      const a = this.areas[i] as Vector4;
      if (window === null || i >= window.size * window.size) {
        a.set(0, 0, 0, 0);
        continue;
      }
      const speed = Math.max((window.speed[i] ?? 0) * SEA_SPEED_STEP, this.local[i] ?? 0);
      const look = foamAt(speed / KNOT, this.#look);
      const raised = current === null ? 1 : (current[i] ?? 1);
      a.set(Math.min(MOST_WHITECAPS, look.whitecaps * raised), look.streaks, look.folding, 0);
    }
  }

  /** What the eased values will come to, at the last update. */
  get target(): Readonly<WaveWind> {
    return this.#to;
  }

  /**
   * Brings the sea under the boat at (east, north) up to date, dt seconds
   * after the last time. A second or more, or the first time, and it is
   * there at once; and with time standing still too, since a held picture
   * shows the sea as it is.
   */
  update(east: number, north: number, dt: number): void {
    const to = this.#to;
    const w = this.#window;
    if (w === null) {
      to.speed = 0;
      to.fetch = 0;
    } else {
      const half = SEA.areas >> 1;
      const fx = east / SEA.areaSize + half - w.col;
      const fy = north / SEA.areaSize + half - w.row;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      const wx = smooth(fx - cx);
      const wy = smooth(fy - cy);
      const last = w.size - 1;
      const clamp = (v: number): number => Math.min(Math.max(v, 0), last);
      let speed = 0;
      let fetch = 0;
      let e = 0;
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const col = clamp(cx + (k & 1));
        const row = clamp(cy + (k >> 1));
        const weight = (k & 1 ? wx : 1 - wx) * (k >> 1 ? wy : 1 - wy);
        const i = row * w.size + col;
        const s = (w.speed[i] ?? 0) * SEA_SPEED_STEP;
        const from = (w.from[i] ?? 0) * FROM_STEP;
        speed += weight * s;
        fetch += weight * (w.fetch[i] ?? 0);
        // Waves travel toward where the wind blows to. The stronger wind
        // counts for more of the direction.
        e -= weight * s * Math.sin(from);
        n -= weight * s * Math.cos(from);
      }
      // The short waves answer the wind where the boat is at once.
      to.speed = Math.max(speed, this.localBoat);
      to.fetch = fetch;
      const d = Math.hypot(e, n);
      if (d > 1e-9) {
        to.east = e / d;
        to.north = n / d;
      }
    }
    const k = !this.#settled || dt >= 1 || !(dt > 0) ? 1 : 1 - Math.exp((-3 * dt) / DETAIL.ease);
    this.#settled = true;
    this.speed += (to.speed - this.speed) * k;
    this.fetch += (to.fetch - this.fetch) * k;
    const e = this.east + (to.east - this.east) * k;
    const n = this.north + (to.north - this.north) * k;
    const d = Math.hypot(e, n);
    if (d > 1e-6) {
      this.east = e / d;
      this.north = n / d;
    } else {
      // Turning about: straight through the opposite direction.
      this.east = to.east;
      this.north = to.north;
    }
    foamAt(this.speed / KNOT, this.foam);
  }
}
