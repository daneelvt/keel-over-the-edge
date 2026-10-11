// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { RECORDS, SEA } from '../predict/layout.gen';
import { loadPhysics, type Physics } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { AREAS, COMPONENTS, reducePhase, SeaBand } from './phases';

const wasm = new URL('../predict/physics.wasm', import.meta.url);
let physics: Physics;

beforeAll(async () => {
  if (!existsSync(wasm)) {
    throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
  }
  physics = await loadPhysics(readFileSync(wasm));
  preparePhysics(physics, catalog.boats[0].physics, catalog.weather.sea);
});

/** Fills the module's first window: one wind everywhere, or a second from column split eastward. */
function fill(
  knots: number,
  col: number,
  row: number,
  split: number = SEA.window,
  other = 0,
): void {
  const of = (kn: number): number[] => physics.seaInputOf((kn * 1852) / 3600, 0.4, -1, []);
  const [west, east] = [of(knots), of(other)];
  physics.seaWindow(0, col, row, SEA.window);
  for (let i = 0; i < AREAS; i++) {
    const a = i % SEA.window >= split ? east : west;
    physics.seaArea(0, i, a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  }
  physics.seaSeal(0);
}

// Double-double arithmetic (Dekker 1971; Knuth's two-sum): a value as an
// unevaluated sum hi + lo, good to about 32 significant digits.
type DD = [number, number];

function twoSum(a: number, b: number): DD {
  const s = a + b;
  const v = s - a;
  return [s, a - (s - v) + (b - v)];
}

function split(a: number): DD {
  const c = 134217729 * a; // 2^27 + 1
  const hi = c - (c - a);
  return [hi, a - hi];
}

function twoProd(a: number, b: number): DD {
  const p = a * b;
  const [ah, al] = split(a);
  const [bh, bl] = split(b);
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

function add(a: DD, b: DD): DD {
  const [s, e] = twoSum(a[0], b[0]);
  return twoSum(s, e + a[1] + b[1]);
}

function mulD(a: DD, b: number): DD {
  const [p, e] = twoProd(a[0], b);
  return twoSum(p, e + a[1] * b);
}

// 2π to about 48 digits, in three parts.
const TWO_PI: [number, number, number] = [
  6.283185307179586, 2.4492935982947064e-16, -5.9895396194366793e-33,
];

/** φ + k(d·O) reduced to [0, 2π) less the fraction of turns·tick, in double-double, as a double. */
function referencePhase(
  phase: number,
  kEast: number,
  kNorth: number,
  e: number,
  n: number,
  turns: number,
  tick: number,
): number {
  let x: DD = [phase, 0];
  x = add(x, twoProd(kEast, e));
  x = add(x, twoProd(kNorth, n));
  // The turns made, exactly, and their fraction.
  const t = twoProd(turns, tick);
  const whole = Math.floor(t[0]);
  const frac = add([t[0] - whole, 0], [t[1], 0]);
  x = add(x, mulD(mulD(frac, -TWO_PI[0]), 1));
  x = add(x, mulD(frac, -TWO_PI[1]));
  const m = Math.floor((x[0] + x[1]) / TWO_PI[0]);
  let r = add(x, mulD([TWO_PI[0], 0], -m));
  r = add(r, mulD([TWO_PI[1], 0], -m));
  r = add(r, mulD([TWO_PI[2], 0], -m));
  let v = r[0] + r[1];
  if (v < 0) {
    v += 2 * Math.PI;
  }
  return v;
}

/** The difference of two angles, the short way round. */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

describe('phases at the floating origin', () => {
  test('reduce into [0, 2π)', () => {
    for (const x of [0, 1e-300, 6.283185307179586, -1e-9, 1.7e6, -1.7e6, 123.456]) {
      const r = reducePhase(x);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(2 * Math.PI);
    }
  });

  test('match a double-double reference at the rim, years into a world, to 10⁻⁹ rad', () => {
    const origin: [number, number] = [-5657.2, 5657.9]; // 8,000 m out
    fill(34, 3, 28);
    const band = new SeaBand();
    band.set(physics, 0, 3, 28, SEA.window);
    const c = physics.records.components;
    const R = RECORDS.components;
    const active = Array.from(physics.seaActive(0));
    expect(active.length).toBeGreaterThan(80);
    for (const tick of [740_000_000.25, 2 ** 31 + 1, 2 ** 40 + 0.5]) {
      band.update(origin[0], origin[1], tick);
      active.forEach((i, j) => {
        const k = c[R.k + i] ?? 0;
        const want = referencePhase(
          c[R.phase + i] ?? 0,
          k * (c[R.east + i] ?? 0),
          k * (c[R.north + i] ?? 0),
          origin[0],
          origin[1],
          c[R.turns + i] ?? 0,
          tick,
        );
        const got = (band.phases[j >> 2] as { getComponent(k: number): number }).getComponent(
          j & 3,
        );
        expect(angleDiff(got, want), `tick ${tick}, wave ${i}`).toBeLessThan(1e-9);
      });
    }
  });
});

/** The band's own sum at a point (east, north) from the origin of its last update, in float64. */
function sumOf(band: SeaBand, east: number, north: number): number {
  const waves = band.waves.image.data as Float32Array;
  let h = 0;
  for (let j = 0; j < band.count; j++) {
    const [dx = 0, dz = 0, k = 0, a = 0] = waves.subarray(j * 4, j * 4 + 4);
    const phase = (band.phases[j >> 2] as { getComponent(k: number): number }).getComponent(j & 3);
    h += a * Math.sin(phase + k * (dx * east - dz * north));
  }
  return h;
}

describe('the band laid out for the GPU', () => {
  test('with no sea is flat water', () => {
    const band = new SeaBand();
    band.clear();
    band.update(100, 200, 50);
    expect(band.count).toBe(0);
    expect(band.groups).toBe(0);
    expect(band.hs.every((h) => h === 0)).toBe(true);
  });

  test('holds the waves the module sums, in fours, and their amplitudes', () => {
    fill(34, 16, 16);
    const band = new SeaBand();
    band.set(physics, 0, 16, 16, SEA.window);
    const active = physics.seaActive(0);
    expect(band.count).toBe(active.length);
    expect(band.groups).toBe(Math.ceil(active.length / 4));
    expect(band.blended).toBe(false);
    const hs = physics.seaHs(0)[0] ?? 0;
    expect(hs).toBeGreaterThan(0.8);
    expect(band.hs).toEqual(new Array(AREAS).fill(hs));
    const waves = band.waves.image.data as Float32Array;
    const amps = band.amplitudes.image.data as Float32Array;
    const c = physics.records.components;
    const amp = physics.seaAmplitudes(0);
    active.forEach((i, j) => {
      expect(waves[j * 4]).toBe(Math.fround(c[RECORDS.components.east + i] ?? 0));
      expect(waves[j * 4 + 1]).toBe(Math.fround(-(c[RECORDS.components.north + i] ?? 0)));
      expect(waves[j * 4 + 2]).toBe(Math.fround(c[RECORDS.components.k + i] ?? 0));
      expect(waves[j * 4 + 3]).toBe(Math.fround(amp[i] ?? 0));
      expect(amps[(7 * COMPONENTS + j) * 4]).toBe(Math.fround(amp[7 * COMPONENTS + i] ?? 0));
    });
    // The last four's spare places are waves of no height.
    for (let j = band.count; j < band.groups * 4; j++) {
      expect(waves[j * 4 + 3]).toBe(0);
    }
  });

  test('its sum is the module’s sea, at the centre and at the rim', () => {
    for (const [east, north, col, row] of [
      [0, 0, 16, 16],
      [5869, 5869, 29, 29],
    ] as const) {
      fill(34, col, row);
      const band = new SeaBand();
      band.set(physics, 0, col, row, SEA.window);
      for (const tick of [740_000_000, 2 ** 31 + 1.5]) {
        band.update(east, north, tick);
        physics.seaDrawAt(tick);
        const points = [0, 0, 3.5, -2, -40, 71, 149.5, 0.25];
        const world = points.map((v, i) => v + (i % 2 === 0 ? east : north));
        const sea = physics.seaSample(0, world);
        for (let i = 0; i < points.length / 2; i++) {
          const got = sumOf(band, points[i * 2] ?? 0, points[i * 2 + 1] ?? 0);
          // The textures hold float32: a few parts in ten million of each wave.
          expect(Math.abs(got - (sea[i * 4] ?? 0)), `tick ${tick}, point ${i}`).toBeLessThan(1e-4);
        }
      }
    }
  });

  test('knows a window of two seas, and where the origin is in it', () => {
    fill(6, 16, 16, 3, 34);
    const band = new SeaBand();
    band.set(physics, 0, 16, 16, SEA.window);
    expect(band.blended).toBe(true);
    expect(band.hs[2]).toBeLessThan(0.1);
    expect(band.hs[3]).toBeGreaterThan(0.8);
    // 100 m east and 50 m south of the centre, whose area is the window's third.
    band.update(100, -50, 0);
    expect(band.areaOrigin.x).toBeCloseTo(2 + 100 / 463, 12);
    expect(band.areaOrigin.y).toBeCloseTo(2 - 50 / 463, 12);
    // A window that is one sea again needs no blending.
    fill(6, 16, 16);
    band.set(physics, 0, 16, 16, SEA.window);
    expect(band.blended).toBe(false);
  });
});
