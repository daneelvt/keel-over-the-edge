// SPDX-License-Identifier: AGPL-3.0-only

import { Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import {
  angleDiff,
  CAMERA_PRESETS,
  CHASE,
  ChaseCamera,
  EASE_BACK_AFTER,
  MAX_DISTANCE,
  MIN_DISTANCE,
  MIN_HEIGHT,
} from './camera';

const DEG = Math.PI / 180;

/** Runs the camera at 60 frames a second behind a boat on a heading; returns the largest overshoot and when it settled within a degree. */
function follow(cam: ChaseCamera, heading: number, seconds: number, t0 = 0) {
  let overshoot = 0;
  let settled = -1;
  const start = angleDiff(cam.yaw, heading);
  for (let i = 1; i <= seconds * 60; i++) {
    cam.update(1 / 60, heading, t0 + (i * 1000) / 60);
    const off = angleDiff(cam.yaw, heading);
    if (Math.sign(off) !== 0 && Math.sign(off) !== Math.sign(start)) {
      overshoot = Math.max(overshoot, Math.abs(off));
    }
    if (settled < 0 && Math.abs(off) < 1 * DEG) {
      settled = i / 60;
    }
  }
  return { overshoot, settled };
}

describe('the chase camera', () => {
  test('swings round behind the boat within 2 s of a 180° turn, without overshoot', () => {
    for (const reduced of [false, true]) {
      const cam = new ChaseCamera();
      cam.reducedMotion = reduced;
      cam.place(CHASE, 0.3);
      const r = follow(cam, 0.3 + Math.PI - 1e-3, 3);
      expect(r.overshoot).toBe(0);
      expect(r.settled).toBeGreaterThan(0);
      expect(r.settled).toBeLessThan(2);
    }
  });

  test('is stiffer with reduced motion', () => {
    const a = new ChaseCamera();
    const b = new ChaseCamera();
    b.reducedMotion = true;
    a.place(CHASE, 0);
    b.place(CHASE, 0);
    a.update(0.2, 1, 0);
    b.update(0.2, 1, 0);
    expect(Math.abs(angleDiff(b.yaw, 1))).toBeLessThan(Math.abs(angleDiff(a.yaw, 1)) / 2);
  });

  test('takes the short way across north', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 3.1);
    cam.update(0.1, -3.1, 0);
    expect(Math.abs(angleDiff(cam.yaw, Math.PI))).toBeLessThan(0.1);
  });

  test('eases back to its resting view 5 s after the last touch', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    cam.drag(-200, 60, 1000);
    const swung = cam.view.azimuth;
    expect(swung).toBeGreaterThan(1);
    // Within 5 s it stays where it was put.
    for (let t = 1000; t <= 1000 + EASE_BACK_AFTER; t += 1000 / 60) {
      cam.update(1 / 60, 0, t);
    }
    expect(cam.view.azimuth).toBe(swung);
    // Then it eases back.
    for (let t = 1000 + EASE_BACK_AFTER; t < 1000 + EASE_BACK_AFTER + 6000; t += 1000 / 60) {
      cam.update(1 / 60, 0, t);
    }
    expect(Math.abs(cam.view.azimuth - CHASE.azimuth)).toBeLessThan(0.01);
    expect(Math.abs(cam.view.elevation - CHASE.elevation)).toBeLessThan(0.01);
  });

  test('keeps its distance and elevation in their limits, and stays above 1.5 m', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    cam.zoom(100, 0);
    expect(cam.view.distance).toBe(MAX_DISTANCE);
    cam.zoom(0.001, 0);
    expect(cam.view.distance).toBe(MIN_DISTANCE);
    cam.drag(0, -10_000, 0);
    expect(cam.view.elevation).toBeGreaterThan(0);
    cam.drag(0, 10_000, 0);
    expect(cam.view.elevation).toBeLessThan(Math.PI / 2);
    const p = new Vector3();
    const t = new Vector3();
    for (const e of [-0.5, 0, 0.03]) {
      cam.view.elevation = e;
      cam.place3(0, 0, 0, p, t);
      expect(p.y).toBeGreaterThanOrEqual(MIN_HEIGHT);
    }
  });

  test('sits astern of the boat, whatever its heading', () => {
    const cam = new ChaseCamera();
    const p = new Vector3();
    const t = new Vector3();
    for (const h of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1]) {
      cam.place({ azimuth: 0, elevation: 0, distance: 10 }, h);
      cam.place3(5, 0, 7, p, t);
      // The bow points to (sin h, −cos h) in the scene's x and z.
      const along = (p.x - 5) * Math.sin(h) + (p.z - 7) * -Math.cos(h);
      expect(along).toBeCloseTo(-10, 9);
    }
  });

  test('the presets keep the earlier views of a boat heading 330°', () => {
    // The earlier orbit views put the camera at a scene azimuth a, (cos a, sin a) in x and z.
    const earlier: Record<string, number> = { sea: 2.15, bands: 2.3, aboard: 2.45, high: 2.3 };
    const cam = new ChaseCamera();
    const p = new Vector3();
    const t = new Vector3();
    for (const [name, a] of Object.entries(earlier)) {
      const v = CAMERA_PRESETS[name];
      if (v === undefined) {
        throw new Error(name);
      }
      cam.place(v, 330 * DEG);
      cam.place3(0, 0, 0, p, t);
      expect(angleDiff(Math.atan2(p.z, p.x), a)).toBeCloseTo(0, 3);
    }
  });
});
