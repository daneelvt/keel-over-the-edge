// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { FIELD_RADIUS, hexAt, hexCentre } from '../ocean/hex';
import {
  DISK_RADIUS,
  FloatingOrigin,
  headingToRotationY,
  ORIGIN_SHIFT,
  rotationYToHeading,
  sceneToWorld,
  worldToScene,
} from './coords';

/** Where a heading's rotation about y takes the scene's north (-z). */
function pointing(heading: number): [number, number] {
  const a = headingToRotationY(heading);
  // three.js's rotation about y takes (x, z) to (x cos a + z sin a, -x sin a + z cos a).
  return [-Math.sin(a), -Math.cos(a)];
}

describe('axes', () => {
  test('world to scene and back', () => {
    const s = worldToScene(120.5, -33.25, 2, { x: 0, y: 0, z: 0 });
    expect(s).toEqual({ x: 120.5, y: 2, z: 33.25 });
    expect(sceneToWorld(s.x, s.z, { x: 0, y: 0 })).toEqual({ x: 120.5, y: -33.25 });
  });

  test('north is -z, and a heading of 90° points along +x', () => {
    expect(worldToScene(0, 1, 0, { x: 0, y: 0, z: 0 }).z).toBe(-1);
    const [x, z] = pointing(Math.PI / 2);
    expect(x).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
    const [x0, z0] = pointing(0);
    expect(x0).toBeCloseTo(0, 12);
    expect(z0).toBeCloseTo(-1, 12);
    expect(rotationYToHeading(headingToRotationY(1.234))).toBe(1.234);
  });
});

describe('the floating origin', () => {
  test('always lands on a tile centre, and the field on the tile under the boat', () => {
    const o = new FloatingOrigin();
    const c = { x: 0, y: 0 };
    const h = { q: 0, r: 0 };
    for (let i = 0; i < 2000; i++) {
      const a = i * 2.39996;
      const d = (i / 2000) * DISK_RADIUS;
      o.follow(d * Math.cos(a), d * Math.sin(a));
      hexCentre(o.hex.q, o.hex.r, c);
      expect(o.world).toEqual(c);
      expect(o.centre).toEqual(hexAt(d * Math.cos(a), d * Math.sin(a), h));
    }
  });

  test('moves only when the boat is more than 500 m away', () => {
    const o = new FloatingOrigin();
    expect(o.follow(0, 0)).toBe(true);
    expect(o.follow(ORIGIN_SHIFT - 1, 0)).toBe(false);
    expect(o.world).toEqual({ x: 0, y: 0 });
    expect(o.follow(ORIGIN_SHIFT + 1, 0)).toBe(true);
    expect(Math.abs(o.world.x - (ORIGIN_SHIFT + 1))).toBeLessThan(2.5);
  });

  test('every position handed to the GPU is under 700 m, anywhere on the disk', () => {
    const o = new FloatingOrigin();
    const s = { x: 0, y: 0, z: 0 };
    const c = { x: 0, y: 0 };
    // A boat sailing a long spiral out to the rim and round it.
    for (let i = 0; i <= 200000; i++) {
      const t = i / 200000;
      const d = t * DISK_RADIUS;
      const a = t * 40 * Math.PI;
      const e = d * Math.cos(a);
      const n = d * Math.sin(a);
      o.follow(e, n);
      // The boat, and the centre of the tile field with its farthest tile.
      o.toScene(e, n, 0, s);
      expect(Math.hypot(s.x, s.z)).toBeLessThan(700);
      hexCentre(o.centre.q, o.centre.r, c);
      o.toScene(c.x, c.y, 0, s);
      expect(Math.hypot(s.x, s.z) + FIELD_RADIUS).toBeLessThan(700);
    }
  });
});
