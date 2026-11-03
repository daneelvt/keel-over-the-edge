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
  MAX_GAZE,
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

  test('watching another’s boat it does not ease back by itself; Back to the boat brings it back', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    cam.watching = true;
    cam.drag(-200, -400, 1000);
    const swung = cam.view.azimuth;
    expect(cam.looksUp).toBe(true);
    for (let t = 1000; t < 1000 + 3 * EASE_BACK_AFTER; t += 1000 / 60) {
      cam.update(1 / 60, 0, t);
    }
    expect(cam.view.azimuth).toBe(swung);
    cam.behind();
    expect(cam.looksUp).toBe(false);
    let t = 1000 + 3 * EASE_BACK_AFTER;
    for (let i = 0; i < 6 * 60; i++) {
      t += 1000 / 60;
      cam.update(1 / 60, 0, t);
    }
    expect(Math.abs(cam.view.azimuth - CHASE.azimuth)).toBeLessThan(0.01);
    expect(Math.abs(cam.view.elevation - CHASE.elevation)).toBeLessThan(0.01);
    // Back there, a drag holds again.
    cam.drag(-200, 0, t);
    const again = cam.view.azimuth;
    for (let i = 0; i < 60 * 10; i++) {
      t += 1000 / 60;
      cam.update(1 / 60, 0, t);
    }
    expect(cam.view.azimuth).toBe(again);
  });

  test('rises and falls with the boat, over half a second, and not with its heel or pitch', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    const p = new Vector3();
    const t = new Vector3();
    cam.place3(0, 0, 0, p, t);
    const rest = { camera: p.y, target: t.y };
    // The boat rises 0.6 m on a wave, and stays there.
    let t0 = 0;
    for (let i = 0; i < 30; i++) {
      t0 += 1000 / 60;
      cam.update(1 / 60, 0, t0, 0.6, 0.6);
    }
    cam.place3(0, 0, 0, p, t);
    // After half a second, 63% of the way.
    expect(t.y - rest.target).toBeCloseTo(0.6 * (1 - Math.exp(-1)), 3);
    expect(p.y - rest.camera).toBeCloseTo(t.y - rest.target, 12);
    for (let i = 0; i < 300; i++) {
      t0 += 1000 / 60;
      cam.update(1 / 60, 0, t0, 0.6, 0.6);
    }
    cam.place3(0, 0, 0, p, t);
    expect(t.y - rest.target).toBeCloseTo(0.6, 4);
    // Placed, it is there at once.
    cam.place(CHASE, 0, -0.4, -0.4);
    cam.place3(0, 0, 0, p, t);
    expect(t.y - rest.target).toBeCloseTo(-0.4, 12);
  });

  test('stays 1.6 m above the sea under the boat, on a crest too', () => {
    const cam = new ChaseCamera();
    cam.place({ azimuth: 0, elevation: 0.03, distance: 6 }, 0);
    const p = new Vector3();
    const t = new Vector3();
    // In a trough the boat is low, and the camera with it, but not below the floor.
    cam.place({ azimuth: 0, elevation: -0.4, distance: 6 }, 0, 0.9, 0.9);
    cam.place3(0, 0, 0, p, t);
    expect(p.y).toBeCloseTo(0.9 + MIN_HEIGHT, 12);
    expect(MIN_HEIGHT).toBe(1.6);
  });

  test('keeps its distance and elevation in their limits, and stays above the sea', () => {
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

  test('a drag past the lowest view tilts the gaze up, and the opposite drag brings it back the same way', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    const pos = new Vector3();
    const target = new Vector3();
    const gaze = (): number => {
      cam.place3(0, 0, 0, pos, target);
      const d = target.clone().sub(pos);
      return Math.atan2(d.y, Math.hypot(d.x, d.z));
    };
    const path: number[][] = [];
    // Down to the lowest view, the camera lowering and still looking at the
    // boat, then on, the gaze lifting, to the zenith.
    for (let i = 0; i < 330; i++) {
      path.push([cam.view.elevation, cam.tilt, gaze()]);
      cam.drag(0, -1, 0);
      if (i === 50) {
        expect(cam.view.elevation).toBeCloseTo(0.03, 9);
        expect(cam.tilt).toBeGreaterThan(0);
      }
    }
    expect(gaze()).toBeCloseTo(MAX_GAZE, 9);
    expect(gaze()).toBeGreaterThan(89.8 * DEG);
    expect(cam.looksUp).toBe(true);
    // The camera never left its place, 1.6 m above the sea at least.
    expect(pos.y).toBeGreaterThanOrEqual(MIN_HEIGHT - 1e-9);
    // Back again: every step of the way retraced.
    for (let i = 329; i >= 0; i--) {
      cam.drag(0, 1, 0);
      const [e, t, g] = path[i] as number[];
      expect(cam.view.elevation).toBeCloseTo(e as number, 9);
      expect(cam.tilt).toBeCloseTo(t as number, 9);
      expect(gaze()).toBeCloseTo(g as number, 9);
    }
    expect(cam.tilt).toBe(0);
  });

  test('looking up, it does not ease back by itself, with reduced motion or without', () => {
    for (const reduced of [false, true]) {
      const cam = new ChaseCamera();
      cam.reducedMotion = reduced;
      cam.place(CHASE, 0);
      for (let i = 0; i < 200; i++) {
        cam.drag(0, -10, 0);
      }
      const tilt = cam.tilt;
      const elevation = cam.view.elevation;
      for (let i = 1; i <= 60 * 20; i++) {
        cam.update(1 / 60, 0, (i * 1000) / 60);
      }
      expect(cam.tilt).toBe(tilt);
      expect(cam.view.elevation).toBe(elevation);
    }
  });

  test('a small tilt that still looks below the horizon eases back with the rest', () => {
    const cam = new ChaseCamera();
    cam.place(CHASE, 0);
    for (let i = 0; i < 48; i++) {
      cam.drag(0, -1, 0);
    }
    expect(cam.tilt).toBeGreaterThan(0);
    expect(cam.looksUp).toBe(false);
    for (let i = 1; i <= 60 * 10; i++) {
      cam.update(1 / 60, 0, (i * 1000) / 60);
    }
    expect(cam.tilt).toBe(0);
    expect(cam.view.elevation).toBeCloseTo(CHASE.elevation, 2);
  });

  /** The camera's bearing from the boat and the way it looks, as bearings clockwise from north, for a boat at (east, north). */
  const seen = (cam: ChaseCamera, east: number, north: number) => {
    const p = new Vector3();
    const t = new Vector3();
    // The scene's x is east and its z south.
    cam.place3(east, 0, -north, p, t);
    return {
      from: Math.atan2(p.x - east, -(p.z + north)),
      looks: Math.atan2(t.x - p.x, -(t.z - p.z)),
    };
  };

  describe('a new boat’s opening view', () => {
    const mouth = { east: -300, north: 800 };

    test('stands beyond the boat from the harbour’s mouth, at the resting height and distance, looking at it', () => {
      for (const [east, north, heading] of [
        [200, -400, 0],
        [-900, 100, 2.5],
        [-300, -700, -1.2],
        [600, 1300, Math.PI],
      ] as const) {
        const cam = new ChaseCamera();
        cam.place(CHASE, heading);
        cam.drag(80, -40, 0);
        cam.zoom(1.6, 0);
        cam.open(east, north, mouth.east, mouth.north);
        expect(cam.opening).toBe(true);
        const toBoat = Math.atan2(east - mouth.east, north - mouth.north);
        const s = seen(cam, east, north);
        expect(Math.abs(angleDiff(s.from, toBoat))).toBeLessThan(1e-9);
        expect(Math.abs(angleDiff(s.looks, toBoat + Math.PI))).toBeLessThan(1e-9);
        expect(cam.view.azimuth).toBeCloseTo(angleDiff(toBoat - heading - Math.PI, 0), 12);
        expect(cam.view.elevation).toBe(CHASE.elevation);
        expect(cam.view.distance).toBe(CHASE.distance);
        expect(cam.tilt).toBe(0);
      }
    });

    test('holds, whichever way the boat turns, until the first touch', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0.4);
      cam.open(200, -400, mouth.east, mouth.north);
      const toBoat = Math.atan2(200 - mouth.east, -400 - mouth.north);
      let t = 0;
      for (let i = 0; i < (60 * 3 * EASE_BACK_AFTER) / 1000; i++) {
        t += 1000 / 60;
        // The boat swings about as it lies.
        cam.update(1 / 60, 0.4 + 0.8 * Math.sin(t / 1500), t);
      }
      expect(cam.opening).toBe(true);
      expect(Math.abs(angleDiff(seen(cam, 200, -400).from, toBoat))).toBeLessThan(1e-9);
    });

    /** Runs the camera for seconds behind a boat heading 0.4; returns the time at the end. */
    const run = (cam: ChaseCamera, t: number, seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 0.4, t);
      }
      return t;
    };
    const opened = () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0.4);
      cam.open(200, -400, mouth.east, mouth.north);
      return { cam, t: run(cam, 0, 1) };
    };
    const behind = (cam: ChaseCamera) =>
      Math.abs(angleDiff(cam.view.azimuth, CHASE.azimuth)) < 0.01 &&
      Math.abs(cam.view.elevation - CHASE.elevation) < 0.01;

    test('a touch of the helm, the sheet or the autopilot eases it behind the boat at once', () => {
      const { cam, t } = opened();
      expect(behind(cam)).toBe(false);
      cam.controlsTouched();
      expect(cam.opening).toBe(false);
      run(cam, t, 5);
      expect(behind(cam)).toBe(true);
    });

    test('a look round lets it go, easing back five seconds after the last touch', () => {
      for (const touch of ['drag', 'pinch', 'hold'] as const) {
        const { cam, t } = opened();
        if (touch === 'drag') {
          cam.drag(-30, 0, t);
        } else if (touch === 'pinch') {
          cam.zoom(1.2, t);
        } else {
          cam.holding = true;
          cam.update(1 / 60, 0.4, t);
          cam.holding = false;
        }
        expect(cam.opening).toBe(false);
        const looked = cam.view.azimuth;
        let at = run(cam, t, (EASE_BACK_AFTER - 500) / 1000);
        expect(cam.view.azimuth).toBe(looked);
        at = run(cam, at, 6);
        expect(behind(cam)).toBe(true);
      }
    });

    test('Back to the boat, a placed view or another’s boat watched lets it go', () => {
      for (const end of ['behind', 'place', 'watch'] as const) {
        const { cam, t } = opened();
        if (end === 'behind') {
          cam.behind();
        } else if (end === 'place') {
          cam.place(CHASE, 0.4);
        } else {
          cam.watching = true;
        }
        run(cam, t, 0.1);
        expect(cam.opening).toBe(false);
      }
    });
  });
  describe('Back to the boat', () => {
    /** Runs the camera for seconds behind a boat heading 0; returns the time at the end. */
    const run = (cam: ChaseCamera, t: number, seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 0, t);
      }
      return t;
    };

    test('brings the camera behind the boat at its resting view and distance, the tilt and opening gone', () => {
      for (const watching of [false, true]) {
        const cam = new ChaseCamera();
        cam.place(CHASE, 0);
        cam.watching = watching;
        cam.open(200, -400, -300, 800);
        cam.zoom(5, 0);
        cam.drag(-150, -500, 0);
        expect(cam.view.distance).toBe(MAX_DISTANCE);
        expect(cam.looksUp).toBe(true);
        expect(cam.resting).toBe(false);
        cam.behind();
        expect(cam.opening).toBe(false);
        expect(cam.tilt).toBe(0);
        run(cam, 0, 6);
        expect(Math.abs(angleDiff(cam.view.azimuth, CHASE.azimuth))).toBeLessThan(0.01);
        expect(Math.abs(cam.view.elevation - CHASE.elevation)).toBeLessThan(0.01);
        expect(Math.abs(cam.view.distance - CHASE.distance)).toBeLessThan(0.05);
        expect(cam.resting).toBe(true);
      }
    });

    test('easing back by itself keeps a pinch’s distance', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0);
      cam.zoom(2, 0);
      cam.drag(-100, 0, 0);
      run(cam, 0, (EASE_BACK_AFTER + 6000) / 1000);
      expect(Math.abs(angleDiff(cam.view.azimuth, CHASE.azimuth))).toBeLessThan(0.01);
      expect(cam.view.distance).toBe(CHASE.distance * 2);
      expect(cam.resting).toBe(false);
    });

    test('rests behind the boat once placed, not while it opens on the harbour or looks round', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0);
      expect(cam.resting).toBe(true);
      cam.drag(-40, 0, 0);
      expect(cam.resting).toBe(false);
      cam.place(CHASE, 0);
      cam.open(200, -400, -300, 800);
      expect(cam.resting).toBe(false);
    });
  });

  describe('the ease back turned off', () => {
    test('the own boat’s camera stays where it was left, turning with the boat, until Back to the boat', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0);
      cam.easesBack = false;
      cam.drag(-200, 0, 0);
      const left = cam.view.azimuth;
      let t = 0;
      for (let i = 0; i < 60 * 30; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 1, t);
      }
      expect(cam.view.azimuth).toBe(left);
      // It turns with the boat: its yaw follows the heading.
      expect(Math.abs(angleDiff(cam.yaw, 1))).toBeLessThan(0.01);
      cam.behind();
      for (let i = 0; i < 60 * 6; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 1, t);
      }
      expect(cam.resting).toBe(true);
    });

    test('the opening view still holds until the first touch', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0.4);
      cam.easesBack = false;
      cam.open(200, -400, -300, 800);
      let t = 0;
      for (let i = 0; i < 60 * 10; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 0.4, t);
      }
      expect(cam.opening).toBe(true);
    });
  });

  describe('the descent into the first view', () => {
    test('comes down from twice the height and distance into the view, over the time asked', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0);
      const target = new Vector3();
      const at = new Vector3();
      cam.place3(0, 0, 0, at, target);
      const rest = at.clone();
      cam.descend(2.5);
      cam.place3(0, 0, 0, at, target);
      expect(at.distanceTo(target)).toBeCloseTo(rest.distanceTo(target) * 2, 6);
      let t = 0;
      let last = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 60 * 2.4; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 0, t);
        cam.place3(0, 0, 0, at, target);
        const d = at.distanceTo(target);
        expect(d).toBeLessThanOrEqual(last);
        last = d;
      }
      expect(cam.descending).toBe(true);
      expect(cam.resting).toBe(false);
      for (let i = 0; i < 12; i++) {
        t += 1000 / 60;
        cam.update(1 / 60, 0, t);
      }
      expect(cam.descending).toBe(false);
      cam.place3(0, 0, 0, at, target);
      expect(at.distanceTo(rest)).toBeLessThan(1e-9);
      expect(cam.resting).toBe(true);
    });

    test('a touch ends it where it is', () => {
      for (const touch of ['drag', 'pinch', 'hold'] as const) {
        const cam = new ChaseCamera();
        cam.place(CHASE, 0);
        cam.descend(2.5);
        for (let i = 0; i < 30; i++) {
          cam.update(1 / 60, 0, (i * 1000) / 60);
        }
        const target = new Vector3();
        const at = new Vector3();
        cam.place3(0, 0, 0, at, target);
        const before = at.distanceTo(target);
        if (touch === 'drag') {
          cam.drag(0, 0, 500);
        } else if (touch === 'pinch') {
          cam.zoom(1, 500);
        } else {
          cam.holding = true;
          cam.update(1 / 60, 0, 500);
        }
        expect(cam.descending).toBe(false);
        cam.place3(0, 0, 0, at, target);
        expect(at.distanceTo(target)).toBeCloseTo(before, 1);
      }
    });

    test('a boat set down elsewhere keeps the view, the camera swung to it at once', () => {
      const cam = new ChaseCamera();
      cam.place(CHASE, 0);
      cam.open(200, -400, -300, 800);
      cam.settle(2, 0.3, 0.1);
      expect(cam.yaw).toBe(2);
      expect(cam.yawRate).toBe(0);
      expect(cam.lift).toBe(0.3);
      expect(cam.opening).toBe(true);
    });
  });
});
