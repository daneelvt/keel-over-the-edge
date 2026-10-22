// SPDX-License-Identifier: AGPL-3.0-only

// Clouds and rain in WebAssembly: the module must give, bit for bit, the
// heaped clouds, the sheets, the rain and the cumulus Go gave when it wrote
// internal/physics/testdata/clouds.json, so every phone draws the sky the
// server judges; and asking for them allocates nothing.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type RecordValues, setRecord, spellOf, toHex } from './golden';
import { RECORDS, SIZES } from './layout.gen';
import { type Keyframe, loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';
import { Spells } from './weather';

const wasm = new URL('./physics.wasm', import.meta.url);
const file = new URL('../../../internal/physics/testdata/clouds.json', import.meta.url);

interface CloudCase {
  name: string;
  spells: RecordValues[];
  keys?: { tick: number; systems: Record<string, RecordValues> }[];
  coming: RecordValues;
  caps?: [number, number, number][];
  tick: number;
  origin: [number, number];
  reach: number;
  sun: number;
  clouds: Record<string, string>[] | null;
  cumulus: Record<string, string>[] | null;
  i0: number;
  j0: number;
  n: number;
  grid: string[];
  points: [number, number][];
  sheets: [string, string, string][];
  rain: string[];
}

let physics: Physics;
let cases: CloudCase[];

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather);
  cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: CloudCase[] }).cases;
});

/** Puts a case's weather in the module, at its tick for drawing. */
function load(c: CloudCase): void {
  physics.setSpells(c.spells.map(spellOf));
  const coming = new Float64Array(SIZES.coming);
  setRecord(coming, 'coming', c.coming);
  physics.setComing(coming);
  physics.setKeyframes(
    (c.keys ?? []).map((k): Keyframe => {
      const systems: Float64Array[] = [];
      for (const [slot, values] of Object.entries(k.systems)) {
        const s = new Float64Array(SIZES.system);
        setRecord(s, 'system', values);
        systems[Number(slot)] = s;
      }
      return { tick: k.tick, systems };
    }),
  );
  physics.setCaps(c.caps ?? []);
  physics.windDrawAt(c.tick);
}

/** A run of records as bits, by the fields' names. */
function records(v: Float64Array, name: 'cloud' | 'cumulus'): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let o = 0; o + SIZES[name] <= v.length; o += SIZES[name]) {
    const r: Record<string, string> = {};
    for (const [field, i] of Object.entries(RECORDS[name])) {
      r[field] = toHex(v[o + i] ?? Number.NaN);
    }
    out.push(r);
  }
  return out;
}

describe('clouds and rain in the module', () => {
  test('are the server’s, bit for bit: the heaped clouds, the cumulus, the sheets and the rain', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    let heaped = 0;
    let cumulus = 0;
    for (const c of cases) {
      load(c);
      expect(records(physics.cloudsAt(), 'cloud'), c.name).toEqual(c.clouds ?? []);
      expect(
        records(physics.cumulusAt(c.origin[0], c.origin[1], c.reach, c.sun), 'cumulus'),
        c.name,
      ).toEqual(c.cumulus ?? []);
      heaped += (c.clouds ?? []).length;
      cumulus += (c.cumulus ?? []).length;
      expect([...physics.sheetGrid(c.i0, c.j0, c.n)].map(toHex), c.name).toEqual(c.grid);
      const sheets = c.points.map(([e, n]) => {
        const s = physics.sheetAt(e, n);
        return [s[RECORDS.sheets.cirrus], s[RECORDS.sheets.middle], s[RECORDS.sheets.low]].map(
          (x) => toHex(x ?? Number.NaN),
        );
      });
      expect(sheets, c.name).toEqual(c.sheets);
      expect(
        c.points.map(([e, n]) => toHex(physics.rainAt(e, n))),
        c.name,
      ).toEqual(c.rain);
      const sampled = physics.rainSample(c.points.flat(), new Float64Array(c.points.length));
      expect([...sampled].map(toHex), c.name).toEqual(c.rain);
    }
    expect(heaped).toBeGreaterThanOrEqual(3);
    expect(cumulus).toBeGreaterThanOrEqual(5);
  });

  test('a coming front held by the spells the client was sent is the same front', () => {
    const c = cases.find((x) => x.name === 'a front coming') as CloudCase;
    load(c);
    const want = [...physics.sheetGrid(c.i0, c.j0, c.n)];
    // The same, taken through Spells as the net worker hands it.
    const spells = new Spells(physics);
    const coming = new Float64Array(SIZES.coming);
    setRecord(coming, 'coming', c.coming);
    spells.receive(c.spells.map(spellOf), [], coming);
    physics.windDrawAt(c.tick);
    expect([...physics.sheetGrid(c.i0, c.j0, c.n)]).toEqual(want);
    expect(want.some((x) => x > 0)).toBe(true);
    // And without it, none of its sheets.
    spells.receive(null, [], new Float64Array(SIZES.coming));
    physics.windDrawAt(c.tick);
    expect([...physics.sheetGrid(c.i0, c.j0, c.n)].some((x) => x > 0)).toBe(false);
  });

  test('asking for them allocates nothing and grows no memory', () => {
    const c = cases.find((x) => x.name === 'systems') as CloudCase;
    load(c);
    const points = c.points.flat();
    const out = new Float64Array(c.points.length);
    const ask = (): void => {
      physics.windDrawAt(c.tick + 7);
      physics.cloudsAt();
      physics.cumulusAt(c.origin[0], c.origin[1], c.reach, c.sun);
      physics.sheetGrid(c.i0, c.j0, c.n);
      physics.sheetAt(10, 20);
      physics.rainAt(10, 20);
      physics.rainSample(points, out);
      physics.rainVisibility(12, 8000);
    };
    ask();
    const allocations = physics.allocations;
    const bytes = physics.memoryBytes;
    for (let i = 0; i < 20; i++) {
      ask();
    }
    expect(physics.allocations).toBe(allocations);
    expect(physics.memoryBytes).toBe(bytes);
    // What the sky's weather asks a second costs little: the grid once,
    // the clouds and the cumulus five times, the rain four.
    const time = (what: string, calls: number, f: () => void): number => {
      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        f();
      }
      const each = (performance.now() - start) / calls;
      process.stdout.write(`clouds: ${what} takes ${(each * 1000).toFixed(2)} µs under Node\n`);
      return each;
    };
    const grid = time('a 48 × 48 sheet grid', 200, () => physics.sheetGrid(c.i0, c.j0, 48));
    time('the heaped clouds', 20_000, () => physics.cloudsAt());
    const fair = time('the cumulus within 3.5 km', 2_000, () => physics.cumulusAt(0, 0, 3500, 0.5));
    time('the rain at a point', 100_000, () => physics.rainAt(10, 20));
    time('the sheets at a point', 100_000, () => physics.sheetAt(10, 20));
    // Under a third of a millisecond each refresh, on the machine the tests run on.
    expect(grid).toBeLessThan(0.3 * (process.env.CI ? 4 : 1));
    expect(fair).toBeLessThan(0.3 * (process.env.CI ? 4 : 1));
  });
});
