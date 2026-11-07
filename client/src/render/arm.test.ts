// SPDX-License-Identifier: AGPL-3.0-only

// The chase camera's arm against solids made here, boxes in the world:
// a wall behind the boat brings it in the same frame, its point and its
// line clear; the wall gone, it goes back out over ARM_TIME, never past
// its view; a cliff swung through; a reach too short, and it rises; a roof
// over the boat, and it stays under it, nearer; the player's view, its
// rest and its ease back are the land's to shorten, never to change; the
// opening view, the descent and another's boat watched are kept out the
// same way; the held camera is not; and with nothing solid near, it stands
// where it stood without solids, to the bit.

import { describe, expect, test } from 'vitest';
import type { SolidLookup } from '../land/solids';
import {
  ARM_TIME,
  CHASE,
  ChaseCamera,
  CLEARANCE,
  EASE_BACK_AFTER,
  LOOK_HEIGHT,
  SHORTEST,
} from './camera';

/** A box, m east, north and up. */
interface Box {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  minU: number;
  maxU: number;
}

/** Solids that are boxes; the camera's scene is the world's (x east, z south) about its centre. */
class Boxes implements SolidLookup {
  boxes: Box[] = [];
  readonly band = { under: 0, top: 0 };
  /** How often it was asked. */
  asked = 0;

  get ceiling(): number {
    return this.boxes.reduce((m, b) => Math.max(m, b.maxU), Number.NEGATIVE_INFINITY);
  }

  distance(east: number, north: number, up: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (const b of this.boxes) {
      const de = Math.max(b.minE - east, 0, east - b.maxE);
      const dn = Math.max(b.minN - north, 0, north - b.maxN);
      const du = Math.max(b.minU - up, 0, up - b.maxU);
      best = Math.min(best, Math.hypot(de, dn, du));
    }
    return best;
  }

  clear(east: number, north: number, up: number, radius: number): boolean {
    this.asked++;
    return this.distance(east, north, up) >= radius;
  }

  highest(): number {
    return this.ceiling;
  }

  roofAt(): boolean {
    return false;
  }
}

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

/** The open world but for a wall: everything south of north = −n, to 100 m up. */
const wallSouthOf = (n: number, top = 100): Box => ({
  minE: -1e4,
  maxE: 1e4,
  minN: -1e4,
  maxN: -n,
  minU: -50,
  maxU: top,
});

/** Places cam behind a boat at the world's centre, heading north; returns its position and target. */
function place(cam: ChaseCamera) {
  const p = point();
  const t = point();
  cam.place3(0, 0, 0, p, t);
  return { p, t, reach: Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) };
}

/** Whether the camera's point and every point of its line to the target are clear of the solids, by radius, and the least distance. */
function lineClear(s: Boxes, p: { x: number; y: number; z: number }, t: typeof p, radius: number) {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= 400; i++) {
    const u = i / 400;
    const x = t.x + (p.x - t.x) * u;
    const y = t.y + (p.y - t.y) * u;
    const z = t.z + (p.z - t.z) * u;
    least = Math.min(least, s.distance(x, -z, y));
  }
  return { clear: least >= radius - 1e-9, least, at: s.distance(p.x, -p.z, p.y) };
}

