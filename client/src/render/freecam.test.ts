// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  FLY_FAST,
  FLY_HIGH,
  FLY_LOW,
  FreeCamera,
  flySpeed,
  ROAM_BEYOND,
  ROAM_EVERY_METRES,
  ROAM_HIGH,
  ROAM_LOW,
  RoamTeller,
} from './freecam';

function point() {
  return {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };
}

describe('the free camera', () => {
  test('its speed rises with its height', () => {
    expect(flySpeed(ROAM_LOW)).toBeCloseTo(FLY_LOW, 9);
    expect(flySpeed(ROAM_HIGH)).toBeCloseTo(FLY_HIGH, 9);
    expect(flySpeed(100)).toBeGreaterThan(flySpeed(50));
  });

  test('the keys fly it level, the way it looks, Shift faster', () => {
    const c = new FreeCamera();
    c.enter(0, 0, 10, Math.PI / 2, -0.5);
    c.keys.forward = true;
    c.update(0.1);
    const step = c.east;
    expect(step).toBeCloseTo(flySpeed(10) * 0.1, 6);
    expect(Math.abs(c.north)).toBeLessThan(1e-9);
    expect(c.height).toBe(10);
    c.keys.fast = true;
    c.update(0.1);
    expect(c.east - step).toBeCloseTo(flySpeed(10) * FLY_FAST * 0.1, 6);
    c.keys.forward = false;
    c.keys.fast = false;
    c.keys.up = true;
    c.update(0.1);
    expect(c.height).toBeGreaterThan(10);
  });

  test('it roams the disk and 500 m beyond the lip, 2 m to 500 m up, above the land', () => {
    const c = new FreeCamera();
    c.lip = 8334;
    c.enter(20000, 0, 10000, 0, 0);
    expect(c.east).toBeCloseTo(8334 + ROAM_BEYOND, 6);
    expect(c.height).toBe(ROAM_HIGH);
    c.ground = () => 30;
    c.enter(0, 0, 1, 0, 0);
    expect(c.height).toBe(30 + ROAM_LOW);
    c.ground = () => null;
    c.enter(0, 0, -5, 0, 0);
    expect(c.height).toBe(ROAM_LOW);
  });

  test('a flick of two fingers glides on, unless motion is reduced', () => {
    const c = new FreeCamera();
    c.enter(0, 0, 100, 0, -0.3);
    c.pan(0, 50, 0.05);
    const after = c.north;
    expect(after).toBeGreaterThan(0);
    c.update(0.1);
    expect(c.north).toBeGreaterThan(after);
    const r = new FreeCamera();
    r.reducedMotion = true;
    r.enter(0, 0, 100, 0, -0.3);
    r.pan(0, 50, 0.05);
    const at = r.north;
    r.update(0.1);
    expect(r.north).toBe(at);
  });

  test('it is placed where it is, relative to the floating origin, looking its way', () => {
    const c = new FreeCamera();
    c.enter(1000, 2000, 50, 0, 0);
    const p = point();
    const t = point();
    c.place(900, 1900, p, t);
    expect([p.x, p.y, p.z]).toEqual([100, 50, -100]);
    // Looking north: the scene's −z.
    expect(t.z).toBeCloseTo(-101, 9);
    expect(t.x).toBeCloseTo(100, 9);
  });

  test('the server is told as it leaves, every 20 m and no more than 5 a second, and as it comes back', () => {
    const c = new FreeCamera();
    const told: [boolean, number][] = [];
    const r = new RoamTeller();
    const send = (on: boolean, east: number) => told.push([on, east]);
    r.tell(c, 0, send);
    expect(told).toEqual([]);
    c.enter(0, 0, 50, Math.PI / 2, 0);
    r.tell(c, 0, send);
    c.east = ROAM_EVERY_METRES - 1;
    r.tell(c, 1, send);
    c.east = ROAM_EVERY_METRES + 1;
    r.tell(c, 0.1, send);
    r.tell(c, 1, send);
    c.leave();
    r.tell(c, 2, send);
    r.tell(c, 3, send);
    expect(told).toEqual([
      [true, 0],
      [true, ROAM_EVERY_METRES + 1],
      [false, 0],
    ]);
  });
});
