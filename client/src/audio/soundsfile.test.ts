// SPDX-License-Identifier: AGPL-3.0-only

// What the phone plays is what the server says it plays: for every
// listener of internal/lookout/testdata/sounds.json the falls, the loudest
// waterfall's roar and the lapping as loud and from the same way, and the
// same booms, calls, bells, gulls, blows, blasts and thunder, heard at the
// same times, as loud, from the same bearings.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import type { FogSignalDevice } from '../catalog/types.gen';
import { wavePeriod } from '../render/features';
import { HOURS } from '../sky/skytime';
import { type Call, FEATURE_RECIPES, type FeaturesInput, featureEvents, roarNow } from './features';
import { FOG_SIGNAL_RECIPES, FOG_SIGNAL_RULES, fogSignalEvents, poorBy } from './fogsignals';
import { type At, HARBOUR_RECIPES, type HarbourInput, harbourEvents, lappingNow } from './harbour';
import { THUNDER_RECIPE, THUNDER_RULE, thunderEvents } from './thunder';
import { newTargets, RECIPES, soundTargets } from './voices';

interface Heard {
  kind: string;
  degrees: number;
  at: number;
  level: number;
  delay?: number;
  length?: number;
  crack?: boolean;
  device?: FogSignalDevice;
  light?: number;
  call?: Call;
}

interface SoundsFile {
  secondsPerHour: number;
  cases: {
    name: string;
    from: number;
    to: number;
    seconds: number;
    east: number;
    north: number;
    day: boolean;
    seaHeight: number;
    lip: number;
    falling: boolean;
    endNear: number;
    features:
      | { site: string; east: number; north: number; drop: number; seed: number; call: Call }[]
      | null;
    harbour: {
      inPort: boolean;
      town: boolean;
      nearTown: number;
      bell: At | null;
      yard: At | null;
      quay: At | null;
      hour: number;
    };
    weather: boolean;
    lights:
      | {
          number: number;
          east: number;
          north: number;
          phase: number;
          signal: number;
          visibility: number;
        }[]
      | null;
    flashes:
      | { tick: number; east: number; north: number; sea: boolean; base: number; seed: number }[]
      | null;
    sounds: Heard[];
  }[];
}

const file = JSON.parse(
  readFileSync(new URL('../../../internal/lookout/testdata/sounds.json', import.meta.url), 'utf8'),
) as SoundsFile;

type Case = SoundsFile['cases'][number];

/** A sound as the phone has it: its kind as the file names it, when, how loud, panned how. */
interface Played {
  kind: string;
  at: number;
  level: number;
  pan: number;
  delay?: number;
  length?: number;
  crack?: boolean;
  device?: string;
  light?: number;
  call?: string;
}

