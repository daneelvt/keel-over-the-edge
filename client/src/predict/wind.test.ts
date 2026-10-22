// SPDX-License-Identifier: AGPL-3.0-only

// The wind in WebAssembly: the module must give, bit for bit, the wind Go
// gave when it wrote internal/physics/testdata/wind.json; the spells a
// client holds are those the server's messages say; and a spell made here
// for a client with no server is the one the server would make.

import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { create } from '@bufbuild/protobuf';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { KeyframeSchema, SpellSchema, SystemKeySchema } from '../net/gen/keel/v1/game_pb';
import type { WeatherKeyframe } from '../net/messages';
import { keyframeRecord, spellRecord } from '../net/weather';
import { fromHex, loadTerrain, toHex } from './golden';
import { RECORDS, SIZES, WEATHER } from './layout.gen';
import { loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';
import {
  heldSpell,
  mix,
  newBoatWind,
  regimeIndex,
  regimeSpell,
  Spells,
  steadySpell,
  takesEffect,
} from './weather';
import { checkWind, loadWindCase, type WindCase, type WindFile } from './windcheck';

const wasm = new URL('./physics.wasm', import.meta.url);
const file = new URL('../../../internal/physics/testdata/wind.json', import.meta.url);
const P = RECORDS.spell;
const KNOT = 1852 / 3600;

let physics: Physics;
let wind: WindFile;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
  wind = JSON.parse(readFileSync(file, 'utf8')) as WindFile;
});

describe('the wind in the module', () => {
  test('is the server’s, bit for bit: the wind, the pressure, the gust field’s frame and the wave wind', () => {
    const report = checkWind(physics, wind);
    expect(report.problems).toEqual([]);
    // Nine weathers, two with weather systems and one a front crossing, of
    // 240 points of six values and a pressure, a frame of 18 and a wave
    // wind of two.
    expect(wind.cases.length).toBeGreaterThanOrEqual(9);
    expect(wind.cases.filter((c) => (c.keys ?? []).length > 0)).toHaveLength(2);
    expect(report.values).toBe(wind.cases.length * (240 * 7 + SIZES.gustFrame + 2));
  });

  test('a module that differs is told so', () => {
    const wrong = { cases: wind.cases.map((c) => ({ ...c, tick: c.tick + 1 })) };
    const report = checkWind(physics, wrong);
    expect(report.problems.length).toBe(20);
    expect(report.problems[0]).toMatch(
      /^trade, point 0, value 0: 0x[0-9a-f]{16}, the server has 0x/,
    );
  });

  test('before any spell is in play there is no wind', () => {
    physics.setSpells([]);
    const w = new Spells(physics).read(100, 30, 40, newBoatWind());
    expect(w).toEqual({
      speed: 0,
      from: 0,
      shadowSpeed: 0,
      shadowFrom: 0,
      meanSpeed: 0,
      meanFrom: 0,
      gust: 0,
      factor: 1,
    });
    physics.records.state[RECORDS.state.x] = 500;
    physics.windAt(100);
    expect(physics.records.env[RECORDS.env.windSpeed]).toBe(0);
  });

  test('the env a step sails in is the wind at the boat at the step’s tick', () => {
    const c = wind.cases[0];
    if (c === undefined) {
      throw new Error('no case');
    }
    loadWindCase(physics, c);
    const s = physics.records.state;
    s[RECORDS.state.x] = (c.origin[0] ?? 0) + (c.points[5]?.[0] ?? 0);
    s[RECORDS.state.y] = (c.origin[1] ?? 0) + (c.points[5]?.[1] ?? 0);
    physics.windAt(c.tick);
    const env = physics.records.env;
    const view = new DataView(new ArrayBuffer(8));
    const bits = (x: number): string => {
      view.setFloat64(0, x);
      return `0x${view.getBigUint64(0).toString(16).padStart(16, '0')}`;
    };
    expect(bits(env[RECORDS.env.windSpeed] ?? 0)).toBe(c.values[5]?.[0]);
    expect(bits(env[RECORDS.env.windFrom] ?? 0)).toBe(c.values[5]?.[1]);
  });
});

describe('the wind at the boat', () => {
  test('a hundred thousand calls neither allocate nor grow the memory', () => {
    const S = RECORDS.state;
    for (const name of ['trade', 'a change']) {
      const c = wind.cases.find((k) => k.name === name);
      if (c === undefined) {
        throw new Error(`wind.json has no case ${name}`);
      }
      loadWindCase(physics, c);
      const state = physics.records.state;
      const bytes = physics.memoryBytes;
      const allocations = physics.allocations;
      const calls = 100_000;
      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        state[S.x] = (c.origin[0] ?? 0) + (i % 97);
        state[S.y] = (c.origin[1] ?? 0) - (i % 89);
        physics.windAt(c.tick + i);
      }
      const each = ((performance.now() - start) / calls) * 1000;
      expect(physics.allocations).toBe(allocations);
      expect(physics.memoryBytes).toBe(bytes);
      // A call a step: it must cost little beside the step itself.
      expect(each).toBeLessThan(20);
      process.stdout.write(`wind: windAt in ${name} takes ${each.toFixed(3)} µs under Node\n`);
    }
  });
});

