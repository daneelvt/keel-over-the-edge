// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  BEAUFORT_FROM,
  beaufort,
  FOAM_BY_FORCE,
  type FoamLook,
  foamAt,
  forceKnots,
  KNOT,
  newFoamLook,
  whitecapCoverage,
} from './look';

const at = (knots: number): FoamLook => foamAt(knots, newFoamLook());

describe('the foam by Beaufort force', () => {
  it('has a row for every force from 0 to 9, with strengths from 0 to 1', () => {
    expect(FOAM_BY_FORCE).toHaveLength(10);
    expect(BEAUFORT_FROM).toHaveLength(10);
    for (const row of FOAM_BY_FORCE) {
      for (const k of ['whitecaps', 'streaks', 'folding'] as const) {
        expect(row[k]).toBeGreaterThanOrEqual(0);
        expect(row[k]).toBeLessThanOrEqual(1);
      }
      expect(row.threshold).toBeGreaterThan(0);
      expect(row.threshold).toBeLessThan(1);
      expect(row.chop).toBeGreaterThan(0);
      expect(row.decay).toBeGreaterThan(0);
    }
  });

  it('never falls as the wind rises, row by row and knot by knot', () => {
    const fields = ['whitecaps', 'streaks', 'folding', 'threshold', 'chop', 'decay'] as const;
    for (let f = 1; f < FOAM_BY_FORCE.length; f++) {
      for (const k of fields) {
        expect(FOAM_BY_FORCE[f]?.[k]).toBeGreaterThanOrEqual(FOAM_BY_FORCE[f - 1]?.[k] ?? 0);
      }
    }
    let before = at(0);
    for (let knots = 0.25; knots <= 60; knots += 0.25) {
      const now = at(knots);
      for (const k of fields) {
        expect(now[k]).toBeGreaterThanOrEqual(before[k]);
      }
      before = now;
    }
  });

  it('is each force’s row at the middle of the force', () => {
    for (let f = 0; f < 8; f++) {
      expect(at(forceKnots(f))).toEqual(FOAM_BY_FORCE[f]);
    }
    expect(forceKnots(3)).toBe(8.5);
    expect(forceKnots(7)).toBe(30.5);
    // The top rows hold from where force 8 begins, and on up.
    expect(at(34)).toEqual(FOAM_BY_FORCE[8]);
    expect(at(55)).toEqual(FOAM_BY_FORCE[9]);
  });

  it('begins each kind of foam where its force begins', () => {
    // No whitecaps below force 3, no streaks below force 7.
    expect(at(6).whitecaps).toBe(0);
    expect(at(6.99).whitecaps).toBe(0);
    expect(at(7.5).whitecaps).toBeGreaterThan(0);
    expect(at(6.99).folding).toBe(0);
    expect(at(27.99).streaks).toBe(0);
    expect(at(29).streaks).toBeGreaterThan(0);
    expect(at(20).streaks).toBe(0);
  });

  it('names the force of a wind', () => {
    expect(beaufort(0.5)).toBe(0);
    expect(beaufort(6)).toBe(2);
    expect(beaufort(7)).toBe(3);
    expect(beaufort(33.9)).toBe(7);
    expect(beaufort(34)).toBe(8);
    expect(beaufort(80)).toBe(9);
  });
});

describe('whitecap coverage', () => {
  it('is Monahan and O’Muircheartaigh’s: a thousandth at 10 knots, a fifteenth in a gale', () => {
    expect(whitecapCoverage(10 * KNOT)).toBeCloseTo(0.001, 3);
    expect(whitecapCoverage(20 * KNOT)).toBeCloseTo(0.011, 3);
    expect(whitecapCoverage(34 * KNOT)).toBeCloseTo(0.066, 2);
    expect(whitecapCoverage(-1)).toBe(0);
  });
});
