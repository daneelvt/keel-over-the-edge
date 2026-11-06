// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catalog } from '../catalog';
import {
  BEAUFORT_FROM,
  beaufort,
  DETAIL,
  FOAM_BY_FORCE,
  type FoamLook,
  foamAt,
  forceKnots,
  KNOT,
  newFoamLook,
  whitecapCoverage,
} from './look';
import { detailPatch, finerPatch, newSpectrumInputs, spectrumInputs } from './spectrum';

const at = (knots: number): FoamLook => foamAt(knots, newFoamLook());

describe('the foam by Beaufort force', () => {
  it('has a row for every force from 0 to 10, with strengths from 0', () => {
    expect(FOAM_BY_FORCE).toHaveLength(11);
    expect(BEAUFORT_FROM).toHaveLength(11);
    for (const row of FOAM_BY_FORCE) {
      for (const k of ['whitecaps', 'streaks'] as const) {
        expect(row[k]).toBeGreaterThanOrEqual(0);
        expect(row[k]).toBeLessThanOrEqual(4);
      }
      expect(row.folding).toBeGreaterThanOrEqual(0);
      expect(row.folding).toBeLessThanOrEqual(1);
      expect(row.steep).toBeGreaterThanOrEqual(1);
      expect(row.spray).toBeGreaterThanOrEqual(0);
      expect(row.spindrift).toBeGreaterThanOrEqual(0);
      expect(row.threshold).toBeGreaterThan(0);
      expect(row.threshold).toBeLessThan(1);
      expect(row.chop).toBeGreaterThan(0);
      expect(row.decay).toBeGreaterThan(0);
    }
  });

  it('never falls as the wind rises, row by row and knot by knot', () => {
    const fields = [
      'whitecaps',
      'streaks',
      'folding',
      'threshold',
      'chop',
      'decay',
      'steep',
      'spray',
      'spindrift',
    ] as const;
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
    for (let f = 0; f < 10; f++) {
      expect(at(forceKnots(f))).toEqual(FOAM_BY_FORCE[f]);
    }
    expect(forceKnots(3)).toBe(8.5);
    expect(forceKnots(7)).toBe(30.5);
    expect(forceKnots(9)).toBe(44);
    // The top row is read where force 10 ends, and holds above.
    expect(forceKnots(10)).toBe(55);
    expect(at(55)).toEqual(FOAM_BY_FORCE[10]);
    expect(at(70)).toEqual(FOAM_BY_FORCE[10]);
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
    // Spray off the crests from force 7, spindrift from force 8.
    expect(at(27.99).spray).toBe(0);
    expect(at(29).spray).toBeGreaterThan(0);
    expect(at(33.99).spindrift).toBe(0);
    expect(at(35).spindrift).toBeGreaterThan(0);
  });

  it('draws the short sea 2.5 times steeper at force 8 than at force 2, the spectrum’s and the gain’s together', () => {
    // The detail band's rms slope on the high tier's two patches, over open
    // water, by its spectrum, times the gain.
    const sea = catalog.weather.sea;
    const first = detailPatch(sea, 256, DETAIL.patch, DETAIL.period);
    const fine = finerPatch(first, DETAIL.finePatch, DETAIL.fineLongest);
    const slope = (force: number): number => {
      const knots = forceKnots(force);
      const w = { speed: knots * KNOT, east: 1, north: 0, fetch: sea.fetchCap * 1852 };
      const a = spectrumInputs(sea, first, w, newSpectrumInputs()).slope;
      const b = spectrumInputs(sea, fine, w, newSpectrumInputs()).slope;
      return Math.sqrt(a + b) * at(knots).steep;
    };
    const ratio = slope(8) / slope(2);
    expect(ratio).toBeGreaterThan(2.4);
    expect(ratio).toBeLessThan(2.6);
    // And it never flattens as the force rises.
    for (let f = 3; f <= 10; f++) {
      expect(slope(f)).toBeGreaterThan(slope(f - 1));
    }
  });

  it('names the force of a wind', () => {
    expect(beaufort(0.5)).toBe(0);
    expect(beaufort(6)).toBe(2);
    expect(beaufort(7)).toBe(3);
    expect(beaufort(33.9)).toBe(7);
    expect(beaufort(34)).toBe(8);
    expect(beaufort(47.9)).toBe(9);
    expect(beaufort(48)).toBe(10);
    expect(beaufort(80)).toBe(10);
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
