// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { beaufortOf, swayOf } from './flora';

const wind = catalog.world.flora.wind;
const knots = (k: number): number => (k * 1852) / 3600;

describe('plants in the wind', () => {
  test('are still in a calm, sway at force 5, move whole at 7, as Beaufort’s land scale says', () => {
    const calm = swayOf(beaufortOf(knots(2)), 0.5, wind);
    expect(calm.lean).toBe(0);
    expect(calm.swing).toBe(0);
    expect(calm.leaves).toBe(0);
    // Force 3: leaves moving, the tree still.
    const f3 = swayOf(3, 0.5, wind);
    expect(f3.leaves).toBe(1);
    expect(f3.lean).toBe(0);
    // Force 5: small trees sway; force 7: whole trees, more.
    const f5 = swayOf(5, 0.5, wind);
    const f7 = swayOf(7.5, 0.5, wind);
    expect(f5.swing).toBeGreaterThan(0);
    expect(f7.lean).toBeGreaterThan(2 * f5.lean);
    // The stiffer the less.
    expect(swayOf(7.5, 0.9, wind).lean).toBeLessThan(swayOf(7.5, 0.1, wind).lean);
  });

  test('read the force from the wind’s speed', () => {
    expect(beaufortOf(0)).toBe(0);
    expect(beaufortOf(10.7)).toBeCloseTo(5.47, 1);
  });
});
