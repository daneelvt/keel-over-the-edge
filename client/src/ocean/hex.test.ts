// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { DISK_RADIUS } from '../render/coords';
import {
  FIELD_RADIUS,
  hexAt,
  hexCentre,
  hexDistance,
  makeField,
  NEIGHBOURS,
  TILE_ACROSS,
  TILE_APOTHEM,
  TILE_RADIUS,
  tileHash,
} from './hex';

const p = { x: 0, y: 0 };
const h = { q: 0, r: 0 };

describe('the lattice', () => {
  test('tiles are 4 m across the flats, with neighbours 4 m apart', () => {
    expect(TILE_ACROSS).toBe(4);
    expect(2 * TILE_APOTHEM).toBe(4);
    for (const n of NEIGHBOURS) {
      hexCentre(n.q, n.r, p);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(4, 12);
      expect(hexDistance({ q: 0, r: 0 }, n)).toBe(1);
    }
  });

  test('corners point east and west: the tile to the north shares a flat edge', () => {
    hexCentre(0, 1, p);
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(4, 12);
    // East is a corner: 2.309 m out, still in the centre tile; 2.4 m is not.
    expect(hexAt(TILE_RADIUS - 0.01, 0, h)).toEqual({ q: 0, r: 0 });
    expect(hexAt(TILE_RADIUS + 0.01, 0, h)).not.toEqual({ q: 0, r: 0 });
    // North is a flat: 2 m out is the edge.
    expect(hexAt(0, TILE_APOTHEM - 0.01, h)).toEqual({ q: 0, r: 0 });
    expect(hexAt(0, TILE_APOTHEM + 0.01, h)).toEqual({ q: 0, r: 1 });
  });

  test('rounding finds the tile containing a point, beside every edge and corner', () => {
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        hexCentre(q, r, p);
        const cx = p.x;
        const cy = p.y;
        for (let k = 0; k < 6; k++) {
          // Just inside each corner and the middle of each edge.
          const ca = (k * Math.PI) / 3;
          const ea = ca + Math.PI / 6;
          for (const [a, d] of [
            [ca, TILE_RADIUS],
            [ea, TILE_APOTHEM],
          ] as [number, number][]) {
            expect(hexAt(cx + Math.cos(a) * (d - 1e-6), cy + Math.sin(a) * (d - 1e-6), h)).toEqual({
              q,
              r,
            });
            expect(
              hexAt(cx + Math.cos(a) * (d + 1e-6), cy + Math.sin(a) * (d + 1e-6), h),
            ).not.toEqual({ q, r });
          }
        }
      }
    }
  });

  test('centre and rounding round-trip across the disk', () => {
    const reach = Math.ceil(DISK_RADIUS / (1.5 * TILE_RADIUS));
    for (let i = 0; i < 20000; i++) {
      const q = Math.round((Math.sin(i * 12.9898) * 0.5 + 0.5) * 2 * reach - reach) + 0;
      const r = Math.round((Math.sin(i * 78.233) * 0.5 + 0.5) * 2 * reach - reach) + 0;
      hexCentre(q, r, p);
      if (Math.hypot(p.x, p.y) > DISK_RADIUS) {
        continue;
      }
      expect(hexAt(p.x, p.y, h)).toEqual({ q, r });
      expect(Math.abs(q)).toBeLessThanOrEqual(2406);
      expect(Math.abs(r)).toBeLessThanOrEqual(2406 * 2);
    }
  });
});

describe('the field', () => {
  const field = makeField();

  test('holds every tile within 150 m: 5,101', () => {
    expect(field.count).toBe(5101);
    for (let i = 0; i < field.count; i++) {
      expect(
        Math.hypot(field.offset[i * 2] ?? 0, field.offset[i * 2 + 1] ?? 0),
      ).toBeLessThanOrEqual(FIELD_RADIUS);
    }
  });

  test('starts with the centre tile, nearest first, each tile once', () => {
    expect([field.hex[0], field.hex[1]]).toEqual([0, 0]);
    const seen = new Set<string>();
    let last = 0;
    for (let i = 0; i < field.count; i++) {
      const d = Math.hypot(field.offset[i * 2] ?? 0, field.offset[i * 2 + 1] ?? 0);
      expect(d).toBeGreaterThanOrEqual(last - 1e-9);
      last = d;
      seen.add(`${field.hex[i * 2]},${field.hex[i * 2 + 1]}`);
    }
    expect(seen.size).toBe(field.count);
  });
});

describe('the tile hash', () => {
  test('is 24 bits, fixed, and spreads', () => {
    expect(tileHash(0, 0)).toBe(tileHash(0, 0));
    const values = new Set<number>();
    let sum = 0;
    for (let q = -50; q < 50; q++) {
      for (let r = -50; r < 50; r++) {
        const v = tileHash(q, r);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(2 ** 24);
        expect(Number.isInteger(v)).toBe(true);
        values.add(v);
        sum += v / 2 ** 24;
      }
    }
    expect(values.size).toBeGreaterThan(9990);
    expect(sum / 10000).toBeCloseTo(0.5, 1);
  });

  test('does not change: these values are drawn on every phone', () => {
    expect([
      tileHash(0, 0),
      tileHash(1, 0),
      tileHash(-2406, 1203),
      tileHash(17, -9),
    ]).toMatchSnapshot();
  });
});
