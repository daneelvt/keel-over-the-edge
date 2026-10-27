// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather reads to every reader: its colours stay apart under
// simulated protanopia, deuteranopia and tritanopia, and each mark stands
// off the paper and the sea; the wind's wash darkens step by step, by
// lightness alone, to every reader and in grey; and the colour difference
// is CIEDE2000's, as Sharma, Wu and Dalal's test pairs give it.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import {
  contrast,
  DEFICIENCIES,
  type Deficiency,
  deltaE2000,
  hexRgb,
  lab,
  over,
  type Rgb,
  simulate,
} from './colours';

describe('colours', () => {
  test('CIEDE2000 gives Sharma, Wu and Dalal’s test pairs to four decimals', () => {
    const pairs: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
      [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
      [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
    ];
    for (const [a, b, want] of pairs) {
      expect(deltaE2000(a, b)).toBeCloseTo(want, 4);
    }
  });

  test('the weather’s colours stay 10 apart, and 3:1 off the paper and the sea, to every reader', () => {
    const look = catalog.world.chart.look;
    const w = look.weather;
    const marks: Record<string, Rgb> = {
      ink: hexRgb(look.ink),
      rain: hexRgb(w.rain),
      fog: hexRgb(w.fog),
      cold: hexRgb(w.cold),
      warm: hexRgb(w.warm),
      squall: hexRgb(w.squall),
      storm: hexRgb(w.storm),
    };
    const paper = hexRgb(look.paper);
    // The sea is washed over the paper as the paper is painted.
    const sea = over(hexRgb(look.sea), paper, 0.55);
    const names = Object.keys(marks);
    const readers: (Deficiency | null)[] = [null, ...(Object.keys(DEFICIENCIES) as Deficiency[])];
    let least = Number.POSITIVE_INFINITY;
    for (const d of readers) {
      const seen = (c: Rgb) => (d === null ? c : simulate(c, d));
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = marks[names[i] as string] as Rgb;
          const b = marks[names[j] as string] as Rgb;
          const de = deltaE2000(lab(seen(a)), lab(seen(b)));
          least = Math.min(least, de);
          expect(de, `${names[i]} and ${names[j]}, ${d ?? 'normal vision'}`).toBeGreaterThanOrEqual(
            10,
          );
        }
      }
    }
    for (const n of names) {
      const c = marks[n] as Rgb;
      expect(contrast(c, paper), `${n} on the paper`).toBeGreaterThanOrEqual(3);
      expect(contrast(c, sea), `${n} on the sea`).toBeGreaterThanOrEqual(3);
    }
    process.stdout.write(`colours: the least difference to any reader is ${least.toFixed(1)}\n`);
  });

  test('the wind’s wash darkens a step at each force, 3 apart, by its lightness, to every reader', () => {
    const look = catalog.world.chart.look;
    const wash = look.weather.wash;
    expect(wash.tints.length).toBe(wash.forces.length);
    const paper = hexRgb(look.paper);
    const sea = over(hexRgb(look.sea), paper, 0.55);
    const steps = [sea, ...wash.tints.map((t) => over(hexRgb(wash.colour), sea, t))];
    const readers: (Deficiency | null)[] = [null, ...(Object.keys(DEFICIENCIES) as Deficiency[])];
    for (const d of readers) {
      const seen = steps.map((c) => lab(d === null ? c : simulate(c, d)));
      for (let i = 1; i < seen.length; i++) {
        const a = seen[i - 1] as number[];
        const b = seen[i] as number[];
        // Darker each step, and told apart by the lightness alone: in grey too.
        expect((a[0] ?? 0) - (b[0] ?? 0), `step ${i}, ${d ?? 'normal vision'}`).toBeGreaterThan(3);
        expect(deltaE2000(a, b)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test('a deficiency is simulated in linear RGB, as Chrome does', () => {
    // Pure red to protanopia, as Chrome's emulation shows it: (109, 95, 0).
    const r = simulate([1, 0, 0], 'protanopia').map((c) => Math.round(c * 255));
    expect(r[0]).toBeCloseTo(109, -1);
    expect(r[1]).toBeCloseTo(95, -1);
    expect(r[2]).toBe(0);
  });
});
