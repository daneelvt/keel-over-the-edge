// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { FAR_MIN, farGeometry, farRadius } from './far';
import { TILE_RADIUS } from './hex';
import { tileGeometry } from './tiles';

function faceNormal(pos: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const p = (i: number, k: number): number => pos[i * 3 + k] ?? 0;
  const u = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)] as const;
  const v = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)] as const;
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

describe('the tile', () => {
  const g = tileGeometry();

  test('has 19 vertices and 18 triangles', () => {
    expect(g.position.length / 3).toBe(19);
    expect(g.index.length / 3).toBe(18);
  });

  test('its top faces up and its skirt faces out', () => {
    for (let t = 0; t < 18; t++) {
      const [a, b, c] = [g.index[t * 3] ?? 0, g.index[t * 3 + 1] ?? 0, g.index[t * 3 + 2] ?? 0];
      const n = faceNormal(g.position, a, b, c);
      const top = [a, b, c].every((i) => (g.position[i * 3 + 1] ?? 0) === 0);
      if (top) {
        expect(n[1]).toBeGreaterThan(0);
      } else {
        // Outward: along the triangle's own offset from the centre.
        const mx = [a, b, c].reduce((s, i) => s + (g.position[i * 3] ?? 0), 0);
        const mz = [a, b, c].reduce((s, i) => s + (g.position[i * 3 + 2] ?? 0), 0);
        expect(n[0] * mx + n[2] * mz).toBeGreaterThan(0);
        expect(Math.abs(n[1])).toBeLessThan(1e-9);
      }
    }
  });

  test('its corners are the hexagon’s, pointing east and west', () => {
    const xs: number[] = [];
    for (let i = 1; i <= 6; i++) {
      expect(Math.hypot(g.position[i * 3] ?? 0, g.position[i * 3 + 2] ?? 0)).toBeCloseTo(
        TILE_RADIUS,
        6,
      );
      xs.push(g.position[i * 3] ?? 0);
    }
    expect(Math.max(...xs)).toBeCloseTo(TILE_RADIUS, 6);
  });
});

describe('the far sea', () => {
  test('reaches past the horizon for the camera’s height, and at least 400 m', () => {
    expect(farRadius(2)).toBe(FAR_MIN);
    expect(farRadius(8)).toBe(FAR_MIN);
    expect(farRadius(20)).toBe(FAR_MIN);
    expect(farRadius(60)).toBeCloseTo(1.1 * Math.sqrt(2 * 2500 * 60), 9);
    expect(farRadius(160)).toBeCloseTo(983.9, 1);
  });

  test('is a polar grid of 60 rings by 200 spokes, faces up', () => {
    const g = farGeometry();
    expect(g.getAttribute('position').count).toBe(12000);
    expect((g.index?.count ?? 0) / 3).toBe(59 * 200 * 2);
  });
});
