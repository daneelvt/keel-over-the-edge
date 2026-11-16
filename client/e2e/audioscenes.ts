// SPDX-License-Identifier: AGPL-3.0-only

// The scenes the sound is measured at, scripted: the boat's voices from the
// apparent wind, the speed and the sea as a boat feels them in each
// weather, the wind gusting about its mean; and what is heard about it,
// from the sound's own schedules (the harbour's bell, gulls and mallets,
// the sea's life's calls, a lighthouse's fog signal, thunder after its
// flashes, a race's guns and cheers); the boat pitching and heaving in the
// waves as the sea makes it (as fast and as far as a small boat pitches in
// the sandbox's seas), so the bow slaps, and its boom crossing in a tack and
// a gybe. Each repeats every CYCLE seconds, so
// a scene rendered short measures as one rendered long. The listener sits
// at the origin looking north.

import { CHEER, cheerOf } from '../src/audio/cheer';
import type { SoundEngine } from '../src/audio/engine';
import { FOG_SIGNAL_RULES } from '../src/audio/fogsignals';
import { GUN, gunReport } from '../src/audio/gun';
import type { HarbourInput } from '../src/audio/harbour';
import type { LifeGroup, LifeInput } from '../src/audio/life';
import type { ThunderFlash } from '../src/audio/thunder';
import type { SoundInput } from '../src/audio/voices';
import { catalog } from '../src/catalog';

/** How long a scene's script runs before it repeats, s. */
export const CYCLE = 30;

/** The world seconds a scene starts at: by day. */
const START = 1000;

/** The weather a scene is sailed in. */
interface Weather {
  /** The apparent wind's mean, m/s, and how far its gusts swing it, a fraction. */
  wind: number;
  gusts: number;
  /** The boat's speed, m/s; the sea's height, m, and whitecaps, 0 to 1; rain, mm an hour. */
  speed: number;
  sea: number;
  whitecaps: number;
  rain?: number;
  /** How far the lip is, m. */
  lip?: number;
  /** How far the boat pitches either way in the waves, degrees, and their period, s; how far it heaves, m. */
  pitch?: number;
  period?: number;
  heave?: number;
  /** The water's depth under the boat, m: a shore near where shallow. */
  depth?: number;
}

/** A scene: its weather, and what happens in it at t seconds into its cycle. */
export interface Scene {
  weather: Weather;
  /** Called every 50 ms: plays what is heard at t, s into the scene, now ms. */
  step(engine: SoundEngine, t: number, now: number): void;
}

const listener = { east: 0, north: 0 };

/** The wind's gust about its mean at t, s: two slow swells and a quicker flutter, −1 to 1. */
function gust(t: number): number {
  return (
    0.7 * Math.sin((2 * Math.PI * t) / 17) * (0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 41)) +
    0.3 * Math.sin((2 * Math.PI * t) / 5.3 + 1)
  );
}

const input: SoundInput = {
  apparentWind: 0,
  speed: 0,
  throughWater: 0,
  seaHeight: 0,
  whitecaps: 0,
  luffing: 0,
  time: 0,
  lip: Number.POSITIVE_INFINITY,
  lipPan: 0,
  falling: false,
  waterline: 3.5,
  sailArea: 7,
};

/** The boom's angle, rad, and its rate, rad/s, and the apparent wind's angle off the bow, rad: on starboard, close-hauled. */
const STARBOARD = { boom: 0.35, rate: 0, angle: 0.8 };

/** The boom as it crosses in a tack (the wind across the bow) or a gybe (across the stern), from start to end, s, at t. */
function crossing(kind: 'tack' | 'gybe', start: number, end: number, t: number): typeof STARBOARD {
  const c = inCycle(t);
  const k = Math.min(1, Math.max(0, (c - start) / (end - start)));
  const side = Math.cos(Math.PI * k);
  if (kind === 'tack') {
    return {
      boom: 0.35 * side,
      rate: (-0.35 * Math.PI * Math.sin(Math.PI * k)) / (end - start),
      angle: 0.8 * side,
    };
  }
  // A gybe's boom swings across fast, from well out to well out.
  const swing = c < (start + end) / 2 ? 1 : -1;
  return {
    boom: 1.2 * swing,
    rate: c >= (start + end) / 2 && c < (start + end) / 2 + 0.2 ? -2 : 0,
    angle: 2.9 * swing,
  };
}