describe('the spells a client holds', () => {
  test('are those it is sent, the latest replacing what it held', () => {
    const spells = new Spells(physics);
    const a = steadySpell(physics, 5, 0, 0);
    const b = steadySpell(physics, 9, 1, 300);
    expect(spells.receive([Array.from(a)])).toBe(true);
    expect(spells.read(100, 0, 0, newBoatWind()).speed).toBeCloseTo(5, 12);
    expect(spells.receive([Array.from(a), Array.from(b)])).toBe(true);
    // The first blows until the second begins.
    expect(spells.read(299, 0, 0, newBoatWind()).speed).toBeCloseTo(5, 12);
    expect(spells.read(300, 0, 0, newBoatWind()).speed).toBeCloseTo(9, 12);
    expect(spells.version).toBe(2);
    // What is not spells is let go, and what was held kept.
    expect(spells.receive([[1, 2, 3]])).toBe(false);
    expect(spells.receive(new Array(WEATHER.spells + 1).fill(Array.from(a)))).toBe(false);
    expect(spells.spells).toHaveLength(2);
    spells.reset();
    expect(spells.read(300, 0, 0, newBoatWind()).speed).toBe(0);
  });

  test('a spell off the wire is the record it was sent from', () => {
    const s = create(SpellSchema, {
      begin: 727704000n,
      change: 18000,
      start: 727703999n,
      length: 432000n,
      regime: 1,
      steady: true,
      speed: 669,
      from: 65535,
      drift: -3641,
      gust: 1300,
      shift: [971, 485],
      period: [11880, 8940],
      phase: [7, 40000],
      across: 910,
      axis: 12345,
      axisPeriod: 648000,
      seed: 4294967295,
      pressure: 101325,
      front: true,
      toward: 16384,
      trough: 450,
      still: true,
    });
    const r = spellRecord(s);
    expect(r).toHaveLength(SIZES.spell);
    expect(r).toEqual([
      727704000, 18000, 727703999, 432000, 1, 1, 669, 65535, -3641, 1300, 971, 485, 11880, 8940, 7,
      40000, 910, 12345, 648000, 4294967295, 101325, 1, 16384, 450, 1,
    ]);
  });

  test('a keyframe off the wire is its systems’ records, by their slots', () => {
    const k = keyframeRecord(
      create(KeyframeSchema, {
        tick: 600n,
        systems: [
          create(SystemKeySchema, {
            slot: 3,
            kind: 2,
            seed: 4294967295,
            stage: 1,
            east: -60000,
            north: 72000,
            heading: 65535,
            speed: 257,
            strength: 4096,
            size: 3704,
            peak: 1131,
            depth: -1500,
          }),
        ],
      }),
    );
    expect(k.tick).toBe(600);
    expect(k.systems).toHaveLength(1);
    const [slot, v] = k.systems[0] ?? [0, []];
    expect(slot).toBe(3);
    expect(v).toHaveLength(SIZES.system);
    expect(v).toEqual([1, 2, 4294967295, 1, -60000, 72000, 65535, 257, 4096, 3704, 1131, -1500]);
  });

  test('keyframes join those held, each replacing any of its tick, the latest four kept', () => {
    const spells = new Spells(physics);
    const one = (tick: number, east: number): WeatherKeyframe => {
      const v = new Array<number>(SIZES.system).fill(0);
      v[RECORDS.system.on] = 1;
      v[RECORDS.system.east] = east;
      v[RECORDS.system.strength] = 4096;
      v[RECORDS.system.size] = 100;
      return { tick, systems: [[0, v]] };
    };
    expect(spells.receive([], [one(0, 1), one(300, 2), one(600, 3)])).toBe(true);
    expect(spells.receive(null, [one(600, 4), one(900, 5)])).toBe(true);
    expect(spells.keyframes.map((k) => [k.tick, k.systems[0]?.[RECORDS.system.east]])).toEqual([
      [0, 1],
      [300, 2],
      [600, 4],
      [900, 5],
    ]);
    expect(spells.receive(null, [one(1200, 6)])).toBe(true);
    expect(spells.keyframes.map((k) => k.tick)).toEqual([300, 600, 900, 1200]);
    expect(
      spells.receive(null, [{ tick: 1500, systems: [[20, new Array(SIZES.system).fill(0)]] }]),
    ).toBe(false);
    spells.reset();
  });
});

