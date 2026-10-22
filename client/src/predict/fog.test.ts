// SPDX-License-Identifier: AGPL-3.0-only

// Visibility and lightning in WebAssembly: the module must give, bit for
// bit, the fog, the extinction, the visibility, the optical depth, the
// sources of extinction and the flashes Go gave when it wrote
// internal/physics/testdata/fog.json, so every phone draws and hears the
// weather the server judges; asking for them allocates nothing; and the
// sum the GPU makes of the sources (render/fog.ts) is the module's.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { airDepth } from '../render/fog';
import { type RecordValues, setRecord, spellOf, toHex } from './golden';
import { RECORDS, SIZES } from './layout.gen';
import { type Keyframe, loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';

const wasm = new URL('./physics.wasm', import.meta.url);
const file = new URL('../../../internal/physics/testdata/fog.json', import.meta.url);

interface FogCase {
  name: string;
  spells: RecordValues[];
  keys?: { tick: number; systems: Record<string, RecordValues> }[];
  records?: RecordValues[];
  tick: number;
  points: [number, number, number][];
  fog: string[];
  air: [string, string, string, string][];
  vis: string[];
  lines: [number, number, number, number, number, number][];
  depth: string[];
  origin: [number, number, number];
  fogSources: number;
  sources: Record<string, string>[] | null;
  slots: number[] | null;
  flashes: Record<string, string | string[]>[][] | null;
}

let physics: Physics;
let cases: FogCase[];

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
  cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: FogCase[] }).cases;
});

/** Puts a case's weather in the module, at its tick for drawing. */
function load(c: FogCase): void {
  physics.setSpells(c.spells.map(spellOf));
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
  physics.setRecords(
    (c.records ?? []).map((r) => {
      const v = new Float64Array(SIZES.systemRecord);
      setRecord(v, 'systemRecord', r);
      return v;
    }),
  );
  physics.windDrawAt(c.tick);
}

/** A run of records as bits, by the fields' names, an array's as a list. */
function records(
  v: Float64Array,
  name: 'airSource' | 'flash',
): Record<string, string | string[]>[] {
  const out: Record<string, string | string[]>[] = [];
  const fields = RECORDS[name] as Record<string, number>;
  const names = Object.keys(fields);
  for (let o = 0; o + SIZES[name] <= v.length; o += SIZES[name]) {
    const r: Record<string, string | string[]> = {};
    names.forEach((field, k) => {
      const at = fields[field] ?? 0;
      const next = k + 1 < names.length ? (fields[names[k + 1] as string] ?? 0) : SIZES[name];
      if (next - at > 1) {
        r[field] = [...v.subarray(o + at, o + next)].map(toHex);
      } else {
        r[field] = toHex(v[o + at] ?? Number.NaN);
      }
    });
    out.push(r);
  }
  return out;
}

