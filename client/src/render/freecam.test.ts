// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { Solids } from '../land/solids';
import { GROUND } from '../predict/layout.gen';
import { cellHex, cellOf, chunkCorner, hexCentre } from '../workers/mesh/build';
import type { ChunkGrids } from '../workers/mesh/chunk';
import { CLEARANCE } from './camera';
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

/** Solids over the chunk at the world's centre: a 30.4 m column on the centre's hexagon, a roof from 10 m to 14 m 20 m north, a house 40 m north-east. */
function solids(): Solids {
  const n = 136;
  const [c0, j0] = chunkCorner(n);
  const [cc, cj] = cellOf(0, 0);
  const [rc, rj] = cellOf(0, 20);
  const e = new Int16Array(GROUND.chunkHexes);
  for (let i = 0; i < e.length; i++) {
    const c = c0 + Math.floor(i / GROUND.chunkRows);
    const j = j0 + (i % GROUND.chunkRows);
    e[i] = c === cc && j === cj ? 304 : -40;
  }
  const g: ChunkGrids = {
    number: n,
    elevation: e,
    surface: new Uint8Array(GROUND.chunkHexes),
    shelter: null,
    town: {
      buildings: [
        {
          kind: 0,
          kit: 0,
          east: 40,
          north: 40,
          heading: 0.4,
          level: 1,
          top: 8,
          storeys: 2,
          seed: 0,
          wall: 0,
          roof: 0,
          shutter: 0,
          flag: 0,
          frontage: 8,
          depth: 6,
          town: 0,
        },
      ],
      harbour: [],
    },
    features: { roofs: [{ column: rc, row: rj, under: 10, top: 14 }], parts: [] },
  };
  const s = new Solids(catalog.world.look.terrace);
  s.add(n, g);
  return s;
}

describe('the free camera among the solids', () => {
  test('it keeps 2 m above a taller neighbour within the clearance, not one beyond it', () => {
    const c = new FreeCamera();
    c.solids = solids();
    // The column's northern edge is 2 m north of its centre.
    c.enter(0, 2 + CLEARANCE - 0.1, 10, 0, 0);
    expect(c.height).toBeCloseTo(30.4 + ROAM_LOW, 9);
    c.enter(0, 2 + CLEARANCE + 0.1, 10, 0, 0);
    expect(c.height).toBe(10);
    c.enter(0, 2 + CLEARANCE + 0.1, 1, 0, 0);
    expect(c.height).toBe(ROAM_LOW);
    // And the hexagon it is over, as the ground alone kept it.
    const [q, r] = cellHex(...cellOf(0, 0));
    const [e, n] = hexCentre(q, r);
    c.enter(e, n, 5, 0, 0);
    expect(c.height).toBeCloseTo(30.4 + ROAM_LOW, 9);
  });

  test('under a roof it keeps below its underside, or goes over its top, whichever is nearer', () => {
    const c = new FreeCamera();
    c.solids = solids();
    c.enter(0, 20, 9.8, 0, 0);
    expect(c.height).toBeCloseTo(10 - CLEARANCE, 9);
    c.enter(0, 20, 13.2, 0, 0);
    expect(c.height).toBeCloseTo(14 + ROAM_LOW, 9);
    c.enter(0, 20, 5, 0, 0);
    expect(c.height).toBe(5);
    c.enter(0, 20, 20, 0, 0);
    expect(c.height).toBe(20);
  });

  test('it keeps over a house, and its chimney', () => {
    const c = new FreeCamera();
    c.solids = solids();
    c.enter(40, 40, 3, 0, 0);
    expect(c.height).toBeCloseTo(8 + 0.6 + ROAM_LOW, 9);
    c.enter(60, 60, 3, 0, 0);
    expect(c.height).toBe(3);
  });
});
