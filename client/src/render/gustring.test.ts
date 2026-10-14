// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { RECORDS } from '../predict/layout.gen';
import { loadPhysics, type Physics, WIND_VALUE, WIND_VALUES } from '../predict/physics';
import { preparePhysics } from '../predict/predictor';
import { loadWindCase, type WindFile } from '../predict/windcheck';
import { chooseRings, findPatches, type GustPatch, gridSize, ringGrid } from './gustring';

const ring = catalog.weather.ring;
const { rows, cols } = gridSize(ring);

describe('the gust ring’s grid', () => {
  test('lies upwind of the boat, centred across the wind', () => {
    expect([rows, cols]).toEqual([30, 20]);
    const points = new Float64Array(rows * cols * 2);
    // A wind from the east: the grid runs east of the boat, north to south across it.
    ringGrid(100, 50, Math.PI / 2, ring, points);
    const at = (i: number, j: number): number[] => [
      points[(i * cols + j) * 2] ?? 0,
      points[(i * cols + j) * 2 + 1] ?? 0,
    ];
    expect(at(0, 0)[0]).toBeCloseTo(104, 9);
    expect(at(rows - 1, 0)[0]).toBeCloseTo(100 + ring.depth - 4, 9);
    expect(at(0, 0)[1]).toBeCloseTo(50 + 76, 9);
    expect(at(0, cols - 1)[1]).toBeCloseTo(50 - 76, 9);
    expect((at(5, 9)[1] ?? 0) + (at(5, 10)[1] ?? 0)).toBeCloseTo(100, 9);
  });
});

/** A field of the grid's size, 1 everywhere but where set. */
function field(set: (i: number, j: number) => number): {
  factor: Float64Array;
  points: Float64Array;
} {
  const factor = new Float64Array(rows * cols).fill(1);
  const points = new Float64Array(rows * cols * 2);
  // A wind from the north: rows run north, columns east.
  ringGrid(0, 0, 0, ring, points);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      factor[i * cols + j] = set(i, j);
    }
  }
  return { factor, points };
}

describe('the patches of gust', () => {
  test('are the sets of neighbouring points over the threshold, each with its middle and its size', () => {
    // Two blocks of strong gust, and a weak one that is none.
    const f = field((i, j) =>
      i >= 4 && i < 8 && j >= 2 && j < 6
        ? 1.25
        : i >= 20 && i < 22 && j >= 14 && j < 20
          ? 1.3
          : i === 12
            ? 1.1
            : 1,
    );
    const patches = findPatches(f.factor, f.points, 0.3, ring);
    expect(patches).toHaveLength(2);
    const [a, b] = patches as [GustPatch, GustPatch];
    // Rows 4–7 are 36–60 m upwind (north); columns 2–5 are 60–36 m west.
    expect(a.north).toBeCloseTo(48, 9);
    expect(a.east).toBeCloseTo(-48, 9);
    expect(a.radius).toBeCloseTo(Math.sqrt((16 * 64) / Math.PI), 9);
    expect(a.peak).toBe(1.25);
    expect(b.north).toBeCloseTo(168, 9);
    expect(b.peak).toBe(1.3);
    // With the threshold at half the excess, 1.1 is no gust in a spell of 1.3, and is one in a spell of 1.2.
    expect(findPatches(f.factor, f.points, 0.2, ring)).toHaveLength(3);
    // A spell with no gusts has no patches.
    expect(findPatches(f.factor, f.points, 0, ring)).toEqual([]);
  });
});