/** The boat's own voices in a weather at t, s; luffing, how many strips luff; sail, the boom and the wind's angle. */
function bed(
  engine: SoundEngine,
  w: Weather,
  t: number,
  now: number,
  luffing = 0,
  sail: typeof STARBOARD = STARBOARD,
): void {
  const g = 1 + w.gusts * gust(t);
  input.apparentWind = w.wind * g;
  input.gustFactor = g;
  input.speed = w.speed * (1 + 0.3 * w.gusts * gust(t - 2));
  input.throughWater = input.speed;
  input.seaHeight = w.sea;
  input.whitecaps = w.whitecaps;
  input.luffing = luffing;
  input.time = START + t;
  input.rain = w.rain ?? 0;
  input.lip = w.lip ?? Number.POSITIVE_INFINITY;
  input.lipPan = 0.4;
  // The waves, a little irregular: two periods beating.
  const omega = (2 * Math.PI) / (w.period ?? 4);
  const a = ((w.pitch ?? 0.5) * Math.PI) / 180;
  const beat = 0.75 + 0.25 * Math.sin((2 * Math.PI * t) / 23);
  input.pitchRate = a * beat * omega * Math.cos(omega * t);
  input.heaveRate = (w.heave ?? 0.1) * omega * Math.cos(omega * t - 0.4);
  input.boom = sail.boom;
  input.boomRate = sail.rate;
  input.apparentAngle = sail.angle;
  input.depth = w.depth ?? 40;
  engine.update(now, input);
}

/** Within a cycle: t's part of it, s. */
const inCycle = (t: number): number => t % CYCLE;

/** Whether t is the step at which a cycle's moment at falls. */
const at = (t: number, moment: number): boolean => Math.abs(inCycle(t) - moment) < 0.025;

/** A group of the sea's life that calls call, hovering at east, north. */
function group(call: string, east: number, north: number, seed: number): LifeGroup {
  const kind = catalog.life.kinds.findIndex((k) => k.look?.call === call);
  if (kind < 0) {
    throw new Error(`no life kind calls ${call}`);
  }
  return {
    record: {
      id: String(seed),
      rev: 0,
      kind,
      start: 0,
      end: 1e9,
      east,
      north,
      heading: 0,
      speed: 0,
      count: 6,
      seed,
      with: 0,
      over: '',
    },
    kind: catalog.life.kinds[kind] as LifeGroup['kind'],
    pose: null,
  };
}

function lifeOf(groups: LifeGroup[]): (engine: SoundEngine, t: number, now: number) => void {
  const x: LifeInput = { seconds: START, day: true, listener, look: 0, groups };
  return (engine, t, now) => {
    x.seconds = START + t;
    engine.life(now, x);
  };
}

/** The harbour about a boat in port: its bell, a yard, a quay and a town's gulls near. */
const harbour: HarbourInput = {
  seconds: START,
  hour: 10,
  day: true,
  listener,
  look: 0,
  inPort: true,
  nearTown: 40,
  bell: { east: 60, north: 80 },
  yard: { east: -140, north: 160 },
  quay: { east: -25, north: 10 },
  gulls: [{ town: 0, east: 90, north: 160, level: 1, seed: 7 }],
  seaHeight: 0.2,
  period: 4,
};

/** A world hour as long as a cycle is twice: the bell strikes 3 s into each. */
const HARBOUR_HOUR = 2 * CYCLE;

const thunderFlashes: ThunderFlash[] = [];

/** A diaphone's light, 500 m off to the north-east. */
const fogLight = {
  number: 3,
  east: 300,
  north: 400,
  phase: 0.25,
  fogSignal: FOG_SIGNAL_RULES.signals.findIndex((s) => s.device === 'diaphone'),
};

/** The committee boat's muzzle, near the line the boat sails up to. */
const muzzle = { east: 45, north: 30 };

const fresh: Weather = {
  wind: 9.5,
  gusts: 0.12,
  speed: 3.2,
  sea: 1.2,
  whitecaps: 0.3,
  pitch: 5.5,
  period: 2,
  heave: 0.2,
};

