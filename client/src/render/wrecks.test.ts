// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { FloatingOrigin } from './coords';
import { Wrecks, wreckGeometry } from './wrecks';

const places = catalog.world.places;
const wreck = places.kinds.findIndex((k) => k.site === 'wreck');

describe('a wreck', () => {
  test('is built from her rig and age: masts while she is fresh, ribs when she is old', () => {
    for (const rig of places.rigs) {
      for (const age of places.ages) {
        const g = wreckGeometry(rig, age);
        g.computeBoundingBox();
        const b = g.boundingBox;
        if (b === null) {
          throw new Error('no bounds');
        }
        const length = b.max.z - b.min.z;
        expect(length, `${rig.id} ${age.id}`).toBeLessThanOrEqual(rig.length * 1.01);
        const tall = b.max.y;
        if (age.masts > 0 && age.hull > 0.4) {
          expect(tall, `${rig.id} ${age.id}`).toBeGreaterThan(rig.mast * age.masts * 0.8);
        } else {
          expect(tall, `${rig.id} ${age.id}`).toBeLessThan(rig.beam);
        }
      }
    }
  });

  test('lies on the bottom where she is, heeled if stranded, with a shadow if sunk', () => {
    const w = new Wrecks(places.rigs, places.ages, wreck, catalog.world.look.attenuation);
    const depths = new Map([
      [5, 1],
      [6, 6],
    ]);
    w.depthAt = (east) => depths.get(east) ?? null;
    const base = {
      kind: wreck,
      north: 0,
      heading: 0,
      ground: 0,
      tower: 0,
      daymark: 0,
      rig: 0,
      age: 0,
      heel: 0,
    };
    w.setPlaces([
      { ...base, number: 1, east: 5, sunk: false, heel: 0.4 },
      { ...base, number: 2, east: 6, sunk: true },
      { ...base, number: 3, east: 99, sunk: true },
      { ...base, number: 4, kind: wreck + 1, east: 5, sunk: false },
    ]);
    w.frame(new FloatingOrigin());
    expect(w.known.size).toBe(3);
    expect(w.root.children.length).toBe(2);
    w.mesh.geometry.computeBoundingBox();
    // The sunk one's keel 6 m down, the stranded one's a metre.
    expect(w.mesh.geometry.boundingBox?.min.y).toBeCloseTo(-6, 1);
    expect(w.shadows.geometry.getAttribute('depth').getX(0)).toBe(6);
    // The third, once the land under her is had.
    depths.set(99, 3);
    w.frame(new FloatingOrigin());
    expect(w.shadows.geometry.getAttribute('depth').count).toBeGreaterThan(0);
  });
});
