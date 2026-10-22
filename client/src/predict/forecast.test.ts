// SPDX-License-Identifier: AGPL-3.0-only

// The forecast in WebAssembly: the module must make, bit for bit, the
// forecast and the gale scan Go made when it wrote
// internal/physics/testdata/forecast.json from the same records, so the
// sandbox issues the server's forecast; and the wind, its typical gust and
// the pressure it gives between the steps must be Go's too; and none of it
// allocates.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { type RecordValues, setRecord, spellOf, toHex } from './golden';
import { RECORDS, SIZES } from './layout.gen';
import { loadPhysics, type Physics } from './physics';
import { preparePhysics } from './predictor';

const wasm = new URL('./physics.wasm', import.meta.url);
const file = new URL('../../../internal/physics/testdata/forecast.json', import.meta.url);

type Bits = Record<string, string | string[]>;

interface ForecastCase {
  name: string;
  issue: number;
  end: number;
  spells: RecordValues[];
  records: RecordValues[] | null;
  head: Bits;
  forecastSpells: Bits[] | null;
  systems: Bits[] | null;
  gales: Bits[];
  galesOn: number[] | null;
  ticks: number[];
  points: [number, number][];
  wind: string[][];
  typical: string[][];
  pressure: string[][];
}

let physics: Physics;
let cases: ForecastCase[];

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather, catalog.world);
  cases = (JSON.parse(readFileSync(file, 'utf8')) as { cases: ForecastCase[] }).cases;
});

/** A run of records as bits, by the fields' names, an array's as a list. */
function bits(
  v: Float64Array,
  name: 'forecastHead' | 'spell' | 'forecastSystem' | 'galeStep',
  n: number,
): Bits[] {
  const out: Bits[] = [];
  const fields = RECORDS[name] as Record<string, number>;
  const names = Object.keys(fields);
  for (let i = 0; i < n; i++) {
    const o = i * SIZES[name];
    const r: Bits = {};
    names.forEach((field, k) => {
      const at = fields[field] ?? 0;
      const next = k + 1 < names.length ? (fields[names[k + 1] as string] ?? 0) : SIZES[name];
      r[field] =
        next - at > 1
          ? [...v.subarray(o + at, o + next)].map(toHex)
          : toHex(v[o + at] ?? Number.NaN);
    });
    out.push(r);
  }
  return out;
}

/** Makes a case's forecast in the module, from its spells and records. */
function make(c: ForecastCase): void {
  physics.setSpells(c.spells.map(spellOf));
  physics.setRecords(
    (c.records ?? []).map((r) => {
      const v = new Float64Array(SIZES.systemRecord);
      setRecord(v, 'systemRecord', r);
      return v;
    }),
  );
  physics.forecastMake(c.issue, c.end);
}

describe('the forecast in the module', () => {
  test('is the server’s, bit for bit', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      make(c);
      const f = physics.forecast;
      const H = RECORDS.forecastHead;
      expect(bits(f.head, 'forecastHead', 1)[0], `${c.name}: its head`).toEqual(c.head);
      const ns = f.head[H.nSpells] ?? 0;
      const nsys = f.head[H.nSystems] ?? 0;
      expect(bits(f.spells, 'spell', ns), `${c.name}: its spells`).toEqual(c.forecastSpells ?? []);
      expect(bits(f.systems, 'forecastSystem', nsys), `${c.name}: its systems`).toEqual(
        c.systems ?? [],
      );
      const steps = f.head[H.steps] ?? 0;
      expect(bits(physics.galeScan(), 'galeStep', steps), `${c.name}: its gales`).toEqual(c.gales);
    }
  });

  test('gives the server’s wind, gusts and pressure between its steps', () => {
    for (const c of cases) {
      make(c);
      const points = c.points.flat();
      const typical = new Float64Array(3 * c.points.length);
      c.ticks.forEach((tick, i) => {
        physics.forecastAt(tick);
        physics.windDrawAt(tick);
        const wind: string[] = [];
        const pressure: string[] = [];
        for (const [e, n] of c.points) {
          const w = physics.windPoint(e, n);
          const W = RECORDS.wind;
          wind.push(
            ...[w[W.speed], w[W.from], w[W.meanSpeed], w[W.meanFrom]].map((x) =>
              toHex(x ?? Number.NaN),
            ),
          );
          pressure.push(toHex(physics.pressure(e, n)));
        }
        expect(wind, `${c.name} at ${tick}: the wind`).toEqual(c.wind[i]);
        expect(pressure, `${c.name} at ${tick}: the pressure`).toEqual(c.pressure[i]);
        expect(
          [...physics.typicalSample(points, typical)].map(toHex),
          `${c.name} at ${tick}: the gusts`,
        ).toEqual(c.typical[i]);
      });
    }
  });

  test('a gale’s points are the scan’s at a step', () => {
    const c = cases[0] as ForecastCase;
    make(c);
    const steps = physics.galeScan();
    const last = (physics.forecast.head[RECORDS.forecastHead.steps] ?? 1) - 1;
    const tick = c.issue + last * (physics.forecast.head[RECORDS.forecastHead.step] ?? 0);
    const { on, gale } = physics.galeAt(tick);
    const set: number[] = [];
    on.forEach((v, i) => {
      if (v !== 0) {
        set.push(i);
      }
    });
    expect(set).toEqual(c.galesOn ?? []);
    expect(toHex(gale[RECORDS.galeStep.points] ?? 0)).toBe(
      toHex(steps[last * SIZES.galeStep + RECORDS.galeStep.points] ?? 0),
    );
  });

  test('allocates nothing and grows no memory', () => {
    const c = cases[0] as ForecastCase;
    const ask = (): void => {
      make(c);
      physics.galeScan();
      physics.forecastAt(c.issue + 1234);
      physics.windDrawAt(c.issue + 1234);
      physics.galeAt(c.issue + 1234);
      physics.typicalSample([0, 0, 100, 200], new Float64Array(6));
    };
    ask();
    const allocations = physics.allocations;
    const bytes = physics.memoryBytes;
    for (let i = 0; i < 10; i++) {
      ask();
    }
    expect(physics.allocations).toBe(allocations);
    expect(physics.memoryBytes).toBe(bytes);
    const time = (what: string, calls: number, f: () => void): number => {
      const start = performance.now();
      for (let i = 0; i < calls; i++) {
        f();
      }
      const each = (performance.now() - start) / calls;
      process.stdout.write(`forecast: ${what} takes ${(each * 1000).toFixed(1)} µs under Node\n`);
      return each;
    };
    time('a forecast', 2000, () => physics.forecastMake(c.issue, 0));
    time('its gale scan', 20, () => physics.galeScan());
  });
});
