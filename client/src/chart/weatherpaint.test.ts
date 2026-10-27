// SPDX-License-Identifier: AGPL-3.0-only

// The chart's weather's drawing by its numbers: a barb's marks for each
// speed, as the weather chart's, to the nearest 5 knots; the wash's step by
// the Beaufort force; a system's lettering with its wind, force and motion;
// and the key, which has an entry for every kind of system the catalog
// has, with its line, and every symbol, and the look's lines for the rest.

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { keyEntries } from './key';
import { kindDraws, type SceneSystem } from './weather';
import { feathers, SYMBOL_RANK, systemLabel, washStep } from './weatherpaint';

const KNOT = 1852 / 3600;

describe('the wind’s barbs', () => {
  test('a half feather for 5 knots, a feather for 10 and a pennant for 50, to the nearest 5', () => {
    const cases: [number, number, number, number][] = [
      // knots, pennants, feathers, half feathers
      [0, 0, 0, 0],
      [2.4, 0, 0, 0],
      [2.5, 0, 0, 1],
      [5, 0, 0, 1],
      [8, 0, 1, 0],
      [10, 0, 1, 0],
      [15, 0, 1, 1],
      [25, 0, 2, 1],
      [47, 0, 4, 1],
      [48, 1, 0, 0],
      [50, 1, 0, 0],
      [65, 1, 1, 1],
      [100, 2, 0, 0],
      [115, 2, 1, 1],
    ];
    for (const [knots, pennants, full, halves] of cases) {
      expect(feathers(knots), `${knots} knots`).toEqual({ pennants, feathers: full, halves });
    }
  });

  test('every speed adds up to its marks', () => {
    for (let knots = 0; knots <= 120; knots += 0.5) {
      const m = feathers(knots);
      expect(50 * m.pennants + 10 * m.feathers + 5 * m.halves).toBe(
        5 * Math.round(knots / 5 + 1e-9),
      );
    }
  });
});

describe('the wind’s wash', () => {
  const forces = catalog.world.chart.look.weather.wash.forces;

  test('none under force 3, then a step darker at forces 3, 5 and 7', () => {
    expect(forces).toEqual([3, 5, 7]);
    // Force 3 begins at 7 knots, 5 at 17 and 7 at 28 (the Met Office's scale).
    const cases: [number, number][] = [
      [0, 0],
      [6.4, 0],
      [6.6, 1],
      [10, 1],
      [16.4, 1],
      [16.6, 2],
      [27.4, 2],
      [27.6, 3],
      [60, 3],
    ];
    for (const [knots, step] of cases) {
      expect(washStep(knots * KNOT, forces), `${knots} knots`).toBe(step);
    }
  });

  test('the step never falls as the wind rises', () => {
    let last = 0;
    for (let knots = 0; knots < 70; knots += 0.1) {
      const s = washStep(knots * KNOT, forces);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
    expect(last).toBe(forces.length);
  });
});

describe('a system’s lettering', () => {
  const system = (over: Partial<SceneSystem>): SceneSystem => ({
    slot: 0,
    kind: 0,
    seed: 0,
    draw: 'cell',
    name: 'Squall',
    east: 0,
    north: 0,
    heading: Math.PI / 4,
    speed: 9 * KNOT,
    size: 800,
    strength: 1,
    length: 0,
    ring: 0,
    wind: 30 * KNOT,
    gust: 40 * KNOT,
    ahead: null,
    gone: null,
    ...over,
  });

  test('a storm’s with its force, its wind and its motion; a line’s with its wind; a fog bank’s its name', () => {
    expect(
      systemLabel(
        system({
          draw: 'spiral',
          name: 'Storm',
          ring: 1200,
          wind: 45 * KNOT,
          speed: 5 * KNOT,
        }),
      ),
    ).toBe('Storm · F9 · 45 kn · NE 5 kn');
    expect(
      systemLabel(
        system({
          draw: 'low',
          name: 'Low',
          ring: 900,
          wind: 25 * KNOT,
          heading: Math.PI / 2,
          speed: 4 * KNOT,
        }),
      ),
    ).toBe('Low · F6 · 25 kn · E 4 kn');
    expect(
      systemLabel(system({ draw: 'dash-dot', name: 'Squall line', length: 4000, wind: 35 * KNOT })),
    ).toBe('Squall line · 35 kn');
    expect(systemLabel(system({}))).toBe('Squall · 30 kn · NE 9 kn');
    expect(systemLabel(system({ draw: 'bank', name: 'Fog', wind: 3 * KNOT, speed: 0 }))).toBe(
      'Fog',
    );
  });
});

describe('the key', () => {
  const kinds = kindDraws(catalog.weather.systems);
  const words = catalog.world.chart.look.weather.key;
  const entries = keyEntries(kinds, words);

  test('every kind of system has its entry, with the catalog’s name and line', () => {
    for (const k of catalog.weather.systems) {
      const e = entries.find((x) => x.name === k.name);
      expect(e, k.name).toBeDefined();
      expect(e?.line).toBe(k.key);
    }
  });

  test('every symbol the chart draws systems with is in the catalog and in the key', () => {
    const symbols = new Set(kinds.map((k) => k.draw));
    for (const symbol of Object.keys(SYMBOL_RANK)) {
      expect(symbols.has(symbol as never), symbol).toBe(true);
    }
  });

  test('the fronts, the wind, the isobars, a ring, the motion, a gale and the fields have their lines', () => {
    const ids = entries.map((e) => e.id);
    for (const id of Object.keys(words)) {
      expect(ids, id).toContain(id);
    }
    for (const e of entries) {
      expect(e.line.length, e.id).toBeGreaterThan(10);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