/** Everything the phone plays for a case's listener, looking along look, in the order it finds them. */
function played(c: Case, look: number): Played[] {
  const listener = { east: c.east, north: c.north };
  const out: Played[] = [];
  // The falls, by the sound's own targets.
  const t = soundTargets(
    RECIPES,
    {
      apparentWind: 0,
      speed: 0,
      throughWater: 0,
      seaHeight: c.seaHeight,
      whitecaps: 0,
      luffing: 0,
      time: c.seconds,
      lip: c.lip,
      lipPan: Math.sin(Math.atan2(c.east, c.north) - look),
      falling: c.falling,
      endNear: c.endNear,
    },
    newTargets(),
  );
  out.push({ kind: 'falls', at: c.seconds, level: t.fallsLevel, pan: t.fallsPan });
  const features = c.features ?? [];
  const fx: FeaturesInput = {
    seconds: c.seconds,
    day: c.day,
    listener,
    look,
    seaHeight: c.seaHeight,
    period: wavePeriod(c.seaHeight),
    falls: features
      .filter((f) => f.site === 'waterfall')
      .map((f) => ({ east: f.east, north: f.north, drop: f.drop })),
    blowholes: features
      .filter((f) => f.site === 'blowhole')
      .map((f) => ({ east: f.east, north: f.north, seed: f.seed })),
    colonies: features
      .filter((f) => f.site === 'colony')
      .map((f) => ({ east: f.east, north: f.north, seed: f.seed, call: f.call })),
  };
  const roar = roarNow(FEATURE_RECIPES.waterfall, fx);
  out.push({ kind: 'roar', at: c.seconds, ...roar });
  const h = c.harbour;
  const hx: HarbourInput = {
    seconds: c.seconds,
    hour: h.hour,
    day: c.day,
    listener,
    look,
    inPort: h.inPort,
    nearTown: h.town ? h.nearTown : Number.POSITIVE_INFINITY,
    bell: h.bell,
    yard: h.yard,
    quay: h.quay,
    seaHeight: c.seaHeight,
    period: 4,
  };
  out.push({ kind: 'lapping', at: c.seconds, ...lappingNow(HARBOUR_RECIPES.lapping, hx) });
  for (const e of featureEvents(FEATURE_RECIPES, fx, c.from, c.to)) {
    out.push({
      kind: e.kind === 'boom' ? 'boom' : 'call',
      at: e.at,
      level: e.level,
      pan: e.pan,
      ...(e.kind === 'boom' ? {} : { call: e.kind }),
    });
  }
  for (const e of harbourEvents(HARBOUR_RECIPES, hx, c.from, c.to, file.secondsPerHour)) {
    out.push({ kind: e.kind, at: e.at, level: e.level, pan: e.pan });
  }
  if (c.weather) {
    const lights = c.lights ?? [];
    const poorAt = poorBy(FOG_SIGNAL_RULES.rule, (e, n) => {
      const l = lights.find((k) => k.east === e && k.north === n);
      return l === undefined ? Number.POSITIVE_INFINITY : l.visibility;
    });
    const fog = fogSignalEvents(
      FOG_SIGNAL_RECIPES,
      FOG_SIGNAL_RULES,
      {
        seconds: c.seconds,
        listener,
        look,
        lights: lights.map((l) => ({ ...l, fogSignal: l.signal })),
        poorAt,
      },
      c.from,
      c.to,
    );
    for (const e of fog) {
      out.push({
        kind: 'fog',
        at: e.at,
        level: e.level,
        pan: e.pan,
        delay: e.at - e.start,
        length: e.length,
        device: e.device,
        light: e.light,
      });
    }
  }
  const thunder = thunderEvents(
    THUNDER_RECIPE,
    THUNDER_RULE,
    { seconds: c.seconds, listener, look, flashes: c.flashes ?? [] },
    c.from,
    c.to,
  );
  for (const e of thunder) {
    out.push({
      kind: 'thunder',
      at: e.at,
      level: e.level,
      pan: e.pan,
      delay: e.at - (e.at - e.distance / THUNDER_RULE.speed),
      length: e.length,
      crack: e.crack,
    });
  }
  // The phone plays nothing that has no level.
  return out.filter((p) => p.level > 0);
}

/** Whether two numbers agree within the last bits the two sides' sines differ by. */
const near = (a: number, b: number | undefined): boolean =>
  Math.abs(a - (b ?? Number.NaN)) <= 1e-9 * Math.max(1, Math.abs(a));

describe('the sounds about the boat', () => {
  test('are the catalog’s', () => {
    expect(file.secondsPerHour).toBe((catalog.sky.day * 60) / HOURS);
  });

  test('are the server’s, heard alike from the same ways', () => {
    expect(file.cases.length).toBeGreaterThan(10);
    for (const c of file.cases) {
      // Looking north the pan is the bearing's sine; looking east, less its cosine.
      const north = played(c, 0);
      const east = played(c, Math.PI / 2);
      expect(
        north.map((p) => p.kind),
        c.name,
      ).toEqual(c.sounds.map((s) => s.kind));
      north.forEach((p, k) => {
        const s = c.sounds[k] as Heard;
        const label = `${c.name}: ${s.kind} ${k}`;
        expect(near(p.at, s.at), label).toBe(true);
        expect(near(p.level, s.level), label).toBe(true);
        expect(near(p.delay ?? 0, s.delay ?? 0) && near(p.length ?? 0, s.length ?? 0), label).toBe(
          true,
        );
        expect([p.crack ?? false, p.device, p.light ?? 0, p.call], label).toEqual([
          s.crack ?? false,
          s.device,
          s.light ?? 0,
          s.call,
        ]);
        // The falls are all about a boat going over them.
        if (s.kind === 'falls' && c.falling) {
          expect(p.pan, label).toBe(0);
          return;
        }
        const b = (Math.atan2(p.pan, -(east[k]?.pan ?? Number.NaN)) * 180) / Math.PI;
        const off = Math.abs(((((b - s.degrees) % 360) + 540) % 360) - 180);
        expect(off, label).toBeLessThan(1e-6);
      });
    }
  });
});