describe('the arm', () => {
  test('a wall behind the boat brings the camera in the same frame, its point and its line clear', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    expect(place(cam).reach).toBeCloseTo(CHASE.distance, 9);
    // The view stands 15.3 m south; a wall from 8 m south.
    s.boxes = [wallSouthOf(8)];
    cam.update(1 / 60, 0, 0);
    const { p, t, reach } = place(cam);
    const l = lineClear(s, p, t, CLEARANCE);
    expect(l.clear).toBe(true);
    expect(l.at).toBeGreaterThanOrEqual(CLEARANCE);
    expect(l.at).toBeLessThan(CLEARANCE + 0.05);
    expect(reach).toBeCloseTo((8 - CLEARANCE) / Math.cos(CHASE.elevation), 1);
    expect(cam.armReach).toBeCloseTo(reach, 9);
    // The view is the player's still.
    expect(cam.view).toEqual(CHASE);
    expect(cam.armRise).toBe(Number.NEGATIVE_INFINITY);
  });

  test('the wall gone, it goes back out over ARM_TIME, steadily, never past its view, and lets go', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    s.boxes = [wallSouthOf(8)];
    cam.update(1 / 60, 0, 0);
    const near = place(cam).reach;
    s.boxes = [];
    let last = near;
    let settled = -1;
    for (let i = 1; i <= 120; i++) {
      cam.update(1 / 60, 0, (i * 1000) / 60);
      const r = place(cam).reach;
      expect(r).toBeGreaterThanOrEqual(last - 1e-12);
      expect(r).toBeLessThanOrEqual(CHASE.distance + 1e-12);
      if (settled < 0 && CHASE.distance - r < 0.01 * (CHASE.distance - near)) {
        settled = i / 60;
      }
      last = r;
    }
    expect(settled).toBeGreaterThan(ARM_TIME * 0.8);
    expect(settled).toBeLessThan(ARM_TIME + 0.05);
    expect(cam.armReach).toBe(Number.POSITIVE_INFINITY);
    expect(last).toBe(place(new ChaseCamera()).reach);
  });

  test('swung through a cliff beside the boat, every frame clear', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    // A cliff 6 m to starboard (east), 30 m high, along the boat.
    s.boxes = [{ minE: 6, maxE: 200, minN: -200, maxN: 200, minU: -50, maxU: 30 }];
    let nearest = Number.POSITIVE_INFINITY;
    let pulled = 0;
    for (let i = 1; i <= 360; i++) {
      // A degree a frame, round.
      cam.drag(-(Math.PI / 180) / 0.006, 0, (i * 1000) / 60);
      cam.update(1 / 60, 0, (i * 1000) / 60);
      const { p, t, reach } = place(cam);
      const l = lineClear(s, p, t, CLEARANCE);
      expect(l.clear).toBe(true);
      nearest = Math.min(nearest, l.at);
      pulled += reach < CHASE.distance - 0.01 ? 1 : 0;
    }
    expect(nearest).toBeGreaterThanOrEqual(CLEARANCE);
    expect(pulled).toBeGreaterThan(60);
  });

  test('where the clear reach is under SHORTEST, it rises at the same azimuth', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    // A wall 3 m astern, 6 m high: at the view's elevation the reach is 2.6 m.
    s.boxes = [wallSouthOf(3, 6)];
    cam.update(1 / 60, 0, 0);
    const { p, t, reach } = place(cam);
    expect(cam.armRise).toBeGreaterThan(CHASE.elevation);
    expect(reach).toBeGreaterThanOrEqual(SHORTEST - 1e-9);
    expect(lineClear(s, p, t, CLEARANCE).clear).toBe(true);
    // Still astern: straight south of the boat.
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
    expect(p.z).toBeGreaterThan(0);
    expect(cam.view.elevation).toBe(CHASE.elevation);
    // The wall gone, it comes down to the view, and lets go.
    s.boxes = [];
    for (let i = 1; i <= 90; i++) {
      cam.update(1 / 60, 0, (i * 1000) / 60);
      place(cam);
    }
    expect(cam.armRise).toBe(Number.NEGATIVE_INFINITY);
    expect(place(cam).p.y).toBe(place(new ChaseCamera()).p.y);
  });

  test('under a roof it stays under, nearer; a roof too low for any rise, at its reach', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    s.boxes = [{ minE: -30, maxE: 30, minN: -30, maxN: 30, minU: 5, maxU: 8 }];
    cam.update(1 / 60, 0, 0);
    let got = place(cam);
    expect(got.p.y).toBeLessThanOrEqual(5 - CLEARANCE + 1e-9);
    expect(lineClear(s, got.p, got.t, CLEARANCE).clear).toBe(true);
    expect(cam.armRise).toBe(Number.NEGATIVE_INFINITY);
    // Its underside 2.6 m up: at the view's elevation 1.0 m of reach; higher
    // reaches less.
    s.boxes = [{ minE: -30, maxE: 30, minN: -30, maxN: 30, minU: 2.6, maxU: 8 }];
    cam.update(1 / 60, 0, 20);
    got = place(cam);
    expect(cam.armRise).toBe(Number.NEGATIVE_INFINITY);
    expect(got.reach).toBeCloseTo((2.6 - CLEARANCE - LOOK_HEIGHT) / Math.sin(CHASE.elevation), 1);
    expect(lineClear(s, got.p, got.t, CLEARANCE).clear).toBe(true);
  });

  test('the view, its rest, resting and the ease back are as they are without the land', () => {
    const run = (solids: boolean) => {
      const cam = new ChaseCamera();
      const s = new Boxes();
      if (solids) {
        s.boxes = [wallSouthOf(5)];
        cam.solids = s;
      }
      cam.place(CHASE, 0.2);
      const out: unknown[] = [];
      for (let i = 1; i <= 600; i++) {
        const now = (i * 1000) / 60;
        if (i < 60) {
          cam.drag(4, -2, now);
        }
        if (i === 30) {
          cam.zoom(1.5, now);
        }
        cam.update(1 / 60, 0.2, now);
        place(cam);
        out.push([{ ...cam.view }, { ...cam.rest }, cam.resting, cam.tilt]);
      }
      return out;
    };
    expect(run(true)).toEqual(run(false));
    // And it did ease back: five seconds after the last touch.
    expect(EASE_BACK_AFTER).toBeLessThan(9000);
  });

  test('the opening view, the descent and another’s boat watched are kept out the same way', () => {
    for (const how of ['opening', 'descent', 'watching'] as const) {
      const cam = new ChaseCamera();
      const s = new Boxes();
      cam.solids = s;
      // Heading south, but for the opening view north.
      const heading = how === 'opening' ? Math.PI : 0;
      cam.place(CHASE, heading);
      if (how === 'opening') {
        // A mouth to the north: the camera stands south of the boat, ahead of it.
        cam.open(0, 0, 0, 100);
      } else if (how === 'descent') {
        cam.descend(4);
      } else {
        cam.watching = true;
      }
      s.boxes = [wallSouthOf(6)];
      cam.update(1 / 60, heading, 0);
      const { p, t, reach } = place(cam);
      expect(reach, how).toBeLessThan(CHASE.distance / 2);
      expect(lineClear(s, p, t, CLEARANCE).clear, how).toBe(true);
    }
  });

  test('the held camera is not kept out', () => {
    const cam = new ChaseCamera();
    const s = new Boxes();
    cam.solids = s;
    cam.place(CHASE, 0);
    s.boxes = [wallSouthOf(5)];
    cam.held = { x: 0, y: 10, z: 20 };
    cam.update(1 / 60, 0, 0);
    const { p } = place(cam);
    expect([p.x, p.y, p.z]).toEqual([0, 10, 20]);
  });

  test('with nothing solid near, it stands where it stands without solids, to the bit', () => {
    const run = (solids: SolidLookup | null) => {
      const cam = new ChaseCamera();
      cam.solids = solids;
      cam.place(CHASE, 0.4, 0.2, 0.1);
      cam.descend(3);
      const out: number[] = [];
      for (let i = 1; i <= 900; i++) {
        const now = (i * 1000) / 60;
        if (i % 97 < 20) {
          cam.drag(7 * Math.sin(i), 3 * Math.cos(i * 0.7), now);
        }
        if (i % 211 === 0) {
          cam.zoom(0.8, now);
        }
        if (i === 400) {
          cam.shake(3, now);
        }
        cam.update(
          1 / 60,
          0.4 + 0.3 * Math.sin(i / 50),
          now,
          0.4 * Math.sin(i / 9),
          0.3 * Math.sin(i / 7),
          0.05 * Math.sin(i / 11),
          0.2 + 0.1 * Math.sin(i / 13),
          3,
        );
        const p = point();
        const t = point();
        const u = point();
        cam.place3(10 * Math.sin(i / 100), 0.3 * Math.sin(i / 9), -5, p, t, u);
        out.push(p.x, p.y, p.z, t.x, t.y, t.z, u.x, u.y, u.z);
      }
      return out;
    };
    const far = new Boxes();
    // A rock 300 m off: within the grids held, out of every line.
    far.boxes = [{ minE: 300, maxE: 340, minN: 300, maxN: 340, minU: -50, maxU: 40 }];
    const none = run(null);
    const got = run(far);
    const first = got.findIndex((v, i) => !Object.is(v, none[i]));
    expect(first).toBe(-1);
    expect(far.asked).toBeGreaterThan(0);
    expect(run(new Boxes())).toEqual(none);
  });
});
