// SPDX-License-Identifier: AGPL-3.0-only

// Every kind drawn as its own: a reefed main's share and whether its model
// gathers the reef along the boom, the camera's size for each boat, and the
// controls' words and the case's reef line from the catalog.

import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { transomFrom } from '../ocean/look';
import { controlsOf, reefLine, sheetLegend, sheetText } from '../ui/model';
import { reefRows, reefShare } from './boat';
import { CHASE, lookSizeOf, MAX_CHASE, mastOf, sizeOf } from './camera';

/** A sail's TEXCOORD_1 rows, as a model of that many rows (and those given) has them. */
function sailWithRows(rows: number[]): BufferGeometry {
  const g = new BufferGeometry();
  const uv1: number[] = [];
  for (const v of rows) {
    uv1.push(0, v, 1, v);
  }
  g.setAttribute('uv1', new BufferAttribute(new Float32Array(uv1), 2));
  return g;
}

describe('a reefed main', () => {
  test('keeps the catalog’s share of its luff at each level, and between them as it is reefed', () => {
    for (const boat of catalog.boats) {
      const reefs = boat.physics.rig.reefs;
      expect(reefShare(reefs, 0)).toBe(1);
      expect(reefShare(reefs, 1)).toBe(reefs[1]);
      expect(reefShare(reefs, 2)).toBe(reefs[2]);
      expect(reefShare(reefs, 3)).toBe(reefs[2]);
      const half = reefShare(reefs, 0.5);
      expect(half).toBeCloseTo((1 + (reefs[1] ?? 1)) / 2, 12);
    }
  });

  test('is gathered along the boom where the model has a row at each reef, else drawn smaller', () => {
    const reefs = [1, 0.85, 0.7];
    const rows = [0, 0.042, 0.083, 0.15, 0.3, 0.5, 1].map((v) => Math.fround(v));
    expect(reefRows(sailWithRows(rows), reefs)).toEqual([
      expect.closeTo(0.15, 6),
      expect.closeTo(0.3, 6),
    ]);
    expect(reefRows(sailWithRows([0, 0.042, 0.5, 1]), reefs)).toBeNull();
    expect(reefRows(sailWithRows(rows), [1, 1, 1])).toBeNull();
  });
});

describe('the camera’s size for a boat', () => {
  test('is 1 for the boat its views are framed for, and grows with a taller or longer one', () => {
    const first = catalog.boats[0];
    expect(sizeOf(first, first)).toBe(1);
    for (const boat of catalog.boats.slice(1)) {
      const s = sizeOf(boat, first);
      expect(s).toBeCloseTo(
        Math.min(
          Math.max(boat.lengthOverall / first.lengthOverall, mastOf(boat) / mastOf(first)),
          MAX_CHASE / CHASE.distance,
        ),
        12,
      );
      expect(s).toBeGreaterThan(1);
      expect(s * CHASE.distance).toBeLessThanOrEqual(MAX_CHASE);
      expect(lookSizeOf(boat, first)).toBeCloseTo(mastOf(boat) / mastOf(first), 12);
    }
  });

  test('looks up to the highest sail’s head: the main’s, the headsails’ or the square sails’', () => {
    for (const boat of catalog.boats) {
      const { rig, headsails, square } = boat.physics;
      expect(mastOf(boat)).toBeGreaterThanOrEqual(rig.boomHeight + rig.luff);
      if (square.squareForeArea + square.squareAfterArea > 0) {
        expect(mastOf(boat)).toBeGreaterThanOrEqual(square.squareFootHeight + square.squareLuff);
      }
      if (headsails.headsailArea > 0) {
        expect(mastOf(boat)).toBeGreaterThanOrEqual(
          headsails.headsailTackHeight + headsails.headsailLuff,
        );
      }
    }
  });
});

describe('the white water behind a transom', () => {
  test('begins at 2.4 m/s on a dinghy’s 3.8 m waterline, faster as the square root of a longer one', () => {
    expect(transomFrom(3.8)).toBeCloseTo(2.4, 2);
    expect(transomFrom(4 * 3.8) / transomFrom(3.8)).toBeCloseTo(2, 12);
  });
});

describe('the controls’ words', () => {
  test('are each boat’s from the catalog, and the case names the reef its sails have', () => {
    for (const boat of catalog.boats) {
      const c = controlsOf(boat);
      const { rig, headsails, square } = boat.physics;
      const braces = square.squareForeArea + square.squareAfterArea > 0;
      expect(c.sheet).toEqual(boat.controls.sheet);
      expect(c.reef).toEqual(boat.controls.reef);
      expect(c.braces).toBe(braces);
      expect(c.reefs).toBe(
        [...rig.reefs, ...headsails.headsailReefs, ...(braces ? square.squareReefs : [])].some(
          (share) => share < 1,
        ),
      );
      expect(reefLine(c, 0)).toBe('');
      expect(reefLine(c, 0.4)).toBe('');
      expect(reefLine(c, 0.6)).toBe(boat.controls.reef[1]);
      expect(reefLine(c, 2)).toBe(boat.controls.reef[2]);
    }
    expect(reefLine(null, 2)).toBe('');
  });

  test('every boat reefs; a boat of square sails has braces, and only its legend names them aback', () => {
    for (const boat of catalog.boats) {
      const c = controlsOf(boat);
      expect(c.reefs).toBe(true);
      expect(sheetLegend(c, '')).toBe(boat.controls.sheet.name);
      expect(sheetLegend(c, 'luffing')).toBe('Luffing');
      expect(sheetLegend(c, 'stalled')).toBe('Stalled');
      expect(sheetLegend(c, 'aback')).toBe(
        c.braces ? `${boat.controls.sheet.name} · Aback` : 'Aback',
      );
    }
    expect(catalog.boats.filter((b) => controlsOf(b).braces)).toHaveLength(1);
    const ship = catalog.boats.find((b) => controlsOf(b).braces);
    expect(sheetText(0.4, 'luffing', ship?.controls.sheet)).toBe('Braces 40%, luffing: brace up');
    expect(sheetText(0.4, 'stalled', ship?.controls.sheet)).toBe('Braces 40%, stalled: square');
    expect(sheetText(0.4, 'aback', ship?.controls.sheet)).toBe('Braces 40%, aback');
  });
});
