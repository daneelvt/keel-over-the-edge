// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  canvasAngle,
  fitView,
  HALF,
  MAX_SCALE,
  MIN_SCALE,
  pan,
  rectOf,
  toScreen,
  toWorld,
  zoomAt,
} from './map';

describe('the map', () => {
  test('fits the whole disk', () => {
    const v = fitView(800, 600);
    expect(toScreen(v, 0, 0)).toEqual([400, 300]);
    const [x0, y0] = toScreen(v, -HALF, HALF);
    const [x1, y1] = toScreen(v, HALF, -HALF);
    expect(y0).toBeCloseTo(0, 9);
    expect(y1).toBeCloseTo(600, 9);
    expect(x1 - x0).toBeCloseTo(600, 9);
  });

  test('a click goes back to the world point within a pixel, at every zoom', () => {
    let v = fitView(1000, 700);
    for (const factor of [1, 4, 30, 200, 1000]) {
      v = zoomAt(fitView(1000, 700), 300, 200, factor);
      for (const [e, n] of [
        [0, 0],
        [-8334, 0],
        [1679, -1191],
        [v.east + 3 * v.scale, v.north - 2 * v.scale],
      ]) {
        const [x, y] = toScreen(v, e as number, n as number);
        const [e2, n2] = toWorld(v, Math.round(x), Math.round(y));
        expect(
          Math.hypot((e2 - (e as number)) / v.scale, (n2 - (n as number)) / v.scale),
        ).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9);
      }
    }
  });

  test('zooms about the pointer, which stays over the same point, within its limits', () => {
    const v = fitView(800, 600);
    const before = toWorld(v, 123, 456);
    const z = zoomAt(v, 123, 456, 3);
    const after = toWorld(z, 123, 456);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
    expect(z.scale).toBeCloseTo(v.scale / 3, 9);
    expect(zoomAt(v, 0, 0, 1e9).scale).toBe(MIN_SCALE);
    expect(zoomAt(v, 0, 0, 1e-9).scale).toBe(MAX_SCALE);
  });

  test('pans with the pointer: north up', () => {
    const v = fitView(800, 600);
    const p = pan(v, 10, 20);
    expect(toScreen(p, 0, 0)).toEqual([410, 320]);
  });

  test('a world rectangle, and bearings, on the canvas', () => {
    const v = { east: 0, north: 0, scale: 2, width: 100, height: 100 };
    expect(rectOf(v, -10, -20, 30, 40)).toEqual([45, 30, 20, 30]);
    // North is up the canvas, east to its right.
    expect(Math.sin(canvasAngle(0))).toBeCloseTo(-1, 9);
    expect(Math.cos(canvasAngle(90))).toBeCloseTo(1, 9);
  });
});
