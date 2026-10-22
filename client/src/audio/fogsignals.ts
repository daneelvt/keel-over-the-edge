// SPDX-License-Identifier: AGPL-3.0-only

// The lighthouses' fog signals, as numbers and events: what the sound
// engine plays near them in fog. Each light's signal keeps its pattern of
// blasts and silences by world time and its light's phase (lights/
// fogsignal.ts), the same for everyone, and a blast sounds only while the
// visibility at its light is under the catalog's limit when it begins, as a
// keeper starts the signal when the fog comes in (a fog signal sounds in
// restricted visibility: IHO S-12, the USCG Light List). A blast is heard when its
// sound arrives, the distance over the speed of sound after it began, and
// lasts as long as it sounded.
//
// Each is placed where it is: panned by its light's bearing from where the
// camera looks, fainter with distance, a point source's 6 dB each time the
// distance doubles, and duller, the air absorbing its highs (audio/air.ts).
// A licence, as the catalog states it: within its range a signal is always
// heard, from its light's own bearing, and land never blocks it, where a
// real one has zones of silence and seems to come from the wrong way in fog
// (Tyndall 1874; Bowditch warns not to trust a sound signal's distance or
// bearing).

import diaphone from '../../../art/sound/diaphone.json';
import reedhorn from '../../../art/sound/reedhorn.json';
import siren from '../../../art/sound/siren.json';
import thunder from '../../../art/sound/thunder.json';
import twotone from '../../../art/sound/twotone.json';
import { catalog } from '../catalog';
import type { FogSignalDevice, FogSignalRule } from '../catalog/types.gen';
import { STEPS_PER_SECOND } from '../game/clock';
import { blastsBetween } from '../lights/fogsignal';
import { airCutoff } from './air';
import { type At, panOf, pointLevel } from './harbour';

export interface FogSignalRecipes {
  diaphone: typeof diaphone;
  twotone: typeof twotone;
  siren: typeof siren;
  reedhorn: typeof reedhorn;
  /** The air's absorption, as the thunder's recipe gives it: the same air. */
  air: { absorption: typeof thunder.absorption; cutoff: typeof thunder.cutoff };
}

export const FOG_SIGNAL_RECIPES: FogSignalRecipes = {
  diaphone,
  twotone,
  siren,
  reedhorn,
  air: { absorption: thunder.absorption, cutoff: thunder.cutoff },
};

/** The catalog's fog signals as the sound reads them: the patterns, their rule, and the speed of sound, m/s. */
export interface FogSignalRules {
  signals: readonly { device: FogSignalDevice; steps: readonly number[] }[];
  rule: Pick<FogSignalRule, 'sounds' | 'heard'>;
  speed: number;
}

export const FOG_SIGNAL_RULES: FogSignalRules = {
  signals: catalog.world.lights.fogSignals,
  rule: catalog.world.lights.fogSignal,
  speed: catalog.weather.thunder.speed,
};

/** A light as its fog signal is heard: where it is, its phase, µs, and its pattern's index in the catalog's. */
export interface FogLight extends At {
  number: number;
  phase: number;
  fogSignal: number;
}

/** What the fog signals sound like from here, now. */
export interface FogSignalsInput {
  /** World time, s. */
  seconds: number;
  /** The listener, and the bearing the camera looks along, radians. */
  listener: At;
  look: number;
  /** The lights near. */
  lights: Iterable<FogLight>;
  /** Whether the visibility at a place, m east and north, at a tick of world time is under the rule's limit. */
  poorAt: (east: number, north: number, tick: number) => boolean;
}

/** A blast to play once, as the listener hears it. */
export interface FogSignalEvent {
  device: FogSignalDevice;
  /** Its light's number, and when it sounded there, world s. */
  light: number;
  start: number;
  /** When it is heard, world s, and how long, s. */
  at: number;
  length: number;
  /** The tones it sounds in turn, Hz: two for a two-tone, the second lower. */
  tones: number[];
  level: number;
  pan: number;
  /** The air's low-pass over its distance, Hz. */
  cutoff: number;
}

/**
 * A poorAt for the rule: whether the visibility a function gives, m, is
 * under the limit a blast sounds below.
 */
export function poorBy(
  rule: Pick<FogSignalRule, 'sounds'>,
  visibility: (east: number, north: number, tick: number) => number,
): FogSignalsInput['poorAt'] {
  const limit = rule.sounds * 1852;
  return (east, north, tick) => visibility(east, north, tick) < limit;
}

/** The tones a device's blast sounds in turn, Hz. */
export function tonesOf(r: FogSignalRecipes, device: FogSignalDevice): number[] {
  if (device === 'twotone') {
    return [r.twotone.pitch, r.twotone.low];
  }
  return [r[device].pitch];
}

/**
 * The blasts heard between world seconds from and to: each light's within
 * the rule's range whose blast began while the visibility at its light was
 * under the rule's limit.
 */
export function fogSignalEvents(
  r: FogSignalRecipes,
  c: FogSignalRules,
  x: FogSignalsInput,
  from: number,
  to: number,
): FogSignalEvent[] {
  const out: FogSignalEvent[] = [];
  if (!(to > from)) {
    return out;
  }
  const reach = c.rule.heard * 1852;
  for (const l of x.lights) {
    const s = c.signals[l.fogSignal];
    if (s === undefined) {
      continue;
    }
    const d = Math.hypot(l.east - x.listener.east, l.north - x.listener.north);
    const device = r[s.device];
    const level = device.level * pointLevel(d, device.near, reach);
    if (!(level > 0)) {
      continue;
    }
    // The blasts whose sound arrives in the interval began the sound's
    // travel earlier.
    const delay = d / c.speed;
    const fromUs = Math.floor((from - delay) * 1e6);
    const toUs = Math.floor((to - delay) * 1e6);
    for (const b of blastsBetween(s.steps, l.phase, fromUs, toUs)) {
      if (!x.poorAt(l.east, l.north, Math.floor((b.start * STEPS_PER_SECOND) / 1e6))) {
        continue;
      }
      out.push({
        device: s.device,
        light: l.number,
        start: b.start / 1e6,
        at: b.start / 1e6 + delay,
        length: (b.end - b.start) / 1e6,
        tones: tonesOf(r, s.device),
        level,
        pan: panOf(x.listener, l, x.look),
        cutoff: airCutoff(r.air.absorption, r.air.cutoff.least, r.air.cutoff.most, d),
      });
    }
  }
  return out;
}
