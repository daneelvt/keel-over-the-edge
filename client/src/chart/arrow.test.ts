// SPDX-License-Identifier: AGPL-3.0-only

import { PerspectiveCamera, Vector2 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  ARROW_LEAST,
  ARROW_MOST,
  arrowLength,
  arrowScale,
  arrowSize,
  placeChartCamera,
} from './arrow';

/** The chart's camera: its field of view, its elevation, and the disk's lip, m. */
const FOV = 35;
const TILT = 0.95;
const LIP = 8334;

/** The arrow's length on a 360 × 640 chart looking at the boat from distance m, heading north, and its scale. */
function seen(distance: number): { length: number; scale: number } {
  const camera = new PerspectiveCamera(FOV, 360 / 640, 50, 120000);
  camera.updateProjectionMatrix();
  const boat = { east: 0, north: 0, heading: 0 };
  placeChartCamera(camera, new Vector2(0, 0), distance, 0, TILT);
  const scale = arrowSize(camera, 360, 640, boat);
  return { length: arrowLength(camera, 360, 640, boat, scale), scale };
}

describe('the boat’s arrow on the chart', () => {
  test('keeps its size in metres while it is between 12 and 32 pixels long', () => {
    expect(arrowScale(24)).toBe(1);
    expect(arrowScale(ARROW_LEAST)).toBe(1);
    expect(arrowScale(ARROW_MOST)).toBe(1);
    expect(arrowScale(6)).toBe(2);
    expect(arrowScale(64)).toBe(0.5);
    // Off the screen or behind the camera: its own size.
    expect(arrowScale(Number.NaN)).toBe(1);
  });

  test('shrinks with the world as the chart zooms out, held at the bounds', () => {
    const near = seen(900);
    const opened = seen(9000);
    const disk = seen(LIP * 3.4);
    const far = seen(30000);
    // Zoomed in, held at 32 pixels: smaller than its own size.
    expect(near.length).toBeCloseTo(ARROW_MOST, 1);
    expect(near.scale).toBeLessThan(1);
    // As the chart opens: its own size, 260 m, about 24 pixels on a 640-pixel chart.
    expect(opened.scale).toBe(1);
    expect(opened.length).toBeGreaterThan(20);
    expect(opened.length).toBeLessThan(28);
    // The whole disk and further: held at 12 pixels, larger than its own size.
    expect(disk.length).toBeCloseTo(ARROW_LEAST, 1);
    expect(disk.scale).toBeGreaterThan(1);
    expect(far.length).toBeCloseTo(ARROW_LEAST, 1);
    expect(far.scale).toBeGreaterThan(disk.scale);
    // Never growing as the chart zooms out.
    const lengths = [900, 3000, 6000, 9000, 14000, 20000, 30000].map((d) => seen(d).length);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeLessThanOrEqual((lengths[i - 1] ?? 0) + 0.05);
    }
  });
});
