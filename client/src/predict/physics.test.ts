// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { RECORDS } from './layout.gen';
import { loadPhysics, Physics } from './physics';

const wasm = new URL('./physics.wasm', import.meta.url);
let bytes: Uint8Array<ArrayBuffer>;

beforeAll(() => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  bytes = new Uint8Array(readFileSync(wasm));
});

describe('loadPhysics', () => {
  test('streams a module served as application/wasm', async () => {
    const res = new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
    const physics = await loadPhysics(res);
    expect(physics.records.state.length).toBe(Object.keys(RECORDS.state).length);
  });

  test('compiles a module served with another type', async () => {
    const res = new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    await expect(loadPhysics(Promise.resolve(res))).resolves.toBeInstanceOf(Physics);
  });

  test('fails on an error answer', async () => {
    await expect(loadPhysics(new Response('gone', { status: 404 }))).rejects.toThrow(/404/);
  });

  test('refuses a module that imports from its host', async () => {
    // (module (import "env" "f" (func)))
    const importing = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x02,
      0x09, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
    ]);
    await expect(loadPhysics(importing)).rejects.toThrow(/imports/);
  });
});

describe('Physics', () => {
  test('refuses a module with another layout', async () => {
    const real = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
    const exports = { ...real.exports, layout: () => 0x12345678 };
    expect(() => new Physics({ exports } as WebAssembly.Instance)).toThrow(/layout 0x12345678/);
  });

  test('makes its views again when the memory grows', async () => {
    const physics = await loadPhysics(bytes);
    const before = physics.records.state;
    before[RECORDS.state.x] = 1234.5;
    physics.memory.grow(1);
    expect(before.length).toBe(0); // the old buffer is detached
    const after = physics.records.state;
    expect(after === before).toBe(false);
    expect(after[RECORDS.state.x]).toBe(1234.5);
  });

  test('keeps its views while the memory stays', async () => {
    const physics = await loadPhysics(bytes);
    expect(physics.records).toBe(physics.records);
  });

  test('steps the state through its records', async () => {
    const physics = await loadPhysics(bytes);
    const r = physics.records;
    r.params.set([150, 300, 7, 3, 60, 900, 120, 1.5]);
    r.env[RECORDS.env.windSpeed] = 6;
    r.env[RECORDS.env.windFrom] = Math.PI / 2;
    r.control[RECORDS.control.trim] = 1;
    for (let i = 0; i < 90; i++) {
      physics.step();
    }
    expect(physics.records.state[RECORDS.state.surge]).toBeGreaterThan(0.5);
  });

  test('evaluates more values than one batch holds', async () => {
    const physics = await loadPhysics(bytes);
    const xs = Array.from({ length: 600 }, (_, i) => i / 100);
    const sin = physics.evaluate('sin', xs);
    expect(sin).toHaveLength(600);
    expect(sin[0]).toBe(0);
    expect(sin[599]).toBeCloseTo(Math.sin(5.99), 15);
    const angle = physics.evaluate('atan2', [1, -1], [0, 0]);
    expect(Array.from(angle)).toEqual([Math.PI / 2, -Math.PI / 2]);
  });
});