export const SCENES: Record<string, Scene> = {
  calm: {
    weather: { wind: 1.5, gusts: 0.1, speed: 0.6, sea: 0.1, whitecaps: 0 },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
    },
  },
  harbour: {
    weather: { wind: 3, gusts: 0.12, speed: 1, sea: 0.2, whitecaps: 0 },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
      harbour.seconds = START + t;
      harbour.hour = 10 - 3 / HARBOUR_HOUR + t / HARBOUR_HOUR;
      engine.harbour(now, harbour, HARBOUR_HOUR);
    },
  },
  gentle: {
    weather: {
      wind: 5,
      gusts: 0.12,
      speed: 2,
      sea: 0.4,
      whitecaps: 0.05,
      pitch: 2.6,
      period: 1.6,
      heave: 0.1,
    },
    step(engine, t, now) {
      // A gybe.
      bed(engine, this.weather, t, now, 0, crossing('gybe', 19, 21, t));
      gentleLife(engine, t, now);
    },
  },
  fresh: {
    weather: fresh,
    step(engine, t, now) {
      // A tack: the sail luffs through it.
      const tacking = inCycle(t) > 12 && inCycle(t) < 15;
      bed(engine, this.weather, t, now, tacking ? 2 : 0, crossing('tack', 12.5, 14.5, t));
      freshLife(engine, t, now);
    },
  },
  gale: {
    weather: {
      wind: 18,
      gusts: 0.15,
      speed: 4.4,
      sea: 2.6,
      whitecaps: 0.8,
      pitch: 7.2,
      period: 2.4,
      heave: 0.4,
    },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
    },
  },
  fog: {
    weather: { wind: 4, gusts: 0.1, speed: 1.8, sea: 0.5, whitecaps: 0 },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
      engine.fogSignals(now, {
        seconds: START + t,
        listener,
        look: 0,
        lights: [fogLight],
        poorAt: () => true,
      });
    },
  },
  squall: {
    weather: {
      wind: 14,
      gusts: 0.2,
      speed: 3.8,
      sea: 1.5,
      whitecaps: 0.6,
      rain: 20,
      pitch: 6,
      period: 2.2,
      heave: 0.3,
    },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
      // A flash near, 700 m off, cracking; one far, 4 km off, rolling.
      if (at(t, 1)) {
        thunderFlashes.length = 0;
        thunderFlashes.push(flash(t, 400, 560, 11));
      }
      if (at(t, 9)) {
        thunderFlashes.push(flash(t, -2800, 2900, 12));
      }
      engine.thunder(now, { seconds: START + t, listener, look: 0, flashes: thunderFlashes });
    },
  },
  edge: {
    weather: {
      wind: 7,
      gusts: 0.12,
      speed: 2.8,
      sea: 1,
      whitecaps: 0.2,
      lip: 300,
      pitch: 3.5,
      period: 4,
    },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
    },
  },
  shore: {
    // Along a beach, the surf breaking on it.
    weather: {
      wind: 6,
      gusts: 0.12,
      speed: 2.4,
      sea: 0.9,
      whitecaps: 0.1,
      pitch: 3,
      period: 4,
      depth: 4,
    },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
    },
  },
  race: {
    weather: {
      wind: 6,
      gusts: 0.12,
      speed: 2.6,
      sea: 0.6,
      whitecaps: 0.1,
      pitch: 2.5,
      period: 3.5,
    },
    step(engine, t, now) {
      bed(engine, this.weather, t, now);
      // The start's signals, a gun each, the start's louder; then a finish:
      // the winner's gun, the crowd cheering the boat, and the player's own.
      for (const [moment, loud] of [
        [1, 1],
        [7, 1],
        [13, 1.6],
        [20, 1.6],
      ] as const) {
        if (at(t, moment)) {
          const r = gunReport(GUN, muzzle, listener, 0, loud, true);
          if (r !== null) {
            engine.gun(r);
          }
        }
      }
      if (at(t, 21)) {
        engine.cheer(cheerOf(CHEER, 6, false, true));
      }
      if (at(t, 26)) {
        engine.cheer(cheerOf(CHEER, 1, true, false));
      }
    },
  },
};

function flash(t: number, east: number, north: number, seed: number): ThunderFlash {
  return { tick: Math.round((START + t) * 30), east, north, sea: true, base: 900, seed };
}

const gentleLife = lifeOf([group('laugh', 70, 50, 3)]);
const freshLife = lifeOf([group('tern', -60, 90, 5), group('laugh', 120, -40, 9)]);

/** The scenes' names, as the tests list them. */
export const SCENE_NAMES = Object.keys(SCENES);
