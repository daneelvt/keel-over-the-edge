// SPDX-License-Identifier: AGPL-3.0-only

// The page's rule of a light against the server's golden schedule
// (internal/light/testdata/schedule.json, which go test ./internal/light
// writes): the same light or dark for every character, phase and time.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import {
  illuminance,
  intensity,
  level,
  lightOn,
  notation,
  sweep,
  transmissivity,
} from './character';

const golden = new URL('../../../internal/light/testdata/schedule.json', import.meta.url);

interface Golden {
  times: number[];
  phases: number[];
  lights: { notation: string; steps: number[]; on: string[] }[];
}

describe('a light’s character', () => {
  test('shows as the server’s golden schedule says, bit for bit', () => {
    const g = JSON.parse(readFileSync(golden, 'utf8')) as Golden;
    expect(g.lights.map((l) => l.notation)).toEqual(
      catalog.world.lights.characters.map((c) => c.notation),
    );
    for (const l of g.lights) {
      g.phases.forEach((phase, k) => {
        let got = '';
        for (const t of g.times) {
          got += lightOn(l.steps, phase, t) ? '1' : '0';
        }
        expect(got, `${l.notation} with phase ${phase}`).toBe(l.on[k]);
      });
    }
  });

  test('rounds a flash and cuts an eclipse', () => {
    const fl = catalog.world.lights.characters.find((c) => c.notation === 'Fl W 10s');
    const oc = catalog.world.lights.characters.find((c) => c.notation === 'Oc R 6s');
    if (fl === undefined || oc === undefined) {
      throw new Error('no such character');
    }
    expect(level(fl, 0, 0, 0.15)).toBe(0);
    expect(level(fl, 0, 500_000, 0.15)).toBe(1);
    expect(level(fl, 0, 75_000, 0.15)).toBeCloseTo(0.5, 5);
    expect(level(fl, 0, 2_000_000, 0.15)).toBe(0);
    expect(level(oc, 0, 1, 0.15)).toBe(1);
    expect(level(oc, 0, 4_500_000, 0.15)).toBe(0);
  });

  test('turns its beams to face the viewer at each flash', () => {
    const steps = [500, 1500, 500, 1500, 500, 10500];
    expect(sweep(steps, 0, 0)).toBe(0);
    expect(sweep(steps, 0, 1_000_000)).toBeCloseTo(0.5, 9);
    expect(sweep(steps, 0, 2_000_000)).toBe(0);
    expect(sweep(steps, 0, 4_000_000)).toBe(0);
    expect(sweep(steps, 0, 9_500_000)).toBeCloseTo(0.5, 9);
  });
});

describe('Allard’s law', () => {
  test('a light is at the threshold at its range, and brighter within', () => {
    expect(transmissivity(10)).toBeCloseTo(0.676, 3);
    const t = transmissivity(catalog.world.lights.clearAir);
    const th = catalog.world.lights.threshold;
    for (const r of [1389, 2778, 4630, 8334]) {
      const i = intensity(r, t, th);
      expect(illuminance(i, r, t) / th).toBeCloseTo(1, 9);
      expect(illuminance(i, r / 2, t)).toBeGreaterThan(th);
      expect(illuminance(i, 2 * r, t)).toBeLessThan(th);
    }
  });

  test('writes a light as charts do', () => {
    expect(notation('Fl(3) W 15s', 84.7, 8334)).toBe('Fl(3) W 15s 85m 4.5M');
    expect(notation('Iso G 6s', 17, 3704)).toBe('Iso G 6s 17m 2M');
  });
});