describe('visibility and lightning in the module', () => {
  test('are the server’s, bit for bit', () => {
    expect(cases.length).toBeGreaterThanOrEqual(4);
    let flashes = 0;
    for (const c of cases) {
      load(c);
      expect(
        c.points.map(([e, n, h]) => toHex(physics.airAt(e, n, h)[1] ?? Number.NaN)),
        `${c.name}: the fog`,
      ).toEqual(c.fog);
      expect(
        c.points.map(([e, n, h]) => [...physics.airAt(e, n, h)].map(toHex)),
        `${c.name}: the air`,
      ).toEqual(c.air);
      expect(
        c.points.map(([e, n]) => toHex(physics.visibilityAt(e, n))),
        `${c.name}: the visibility`,
      ).toEqual(c.vis);
      expect(
        c.lines.map((l) => toHex(physics.opticalDepth(...l))),
        `${c.name}: the optical depth`,
      ).toEqual(c.depth);
      const s = physics.airSources(c.origin[0], c.origin[1], c.origin[2]);
      expect(s.fog, `${c.name}: its fog banks`).toBe(c.fogSources);
      expect(records(s.records, 'airSource'), `${c.name}: the sources`).toEqual(c.sources ?? []);
      (c.slots ?? []).forEach((slot, k) => {
        expect(records(physics.flashesAt(slot), 'flash'), `${c.name}: slot ${slot}`).toEqual(
          c.flashes?.[k] ?? [],
        );
        flashes += c.flashes?.[k]?.length ?? 0;
      });
    }
    expect(flashes).toBeGreaterThan(5);
  });

  test('the GPU’s sum of the sources is the module’s optical depth', () => {
    let worst = 0;
    let fogged = 0;
    for (const c of cases.slice(0, 2)) {
      load(c);
      const got = physics.airSources(c.origin[0], c.origin[1], 9000);
      const R = RECORDS.airSource;
      const sources = [];
      for (let o = 0; o + SIZES.airSource <= got.records.length; o += SIZES.airSource) {
        const v = (k: keyof typeof R): number => got.records[o + R[k]] ?? 0;
        sources.push({
          east: v('east'),
          north: v('north'),
          sin: v('sin'),
          cos: v('cos'),
          along: v('along'),
          across: v('across'),
          invHeight: v('invHeight'),
          sigma: v('sigma'),
          top: v('top'),
        });
      }
      const clear = (3.912 / (catalog.world.lights.clearAir * 1852)) * 1;
      for (const l of c.lines) {
        // Inside the mist band's inner edge, where the module adds no mist.
        if (Math.hypot(l[0], l[1]) > 7000 || Math.hypot(l[3], l[4]) > 7000) {
          continue;
        }
        const length = Math.hypot(l[3] - l[0], l[4] - l[1], l[5] - l[2]);
        const module = physics.opticalDepth(...l) - clear * length;
        const gpu = airDepth(sources, ...l);
        worst = Math.max(worst, Math.abs(gpu - module) / Math.max(1, module));
        fogged += module > 0.5 ? 1 : 0;
      }
    }
    expect(fogged).toBeGreaterThan(5);
    expect(worst).toBeLessThan(1e-4);
  });

  test('asking for them allocates nothing and grows no memory', () => {
    const c = cases.find((x) => x.name === 'lightning') as FogCase;
    load(c);
    const ask = (): void => {
      physics.windDrawAt(c.tick + 7);
      physics.opticalDepth(0, 0, 2, 2000, 1000, 40);
      physics.visibilityAt(10, 20);
      physics.visibilityAtTick(10, 20, c.tick + 900);
      physics.airAt(10, 20, 2);
      physics.airSources(0, 0, 8000);
      physics.flashesAt(c.slots?.[0] ?? 0);
    };
    ask();
    const allocations = physics.allocations;
    const bytes = physics.memoryBytes;
    for (let i = 0; i < 20; i++) {
      ask();
    }
    expect(physics.allocations).toBe(allocations);
    expect(physics.memoryBytes).toBe(bytes);
    const fogCase = cases[0] as FogCase;
    load(fogCase);
    const time = (what: string, calls: number, f: () => void): number => {
      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        f();
      }
      const each = (performance.now() - start) / calls;
      process.stdout.write(`fog: ${what} takes ${(each * 1000).toFixed(3)} µs under Node\n`);
      return each;
    };
    const depth = time('the optical depth through three fog banks', 100_000, () =>
      physics.opticalDepth(-2000, 300, 2, 1500, -200, 40),
    );
    const vis = time('the visibility at a point', 100_000, () => physics.visibilityAt(100, 200));
    time('the sources near the camera', 20_000, () => physics.airSources(0, 0, 8000));
    load(c);
    time('a slot’s flashes', 20_000, () => physics.flashesAt(c.slots?.[3] ?? 0));
    expect(depth).toBeLessThan(0.001 * (process.env.CI ? 4 : 1));
    expect(vis).toBeLessThan(0.001 * (process.env.CI ? 4 : 1));
  });
});