describe('the rings', () => {
  const patch = (east: number, north: number): GustPatch => ({
    east,
    north,
    radius: 20,
    peak: 1.3,
  });
  // The field travels south at 5 m/s past a boat at rest at the centre.
  const choose = (patches: GustPatch[], boatEast = 0, boatNorth = 0) =>
    chooseRings(patches, 0, 0, boatEast, boatNorth, 0, -5, ring);

  test('are round the patches whose track passes within reach of the boat, soon', () => {
    const ringed = choose([patch(0, 150), patch(45, 100), patch(60, 100), patch(0, 400)]);
    // 150 m upwind and on the boat's line: 30 s. One whose middle passes
    // 45 m to one side, 20 m in radius: its edge comes within 25 m, in
    // reach. One whose edge misses the boat by 40 m has none. 400 m off is
    // 80 s away: not within a minute.
    expect(ringed.map((p) => [p.east, p.north])).toEqual([
      [45, 100],
      [0, 150],
    ]);
    expect(ringed[0]?.arrives).toBeCloseTo(20, 9);
    expect(ringed[0]?.miss).toBeCloseTo(25, 9);
    expect(ringed[1]?.arrives).toBeCloseTo(30, 9);
    expect(ringed[1]?.miss).toBe(0);
  });

  test('are three at most, the soonest', () => {
    const ringed = choose([
      patch(0, 200),
      patch(5, 50),
      patch(-5, 120),
      patch(10, 90),
      patch(0, 20),
    ]);
    expect(ringed.map((p) => p.north)).toEqual([20, 50, 90]);
    expect(ringed).toHaveLength(ring.rings);
  });

  test('follow the boat’s own way: a patch it sails out from under has none', () => {
    // 100 m upwind and 100 m to the east: it passes 100 m off a boat at
    // rest, and over one sailing east at 5 m/s.
    expect(choose([patch(100, 100)])).toHaveLength(0);
    const ringed = choose([patch(100, 100)], 5, 0);
    expect(ringed).toHaveLength(1);
    expect(ringed[0]?.miss).toBeCloseTo(0, 9);
    // A patch downwind of the boat has passed: it is nearest now, and that is too far.
    expect(choose([patch(0, -60)])).toHaveLength(0);
    expect(choose([patch(0, -45)])).toHaveLength(1);
  });
});

describe('on the physics module’s own field', () => {
  const wasm = new URL('../predict/physics.wasm', import.meta.url);
  const file = new URL('../../../internal/physics/testdata/wind.json', import.meta.url);
  let physics: Physics;
  let wind: WindFile;

  beforeAll(async () => {
    if (!existsSync(wasm)) {
      throw new Error('client/src/predict/physics.wasm is missing: run go run ./tools/physics');
    }
    physics = await loadPhysics(readFileSync(wasm));
    preparePhysics(physics, catalog.boats[0].physics, catalog.weather);
    wind = JSON.parse(readFileSync(file, 'utf8')) as WindFile;
  });

  test('the patches found are where the gust factor is high, and a ringed one’s track meets the boat', () => {
    const c = wind.cases.find((k) => k.name === 'trade');
    if (c === undefined) {
      throw new Error('wind.json has no trade case');
    }
    loadWindCase(physics, c);
    const excess = physics.gustFrame()[RECORDS.gustFrame.excess] ?? 0;
    expect(excess).toBeCloseTo(0.3, 9);
    const points = new Float64Array(rows * cols * 2);
    const values = new Float64Array(rows * cols * WIND_VALUES);
    const factor = new Float64Array(rows * cols);
    let patches = 0;
    let ringed = 0;
    // Boats over a few hundred metres about the place.
    for (let n = 0; n < 40; n++) {
      const east = (c.origin[0] ?? 0) + ((n * 53) % 400) - 200;
      const north = (c.origin[1] ?? 0) + ((n * 97) % 400) - 200;
      physics.windDrawAt(c.tick);
      const here = Float64Array.from(physics.windPoint(east, north));
      ringGrid(east, north, here[RECORDS.wind.meanFrom] ?? 0, ring, points);
      physics.windSample(points, values);
      for (let i = 0; i < factor.length; i++) {
        factor[i] = values[i * WIND_VALUES + WIND_VALUE.factor] ?? 1;
      }
      const found = findPatches(factor, points, excess, ring);
      patches += found.length;
      for (const p of found) {
        // A patch's middle is in the gust, or the patch curls about it.
        expect(p.peak).toBeGreaterThanOrEqual(1 + ring.threshold * excess);
        expect(p.radius).toBeGreaterThanOrEqual(ring.spacing / 2);
      }
      const drift = [here[RECORDS.wind.driftEast] ?? 0, here[RECORDS.wind.driftNorth] ?? 0];
      const chosen = chooseRings(found, east, north, 0, 0, drift[0] ?? 0, drift[1] ?? 0, ring);
      expect(chosen.length).toBeLessThanOrEqual(ring.rings);
      ringed += chosen.length;
      for (const p of chosen) {
        // When the patch is nearest, the field there, carried to the boat,
        // is the patch still: the boat is in or beside a gust.
        const tick = c.tick + p.arrives * 30;
        physics.windDrawAt(tick);
        const then = physics.windPoint(
          p.east + (drift[0] ?? 0) * p.arrives,
          p.north + (drift[1] ?? 0) * p.arrives,
        );
        expect(then[RECORDS.wind.gust] ?? 0).toBeGreaterThan(0);
      }
    }
    // A trade spell has gusts about any boat, and some head for it.
    expect(patches).toBeGreaterThan(40);
    expect(ringed).toBeGreaterThan(10);
  });
});
