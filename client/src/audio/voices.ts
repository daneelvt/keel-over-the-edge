// SPDX-License-Identifier: AGPL-3.0-only

// The voices of a boat at sea, as numbers: what each voice's filter and
// level should be for the apparent wind, the boat's speed, the sail's flow,
// the sea under the boat and the falls at the edge. The recipes (bands, levels, curves) are art, in art/sound/;
// this maps them onto the physics, so pitch follows the wind and the cloth
// flogs exactly when the physics says a strip is luffing. Nothing swells of
// itself: the wind's voice rises and falls with the gusts the boat feels,
// and the sea's with the waves under it.
//
// Wind is broadband noise with a slowly moving band (Farnell, Designing
// Sound, 2010). A rope in a wind of speed V sings at f = St·V/d, the
// Strouhal number St about 0.2: the Aeolian tone.
//
// The falls are a line source kilometres long: their sound spreads in
// cylinders, so its level falls 3 dB each time the distance doubles, where
// a point's falls 6. The air absorbs the highs over distance (ISO 9613-1,
// 1993: at 20 °C and 70% humidity about 5 dB/km at 1 kHz, 10 at 2 kHz, 30
// at 4 kHz and 100 at 8 kHz), so a low-pass falls with distance where the
// absorption reaches 3 dB.

import falls from '../../../art/sound/falls.json';
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
  falls: typeof falls;
}

export const RECIPES: Recipes = { wind, rigging, flogging, water, sea, falls };

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
  /** How far the lip is, m (0 while falling over it), and which way, as a pan: −1 left, 1 right. */
  lip: number;
  lipPan: number;
  /** Whether the boat is falling over the lip. */
  falling: boolean;
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
  fallsLevel: number;
  fallsCutoff: number;
  fallsPan: number;
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
    fallsLevel: 0,
    fallsCutoff: 0,
    fallsPan: 0,
  };
}

/**
 * The falls' level at d metres from the lip: most at near, 3 dB less each
 * doubling beyond, silent past reach (tapering over its last tenth).
 */
export function fallsLevel(r: Recipes['falls'], d: number): number {
  const at = Math.max(d, r.near);
  const spread = r.level.most * Math.sqrt(r.near / at);
  return spread * (1 - ramp(0.9 * r.reach, r.reach, d));
}

/**
 * The falls' low-pass at d metres: the frequency at which the air has
 * absorbed 3 dB over d, read from the table between its points on log
 * scales, and as the frequency below its first, within the cutoff's range.
 */
export function fallsCutoff(r: Recipes['falls'], d: number): number {
  const { at, dbPerKm } = r.absorption;
  const want = (3 * 1000) / Math.max(d, 1);
  let f: number;
  const first = dbPerKm[0] ?? 5;
  const last = dbPerKm[dbPerKm.length - 1] ?? 100;
  if (want <= first) {
    f = (at[0] ?? 1000) * (want / first);
  } else if (want >= last) {
    f = (at[at.length - 1] ?? 8000) * Math.sqrt(want / last);
  } else {
    let i = 0;
    while (i + 2 < dbPerKm.length && (dbPerKm[i + 1] ?? 0) < want) {
      i++;
    }
    const a0 = Math.log(dbPerKm[i] ?? 1);
    const a1 = Math.log(dbPerKm[i + 1] ?? 1);
    const f0 = Math.log(at[i] ?? 1);
    const f1 = Math.log(at[i + 1] ?? 1);
    f = Math.exp(f0 + ((Math.log(want) - a0) / (a1 - a0)) * (f1 - f0));
  }
  return Math.min(Math.max(f, r.cutoff.least), r.cutoff.most);
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

/** Sets the falls' part of the sound's inputs: how far the lip is, which way, and whether the boat falls. */
export function edgeInput(
  lip: number,
  pan: number,
  falling: boolean,
  into: SoundInput,
): SoundInput {
  into.lip = lip;
  into.lipPan = pan;
  into.falling = falling;
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

  const fl = r.falls;
  const d = x.falling ? 0 : Math.max(0, x.lip);
  out.fallsLevel = x.falling ? fl.level.falling : fallsLevel(fl, d);
  out.fallsCutoff = fallsCutoff(fl, d);
  out.fallsPan = x.falling ? 0 : Math.min(Math.max(x.lipPan, -1), 1);
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
