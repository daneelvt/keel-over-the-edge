// SPDX-License-Identifier: AGPL-3.0-only

// The physics golden tests in WebAssembly: the module built by
// go run ./tools/physics must give, bit for bit, what Go gave when it wrote
// internal/physics/testdata/golden.json.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { checkGolden, fromHex, type GoldenFile, type ScenarioFile, toHex } from './golden';
import { LAYOUT_VERSION, RECORDS } from './layout.gen';
import { writeParams } from './params.gen';
import { loadPhysics, type Physics } from './physics';

const wasm = new URL('./physics.wasm', import.meta.url);
const testdata = new URL('../../../internal/physics/testdata/', import.meta.url);

function readJSON<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, testdata), 'utf8')) as T;
}

let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
});

describe('golden', () => {
  test('the golden file is for this layout', () => {
    const golden = readJSON<GoldenFile>('golden.json');
    expect(golden.layout).toBe(`0x${LAYOUT_VERSION.toString(16).padStart(8, '0')}`);
  });

  test('every scenario and function value matches the server bit for bit', async () => {
    const report = await checkGolden(
      physics,
      readJSON<ScenarioFile>('scenarios.json'),
      readJSON<GoldenFile>('golden.json'),
    );
    expect(report.problems).toEqual([]);
    expect(report.scenarios).toBeGreaterThanOrEqual(13);
    expect(report.values).toBeGreaterThanOrEqual(6 * 256);
  });
});

describe('memory', () => {
  test('ten thousand steps neither allocate nor grow the memory', () => {
    const r = physics.records;
    for (const v of Object.values(r)) {
      v.fill(0);
    }
    writeParams(r.params, catalog.boats[0].physics);
    physics.prepare();
    r.state[RECORDS.state.surge] = 2;
    r.env.set([8, 0.3]);
    const bytes = physics.memoryBytes;
    const allocations = physics.allocations;
    for (let i = 0; i < 10_000; i++) {
      physics.records.control.set([Math.sign(Math.sin(i / 300)), (i % 900) / 900]);
      physics.step();
    }
    expect(physics.memoryBytes).toBe(bytes);
    expect(physics.allocations).toBe(allocations);
    for (const v of physics.records.state) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('params', () => {
  test("writeParams writes the catalog's values exactly as the Go golden tests read them", () => {
    const want = new Float64Array(physics.records.params.length);
    const scenarios = readJSON<ScenarioFile>('scenarios.json');
    const lengths: Record<string, number> = {};
    for (const [name, value] of Object.entries(scenarios.params)) {
      const index = (RECORDS.params as Record<string, number>)[name];
      expect(index, name).toBeDefined();
      if (Array.isArray(value)) {
        want.set(value, index);
        lengths[name] = value.length;
      } else {
        want[index ?? 0] = value;
      }
    }
    const got = new Float64Array(want.length);
    writeParams(got, catalog.boats[0].physics);
    expect(new Uint8Array(got.buffer)).toEqual(new Uint8Array(want.buffer));
  });
});

describe('hex', () => {
  test('round-trips the bits of awkward values', () => {
    for (const x of [
      0,
      -0,
      1,
      -1.5,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(Object.is(fromHex(toHex(x)), x)).toBe(true);
    }
    expect(toHex(1)).toBe('0x3ff0000000000000');
  });
});
