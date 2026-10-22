// SPDX-License-Identifier: AGPL-3.0-only

// The weather in the sky, from the physics module's fields: the heaped
// clouds and the fair-weather cumulus, laid out five times a second; the
// sheets, written once a second; the rain under the clouds and at the
// boat; and what they do to the light. Overcast at the camera is the most
// of 0.85 of the middle sheet, the low sheet, and under a heaped cloud its
// cloud strength, fading from half its reach to a little beyond it; it is
// eased over ten seconds, as the eye takes in a change of light.

import type { Scene, Vector3 } from 'three';
import type { WeatherClouds } from '../catalog/types.gen';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import { Curtains, Streaks } from '../render/rain';
import { Clouds, CUMULUS_REACH, HAZE_HALF } from './clouds';
import { sheets } from './sheets';

/** How often the clouds are laid out again, s, and how often the rain at the camera is asked. */
const LAY_EVERY = 0.2;
const RAIN_EVERY = 0.25;

/** World time that moves this much more than the frame's seconds, s, is a jump: the sky is taken as it is. */
const JUMP = 5;

/** Overcast eases toward what the sky shows over this many seconds. */
const OVERCAST_EASE = 10;

/** The rain at the camera eases over this many seconds: a curtain is crossed, not switched. */
const RAIN_EASE = 1.5;

/** What a frame tells the sky's weather. */
export interface SkyWeatherFrame {
  /** World time in ticks and seconds, and seconds since the last frame. */
  tick: number;
  seconds: number;
  dt: number;
  /** The camera in the scene, and in the world, m east and north. */
  camera: Vector3;
  cameraEast: number;
  cameraNorth: number;
  originEast: number;
  originNorth: number;
  /** The sun's height at the camera, rad. */
  sunHeight: number;
  /** The wind at the boat, toward east and north, m/s. */
  windEast: number;
  windNorth: number;
}

export class SkyWeather {
  readonly clouds = new Clouds();
  readonly curtains = new Curtains();
  readonly streaks = new Streaks();
  readonly sheets = sheets;
  /** The rain at the camera now, mm an hour, eased; and as the module last gave it. */
  rain = 0;
  rainNow = 0;
  /** A rain a developer holds at the camera, mm an hour, or null for the weather's. */
  heldRain: number | null = null;
  /** How overcast it is at the camera, 0 to 1, eased; and what the sky shows now. */
  overcast = 0;
  overcastNow = 0;
  /** Whether any of it is drawn: the tests turn it off. */
  shown = true;
  /** The islands' caps held: by number, each its centre east and north and its width, m. */
  readonly caps = new Map<number, readonly [number, number, number]>();
  #capsChanged = false;
  #laid = Number.NEGATIVE_INFINITY;
  #asked = Number.NEGATIVE_INFINITY;
  #heaped = new Float64Array(0);
  #seconds = Number.NEGATIVE_INFINITY;

  constructor(scene: Scene, clouds: WeatherClouds) {
    this.sheets.configure(clouds);
    scene.add(this.clouds.mesh, this.curtains.mesh, this.streaks.mesh);
  }

  /** Islands' caps come into sight, and those to drop: all of them for a new connection. */
  setCaps(
    caps: readonly { number: number; east: number; north: number; width: number }[],
    drop: readonly number[] | 'all',
  ): void {
    if (drop === 'all') {
      this.caps.clear();
    } else {
      for (const n of drop) {
        this.caps.delete(n);
      }
    }
    for (const c of caps) {
      this.caps.set(c.number, [c.east, c.north, c.width]);
    }
    this.#capsChanged = true;
  }

  /** The tiers' budgets: the puffs and the streaks at the boat drawn at most. */
  setCapacity(puffs: number, streaks: number): void {
    this.clouds.capacity = puffs;
    this.streaks.capacity = streaks;
  }