describe('a spell made with no server', () => {
  test('a steady wind is in the steps the server rounds a wind to', () => {
    const s = steadySpell(physics, 12 * KNOT, (20 * Math.PI) / 180, 1050);
    expect([s[P.begin], s[P.start], s[P.steady], s[P.speed], s[P.from], s[P.gust]]).toEqual([
      1050, 1050, 1, 617, 3641, 1000,
    ]);
  });

  test('a regime’s spell is drawn from its ranges, the same each time', () => {
    const trade = regimeIndex(catalog.weather, 'trade');
    expect(regimeIndex(catalog.weather, 'doldrums')).toBe(-1);
    const kind = catalog.weather.regimes[trade];
    const a = regimeSpell(physics, catalog.weather, trade, 7, 1852, 100, 5000, 9000);
    const b = regimeSpell(physics, catalog.weather, trade, 7, 1852, 100, 5000, 9000);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(
      Array.from(regimeSpell(physics, catalog.weather, trade, 8, 1852, 100, 5000, 9000)),
    ).not.toEqual(Array.from(a));
    const knots = ((a[P.speed] ?? 0) * 0.01) / KNOT;
    expect(knots).toBeGreaterThanOrEqual((kind?.wind.speed[0] ?? 0) - 0.01);
    expect(knots).toBeLessThanOrEqual((kind?.wind.speed[1] ?? 0) + 0.01);
    expect([a[P.begin], a[P.start], a[P.length], a[P.regime], a[P.from], a[P.steady]]).toEqual([
      5000,
      5000,
      9000,
      trade,
      100,
      0,
    ]);
    expect(a[P.gust]).toBe(Math.round((kind?.wind.gustFactor ?? 0) * 1000));
  });

  test('a held regime begins the second after next, from a direction of its own, with no drift', () => {
    expect(takesEffect(402)).toBe(450);
    expect(takesEffect(449)).toBe(480);
    expect(takesEffect(450)).toBe(510);
    const stormy = regimeIndex(catalog.weather, 'stormy');
    const s = heldSpell(physics, catalog.weather, stormy, 450);
    const number = (450 ^ 0x5bd1e995) >>> 0;
    expect([s[P.begin], s[P.start], s[P.length], s[P.change], s[P.drift], s[P.regime]]).toEqual([
      450,
      450,
      0,
      0,
      0,
      stormy,
    ]);
    expect(s[P.from]).toBe(mix(number ^ catalog.weather.week.seed) % WEATHER.turnSteps);
    // The recorded sail, which the server's tick sails too, has a held spell:
    // there the direction is checked against the server's own.
  });
});

describe('the wind in the land’s shelter', () => {
  interface LeeCase extends WindCase {
    open: string[][];
    a0: number;
    b0: number;
    from: string;
    grid: string[];
  }
  const lee = JSON.parse(
    readFileSync(new URL('../../../internal/physics/testdata/lee.json', import.meta.url), 'utf8'),
  ) as { terrain: string; cases: LeeCase[] };

  /** The module's wind at a case's points, as bits: by windPoint, and by windSample. */
  function windBits(c: LeeCase): { point: string[][]; sample: string[][] } {
    const points = c.points.flatMap((p) => [
      (c.origin[0] ?? 0) + (p[0] ?? 0),
      (c.origin[1] ?? 0) + (p[1] ?? 0),
    ]);
    const out = new Float64Array(points.length * 3);
    physics.windSample(points, out);
    const point: string[][] = [];
    const sample: string[][] = [];
    for (let i = 0; i < c.points.length; i++) {
      const w = physics.windPoint(points[2 * i] ?? 0, points[2 * i + 1] ?? 0);
      const W = RECORDS.wind;
      point.push(
        [w[W.speed], w[W.from], w[W.meanSpeed], w[W.meanFrom], w[W.gust], w[W.factor]].map((v) =>
          toHex(v ?? 0),
        ),
      );
      sample.push(Array.from(out.subarray(6 * i, 6 * i + 6), (v) => toHex(v)));
    }
    return { point, sample };
  }

  test('the module’s wind is Go’s, with the shelter on and with it off', () => {
    physics.prepareGround();
    loadTerrain(
      physics,
      new Uint8Array(
        gunzipSync(
          readFileSync(
            new URL(
              `../../../internal/physics/testdata/ground/${lee.terrain}.terrain`,
              import.meta.url,
            ),
          ),
        ),
      ),
    );
    expect(lee.cases.length).toBe(2);
    try {
      for (const c of lee.cases) {
        loadWindCase(physics, c);
        physics.shelterUse(true);
        const on = windBits(c);
        expect(on.point, c.name).toEqual(c.values);
        expect(on.sample, c.name).toEqual(c.values);
        physics.shelterUse(false);
        const off = windBits(c);
        expect(off.point, c.name).toEqual(c.open);
        expect(off.sample, c.name).toEqual(c.open);
      }
    } finally {
      physics.shelterUse(false);
    }
  });

  test('the shelter’s grid is Go’s shelter, cell by cell', () => {
    for (const c of lee.cases) {
      const grid = physics.shelterGrid(c.a0, c.b0, fromHex(c.from));
      expect(physics.shelterSide).toBe(64);
      expect(
        Array.from(grid, (v) => toHex(v)),
        c.name,
      ).toEqual(c.grid);
      // The hill casts a lee.
      expect(Math.min(...grid)).toBeLessThan(0.5);
    }
  });
});
