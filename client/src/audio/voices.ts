// SPDX-License-Identifier: AGPL-3.0-only

// The five voices of a boat at sea, as numbers: what each voice's filter
// and level should be for the apparent wind, the boat's speed, the sail's
// flow and the sea under the boat. The recipes (bands, levels, curves) are art, in art/sound/;
// this maps them onto the physics, so pitch follows the wind and the cloth
// flogs exactly when the physics says a strip is luffing. Nothing swells of
// itself: the wind's voice rises and falls with the gusts the boat feels,
// and the sea's with the waves under it.
//
// Wind is broadband noise with a slowly moving band (Farnell, Designing
// Sound, 2010). A rope in a wind of speed V sings at f = St·V/d, the
// Strouhal number St about 0.2: the Aeolian tone.

import flogging from '../../../art/sound/flogging.json';
import rigging from '../../../art/sound/rigging.json';
import sea from '../../../art/sound/sea.json';
import water from '../../../art/sound/water.json';
import wind from '../../../art/sound/wind.json';
import { RECORDS } from '../predict/layout.gen';

export interface Recipes {
  wind: typeof wind;
  rigging: typeof rigging;
  flogging: typeof flogging;
  water: typeof water;
  sea: typeof sea;
}

export const RECIPES: Recipes = { wind, rigging, flogging, water, sea };

/** Sound parameters are set at most this often, in milliseconds. */
export const SOUND_INTERVAL = 50;

/** The flow of a sail strip that luffs (Out.FootFlow, Out.HeadFlow). */
const FLOW_LUFFING = 0;

export interface SoundInput {
  /** The apparent wind at the masthead, m/s. */
  apparentWind: number;
  /** The boat's speed, m/s. */
  speed: number;
  /** The boat's speed through the water, m/s. */
  throughWater: number;
  /** The significant height of the waves under the boat, in metres. */
  seaHeight: number;
  /** The whitecaps on the sea under the boat, 0 to 1. */
  whitecaps: number;
  /** How many of the sail's two strips are luffing, 0 to 2. */
  luffing: number;
  /** World time, seconds. */
  time: number;
}

export interface SoundTargets {
  windCentre: number;
  windLevel: number;
  rigTone: number;
  rigLevel: number;
  flapRate: number;
  flogLevel: number;
  waterCutoff: number;
  waterLevel: number;
  hissLevel: number;
  seaCentre: number;
  seaLevel: number;
}

export function newTargets(): SoundTargets {
  return {
    windCentre: 0,
    windLevel: 0,
    rigTone: 0,
    rigLevel: 0,
    flapRate: 0,
    flogLevel: 0,
    waterCutoff: 0,
    waterLevel: 0,
    hissLevel: 0,
    seaCentre: 0,
    seaLevel: 0,
  };
}

/** 0 below from, rising smoothly to 1 at full. */
export function ramp(from: number, full: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (full - from)));
  return t * t * (3 - 2 * t);
}

/** The Aeolian tone of a rope of diameter d (m) in a wind of speed v (m/s), in Hz. */
export function aeolianTone(strouhal: number, v: number, d: number): number {
  return (strouhal * Math.max(0, v)) / d;
}

/** The sea under the boat, as the sound hears it. */
export interface SeaHeard {
  /** The significant height of its waves, in metres. */
  height: number;
  /** Its whitecaps, 0 to 1. */
  whitecaps: number;
}

/** Reads the sound's inputs from Out and the sea under the boat. */
export function soundInput(
  out: Float64Array,
  sea: Readonly<SeaHeard>,
  time: number,
  into: SoundInput,
): SoundInput {
  into.apparentWind = out[RECORDS.out.apparentWindSpeed] ?? 0;
  into.speed = out[RECORDS.out.speedOverGround] ?? 0;
  into.throughWater = out[RECORDS.out.speedThroughWater] ?? 0;
  into.seaHeight = sea.height;
  into.whitecaps = sea.whitecaps;
  into.luffing =
    (out[RECORDS.out.footFlow] === FLOW_LUFFING ? 1 : 0) +
    (out[RECORDS.out.headFlow] === FLOW_LUFFING ? 1 : 0);
  into.time = time;
  return into;
}

/** Each voice's targets for the input, by the recipes. */
export function soundTargets(r: Recipes, x: SoundInput, out: SoundTargets): SoundTargets {
  const v = Math.max(0, x.apparentWind);
  const w = r.wind;
  const breath =
    1 +
    w.breath.depth *
      Math.sin(2 * Math.PI * w.breath.rate * x.time) *
      Math.sin(2 * Math.PI * w.breath.rate * 0.37 * x.time + 1);
  out.windCentre = Math.min(w.centre.most, w.centre.atRest + w.centre.perSpeed * v) * breath;
  out.windLevel = w.level.most * ramp(w.level.from, w.level.full, v) * breath;

  const g = r.rigging;
  out.rigTone = aeolianTone(g.strouhal, v, g.diameter);
  out.rigLevel = g.level.most * ramp(g.level.from, g.level.full, v);

  const f = r.flogging;
  out.flapRate = f.rate.atRest + f.rate.perSpeed * v;
  out.flogLevel =
    x.luffing > 0
      ? f.level.most * ramp(f.level.from, f.level.full, v) * (0.6 + 0.2 * x.luffing)
      : 0;

  const s = Math.max(0, x.speed);
  const h = r.water;
  out.waterCutoff = Math.min(h.cutoff.most, h.cutoff.atRest + h.cutoff.perSpeed * s);
  out.waterLevel = h.level.most * ramp(h.level.from, h.level.full, s);
  out.hissLevel = h.hiss.most * ramp(h.hiss.hullSpeed, h.hiss.full, s);

  // The sea: its level by the height of the waves, shared between the sea
  // alone, its whitecaps and the boat's way through it.
  const e = r.sea;
  const hs = Math.max(0, x.seaHeight);
  const white = Math.min(1, Math.max(0, x.whitecaps));
  const way = ramp(e.speed.from, e.speed.full, Math.abs(x.throughWater));
  out.seaCentre =
    Math.min(e.centre.most, e.centre.atRest + e.centre.perHeight * hs) *
    (1 + e.centre.whitecaps * white);
  out.seaLevel =
    e.level.most *
    ramp(e.level.from, e.level.full, hs) *
    (e.share.sea + e.share.whitecaps * white + e.share.speed * way);
  return out;
}

/** Lets something through at most once every interval milliseconds. */
export class Throttle {
  readonly interval: number;
  #last = Number.NEGATIVE_INFINITY;
  constructor(interval: number) {
    this.interval = interval;
  }
  /** Whether now (ms) is due; if so, counts it. */
  due(now: number): boolean {
    if (now - this.#last < this.interval) {
      return false;
    }
    this.#last = now;
    return true;
  }
}
