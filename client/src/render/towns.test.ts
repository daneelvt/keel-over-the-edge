// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { downwind, flagExtension, flapFrequency } from './flags';
import { puffAt, smokes } from './smoke';
import { housed, Towns, windowLit } from './town';

const KNOT = 1852 / 3600;
const flags = catalog.world.towns.flags;
const smoke = catalog.world.towns.smoke;

describe('a flag ashore', () => {
  test('hangs limp in light airs and is extended from Beaufort’s force 3', () => {
    expect(flagExtension(2, flags.limp, flags.extended)).toBe(0);
    expect(flagExtension(8, flags.limp, flags.extended)).toBe(1);
    const half = flagExtension(5, flags.limp, flags.extended);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.8);
  });

  test('flaps faster the stronger the wind, its Strouhal number held', () => {
    const f8 = flapFrequency(8 * KNOT, flags.length, flags.strouhal);
    const f20 = flapFrequency(20 * KNOT, flags.length, flags.strouhal);
    expect(f20).toBeGreaterThan(f8);
    expect((f8 * flags.length) / (8 * KNOT)).toBeCloseTo(flags.strouhal, 9);
  });

  test('streams downwind of the true wind', () => {
    // A northerly blows toward the south.
    expect(downwind(0)).toBeCloseTo(Math.PI, 12);
    expect(Math.sin(downwind(Math.PI / 2))).toBeCloseTo(-1, 12);
  });
});

describe('chimney smoke', () => {
  test('rises straight in a calm, leans at 2 knots, is bent over at 15', () => {
    const age = smoke.life * 0.8;
    const calm = puffAt(age, 0, smoke);
    expect(calm.down).toBe(0);
    expect(calm.up).toBeGreaterThan(4);
    const light = puffAt(age, 2 * KNOT, smoke);
    expect(light.down).toBeGreaterThan(3);
    expect(light.up).toBeGreaterThan(light.down / 4);
    const strong = puffAt(age, 15 * KNOT, smoke);
    expect(strong.down).toBeGreaterThan(40);
    expect(strong.up).toBeLessThan(strong.down / 10);
    // Briggs's law: in a stronger wind it rises less, however far it is carried.
    expect(strong.up).toBeLessThan(light.up);
  });

  test('thins and widens as it goes', () => {
    const young = puffAt(1, 3, smoke);
    const old = puffAt(smoke.life * 0.9, 3, smoke);
    expect(old.width).toBeGreaterThan(young.width);
    expect(old.thick).toBeLessThan(young.thick);
  });

  test('from a share of the chimneys, more by day than by night', () => {
    let day = 0;
    let night = 0;
    for (let seed = 0; seed < 64; seed++) {
      day += smokes(seed, false, smoke) ? 1 : 0;
      night += smokes(seed, true, smoke) ? 1 : 0;
    }
    expect(day).toBeGreaterThan(night);
    expect(day / 64).toBeLessThan(0.35);
  });
});

describe('a town', () => {
  test('lights each house’s windows by its own numbers, the same each time', () => {
    let lit = 0;
    for (let w = 0; w < 400; w++) {
      const a = windowLit(17, w, 0.6);
      expect(windowLit(17, w, 0.6)).toBe(a);
      lit += a ? 1 : 0;
    }
    expect(lit / 400).toBeGreaterThan(0.45);
    expect(lit / 400).toBeLessThan(0.75);
  });

  test('builds its houses in storeys, its other buildings as they are', () => {
    const kinds = catalog.world.towns.buildings;
    expect(kinds.filter(housed).length).toBeGreaterThan(4);
    expect(kinds.filter((k) => k.prop).every((k) => !housed(k))).toBe(true);
  });

  test('shows its flags, chimneys and lanterns from its buildings', () => {
    const towns = new Towns(catalog.world);
    const kinds = catalog.world.towns.buildings;
    const k = (pred: (x: (typeof kinds)[number]) => boolean): number => kinds.findIndex(pred);
    const house = k((x) => (x.chimney ?? 0) >= 1 && x.prop !== true);
    const flagged = k((x) => x.flag === true);
    const post = k((x) => x.prop === true && (x.lantern ?? 0) > 0);
    const b = (kind: number, east: number) => ({
      kind,
      kit: 0,
      east,
      north: 0,
      heading: 0,
      level: 1.6,
      top: 10,
      storeys: 2,
      seed: 5,
      wall: 0,
      roof: 0,
      shutter: 0,
      flag: kind === flagged ? 1 : 0,
      frontage: 8,
      depth: 8,
      town: 0,
    });
    towns.add(3, {
      buildings: [b(house, 0), b(flagged, 20), b(post, 40)],
      harbour: [{ east: 0, north: -50, radius: 30 }],
    });
    const f = towns.features();
    expect(f.chimneys.length).toBeGreaterThanOrEqual(1);
    expect(f.flags.length).toBe(1);
    expect(f.lanterns.some((l) => l.east === 40 && Math.abs(l.top - 4.8) < 1e-9)).toBe(true);
    // In port within a disc, on water; not on land, nor outside it.
    expect(towns.heardFrom(0, -50, () => true).inPort).toBe(true);
    expect(towns.heardFrom(0, -50, () => false).inPort).toBe(false);
    expect(towns.heardFrom(0, -200, () => true).inPort).toBe(false);
    towns.drop(3);
    expect([...towns.buildings()].length).toBe(0);
  });
});
