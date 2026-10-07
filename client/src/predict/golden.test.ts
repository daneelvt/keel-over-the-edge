// SPDX-License-Identifier: AGPL-3.0-only

// The physics golden tests in WebAssembly: the module built by
// go run ./tools/physics must give, bit for bit, what Go gave when it wrote
// internal/physics/testdata/golden.json.

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { checkGolden, fromHex, type GoldenFile, type ScenarioFile, toHex } from './golden';
import { LAYOUT_VERSION } from './layout.gen';
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
    expect(report.scenarios).toBeGreaterThanOrEqual(4);
    expect(report.values).toBeGreaterThanOrEqual(6 * 256);
  });
});

describe('memory', () => {
  test('ten thousand steps neither allocate nor grow the memory', () => {
    const r = physics.records;
    r.params.set([150, 300, 7, 3, 60, 900, 120, 1.5]);
    r.state.set([0, 0, 0.5, 1, 0, 0]);
    r.env.set([8, 0.3]);
    const bytes = physics.memoryBytes;
    const allocations = physics.allocations;
    for (let i = 0; i < 10_000; i++) {
      physics.records.control.set([Math.sign(Math.sin(i / 300)), 0.9]);
      physics.step();
    }
    expect(physics.memoryBytes).toBe(bytes);
    expect(physics.allocations).toBe(allocations);
    expect(Number.isFinite(physics.records.state[0])).toBe(true);
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
