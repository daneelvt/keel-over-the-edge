// SPDX-License-Identifier: AGPL-3.0-only

// The sky's golden test in WebAssembly: the module built by
// go run ./tools/physics must give, bit for bit, the sky Go gave when it
// wrote internal/sky/testdata/sky.json. So the phone's sky is the server's.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { writeSkyParams } from '../predict/params.gen';
import { BODY, loadPhysics, type Physics, SKY } from '../predict/physics';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
const golden = new URL('../../../internal/sky/testdata/sky.json', import.meta.url);

interface Golden {
  stars: number;
  samples: { t: number; east: number; north: number; sky: string; stars: string }[];
}

/** Floats as their IEEE 754 bits in hexadecimal, one after another. */
function bits(values: Float64Array): string {
  const view = new DataView(values.buffer, values.byteOffset, values.byteLength);
  let out = '';
  for (let i = 0; i < values.length; i++) {
    out += view
      .getBigUint64(i * 8, true)
      .toString(16)
      .padStart(16, '0');
  }
  return out;
}

let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  writeSkyParams(physics.skyParams, catalog.sky);
  physics.prepareSky();
});

describe('the sky in the module', () => {
  test('gives the server’s sky bit for bit', () => {
    const file = JSON.parse(readFileSync(golden, 'utf8')) as Golden;
    expect(file.stars).toBe(catalog.sky.stars.length);
    expect(file.samples.length).toBe(12 * 40);
    const problems: string[] = [];
    for (const [i, s] of file.samples.entries()) {
      const sky = bits(physics.skyAt(s.t, s.east, s.north));
      const hash = createHash('sha256');
      for (const star of catalog.sky.stars) {
        const body = physics.skyStar(s.t, s.east, s.north, star.rightAscension, star.declination);
        hash.update(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
      }
      if (sky !== s.sky || hash.digest('hex') !== s.stars) {
        problems.push(`sample ${i} (t ${s.t} from ${s.east}, ${s.north})`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('puts a star where its matrix puts its catalogue vector', () => {
    const t = 123456789012;
    const [east, north] = [3000, -5000];
    const m = Array.from(physics.skyAt(t, east, north).subarray(SKY.stars, SKY.stars + 9));
    for (const star of catalog.sky.stars) {
      const v = Array.from(physics.skyVector(star.rightAscension, star.declination));
      const body = Array.from(
        physics.skyStar(t, east, north, star.rightAscension, star.declination),
      );
      for (let row = 0; row < 3; row++) {
        const got =
          (m[row * 3] ?? 0) * (v[0] ?? 0) +
          (m[row * 3 + 1] ?? 0) * (v[1] ?? 0) +
          (m[row * 3 + 2] ?? 0) * (v[2] ?? 0);
        expect(got).toBeCloseTo(body[BODY.east + row] ?? 0, 14);
      }
    }
  });

  test('tells sky time as the server does', () => {
    const skyEpoch = catalog.sky.epoch * 1e6;
    // In a world whose epoch is the sky's, sky time is world time.
    expect(physics.skyTime(skyEpoch, 5e9)).toBe(5e9);
    // Two worlds, one moment: one sky time, in whole microseconds.
    const later = skyEpoch + 24_591_600e6;
    const moment = later + 123_456_789.75;
    expect(physics.skyTime(later, moment - later)).toBe(Math.floor(moment - skyEpoch));
    expect(physics.skyTime(skyEpoch, moment - skyEpoch)).toBe(Math.floor(moment - skyEpoch));
  });

  test('a hundred thousand calls neither allocate nor grow the memory', () => {
    const bytes = physics.memoryBytes;
    const allocations = physics.allocations;
    const start = performance.now();
    const calls = 100_000;
    for (let i = 0; i < calls; i++) {
      physics.skyAt(i * 1e6, 3000, -2000);
    }
    const each = ((performance.now() - start) / calls) * 1000;
    expect(physics.allocations).toBe(allocations);
    expect(physics.memoryBytes).toBe(bytes);
    // A call a frame: it must cost nothing beside the frame's 16 ms.
    expect(each).toBeLessThan(50);
    console.info(`sky: a call of skyAt takes ${each.toFixed(2)} µs under Node`);
  });
});