  /** The sky's weather for a frame, from the module's weather, or none with no module. */
  frame(physics: Physics | null, f: SkyWeatherFrame): void {
    const on = physics !== null && this.shown;
    if (on && this.#capsChanged) {
      physics.setCaps([...this.caps.values()]);
      this.#capsChanged = false;
    }
    this.sheets.update(
      on ? physics : null,
      f.tick,
      f.seconds,
      f.cameraEast,
      f.cameraNorth,
      f.originEast,
      f.originNorth,
    );
    if (!on) {
      this.clouds.mesh.visible = false;
      this.curtains.mesh.visible = false;
      this.#heaped = new Float64Array(0);
      this.rainNow = this.heldRain ?? 0;
      this.overcastNow = 0;
    } else {
      const since = f.seconds - this.#laid;
      if (since >= LAY_EVERY || since < 0) {
        this.#laid = f.seconds;
        physics.windDrawAt(f.tick);
        this.#heaped = Float64Array.from(physics.cloudsAt());
        const fair = Float64Array.from(
          physics.cumulusAt(f.cameraEast, f.cameraNorth, CUMULUS_REACH, f.sunHeight),
        );
        this.clouds.lay(this.#heaped, fair, f.cameraEast, f.cameraNorth);
        this.curtains.lay(this.#heaped, f.cameraEast, f.cameraNorth, f.windEast, f.windNorth);
      }
      if (f.seconds - this.#asked >= RAIN_EVERY || f.seconds < this.#asked) {
        this.#asked = f.seconds;
        physics.windDrawAt(f.tick);
        this.rainNow = this.heldRain ?? physics.rainAt(f.cameraEast, f.cameraNorth);
        const s = physics.sheetAt(f.cameraEast, f.cameraNorth);
        const middle = s[RECORDS.sheets.middle] ?? 0;
        const low = s[RECORDS.sheets.low] ?? 0;
        this.overcastNow = Math.min(
          Math.max(0.85 * middle, low, this.#underHeaped(f.cameraEast, f.cameraNorth)),
          1,
        );
      }
      this.clouds.frame(f.originEast, f.originNorth, f.seconds - this.#laid);
      this.curtains.frame(f.originEast, f.originNorth, f.seconds);
    }
    // Eased over real changes; a jump in world time, as a test's or a
    // returning page's, takes the sky as it is.
    const jumped = Math.abs(f.seconds - this.#seconds - f.dt) > JUMP;
    this.#seconds = f.seconds;
    const k = jumped ? Number.POSITIVE_INFINITY : Math.min(Math.max(f.dt, 0), 1);
    this.overcast += (this.overcastNow - this.overcast) * Math.min(k / OVERCAST_EASE, 1);
    this.rain += (this.rainNow - this.rain) * Math.min(k / RAIN_EASE, 1);
    if (this.rain < 0.01 && this.rainNow === 0) {
      this.rain = 0;
    }
    this.streaks.frame(
      this.shown ? this.rain : 0,
      f.camera,
      f.cameraEast,
      f.cameraNorth,
      f.windEast,
      f.windNorth,
      f.dt,
    );
  }

  /** The clouds' haze in rain: shortened as the visual range is, by share of the clear air's. */
  hazeIn(share: number): void {
    this.clouds.hazeScale.value = (HAZE_HALF / Math.LN2) * Math.min(Math.max(share, 0.05), 1);
  }

  /** How overcast a heaped cloud makes it at (east, north): its cloud strength under it, fading beyond its reach. */
  #underHeaped(east: number, north: number): number {
    const C = RECORDS.cloud;
    const h = this.#heaped;
    let most = 0;
    for (let o = 0; o + SIZES.cloud <= h.length; o += SIZES.cloud) {
      const reach = Math.max(h[o + C.ahead] ?? 0, h[o + C.deck] ?? 0, 0.5 * (h[o + C.size] ?? 0));
      if (reach <= 0) {
        continue;
      }
      const d = Math.hypot((h[o + C.east] ?? 0) - east, (h[o + C.north] ?? 0) - north);
      const t = Math.min(Math.max((d - 0.5 * reach) / (0.7 * reach), 0), 1);
      most = Math.max(most, (h[o + C.cloud] ?? 0) * (1 - t * t * (3 - 2 * t)));
    }
    return most;
  }

  /** The heaped clouds last laid out: the module's cloud records. */
  get heaped(): Float64Array {
    return this.#heaped;
  }
}
