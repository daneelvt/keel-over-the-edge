// SPDX-License-Identifier: AGPL-3.0-only

// The downwind sail as drawn: which kinds have one (by their numbers, never
// their names), when it shows, how it ripples going up and set, how much of
// its chord is drawn as its clew comes across, and the fleet's parts of a
// model with one, built here: its mesh in its frame at its tack, apart from
// the solids and the headsails.

import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { boatParts, HEADSAIL_UV } from './fleetparts';
import { KITE_FLOG, KITE_REACH_IN, kiteReach, kiteRig, kiteRipple, kiteShown } from './sailshape';

describe('a downwind sail', () => {
  test('is drawn on the kinds whose physics have one, and no others', () => {
    for (const boat of catalog.boats) {
      const rig = kiteRig(boat.physics);
      expect(rig === null, boat.name).toBe(!(boat.physics.downwind.downwindArea > 0));
      if (rig !== null) {
        expect(rig.kiteIn).toBeCloseTo((boat.physics.downwind.downwindIn * Math.PI) / 180, 12);
        expect(rig.footV).toBeLessThan(rig.headV);
      }
    }
    // The catalog has at least one, or the rest of this draws nothing.
    expect(catalog.boats.some((b) => kiteRig(b.physics) !== null)).toBe(true);
  });

  test('shows from the first of it out of its bag', () => {
    expect(kiteShown(0)).toBe(false);
    expect(kiteShown(1e-4)).toBe(false);
    expect(kiteShown(0.01)).toBe(true);
    expect(kiteShown(1)).toBe(true);
  });

  test('flogs as it goes up, filling as it is set, and ripples set as its flow says', () => {
    expect(kiteRipple(0, 0.25)).toBeCloseTo(0.75 * KITE_FLOG, 12);
    expect(kiteRipple(0, 0.5)).toBeGreaterThan(kiteRipple(0, 0.9));
    expect(kiteRipple(0, 1)).toBe(0);
    expect(kiteRipple(0.6, 1)).toBe(0.6);
    expect(kiteRipple(1, 0.5)).toBe(1);
  });

  test('is drawn to its full chord from its sheeted-in angle out, and short across the centreline', () => {
    const rig = kiteRig(
      catalog.boats.find((b) => kiteRig(b.physics) !== null)?.physics ?? catalog.boats[0].physics,
    );
    const kiteIn = rig?.kiteIn ?? 0.4;
    expect(kiteReach(0, kiteIn)).toBeCloseTo(KITE_REACH_IN, 12);
    expect(kiteReach(kiteIn, kiteIn)).toBe(1);
    expect(kiteReach(-1.2, kiteIn)).toBe(1);
    expect(kiteReach(kiteIn / 2, kiteIn)).toBeCloseTo(KITE_REACH_IN + (1 - KITE_REACH_IN) / 2, 12);
    expect(kiteReach(-kiteIn / 2, kiteIn)).toBe(kiteReach(kiteIn / 2, kiteIn));
  });
});

/** A flat sail of rows × cols cells at its node's origin, as a model's headsails are built: TEXCOORD_1 the fraction of the chord and the luff, TEXCOORD_0 the cloth's. */
function flatSail(luff: number, foot: number, rake: number): BufferGeometry {
  const rows = 4;
  const cols = 2;
  const p: number[] = [];
  const uv: number[] = [];
  const uv1: number[] = [];
  for (let i = 0; i <= rows; i++) {
    const v = i / rows;
    const chord = foot * (1 - v) + 0.05 * v;
    for (let j = 0; j <= cols; j++) {
      const u = j / cols;
      p.push(0, v * luff, v * rake + u * chord);
      uv.push((u * chord) / foot, v);
      uv1.push(u, v);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + cols + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.setAttribute(
    'normal',
    new Float32BufferAttribute(
      p.map((_, k) => (k % 3 === 0 ? 1 : 0)),
      3,
    ),
  );
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('uv1', new Float32BufferAttribute(uv1, 2));
  g.setIndex(index);
  return g;
}

describe('the fleet’s parts of a model with a downwind sail', () => {
  test('keep it apart, in its frame at its tack, its chord read before its coordinates are packed', () => {
    const scene = new Group();
    const hull = new Mesh(flatSail(0.5, 2, 0), new MeshStandardMaterial());
    hull.name = 'hull';
    const jib = new Mesh(flatSail(4.6, 1.5, 1.2), new MeshStandardMaterial({ name: 'flax' }));
    jib.name = 'jib';
    jib.position.set(0, 0.45, -2.35);
    jib.userData = { rake: 1.2 };
    const kite = new Mesh(flatSail(5.8, 3.6, 1.5), new MeshStandardMaterial({ name: 'flax' }));
    kite.name = 'kite';
    kite.position.set(0, 0.5, -3.45);
    kite.userData = { rake: 1.5 };
    scene.add(hull, jib, kite);
    const parts = boatParts(scene, 'test');
    expect(parts.jibs).toHaveLength(1);
    expect(parts.kites).toHaveLength(1);
    const k = parts.kites[0];
    expect(k?.rake).toBe(1.5);
    expect(k?.at.toArray()).toEqual([0, 0.5, -3.45]);
    // A straight leech from 3.6 m to 0.05: at half height, about half the foot.
    expect(k?.chordHalf).toBeCloseTo((3.6 / 2 + 0.05 / 2) / 3.6, 3);
    expect(k?.geometry.hasAttribute(HEADSAIL_UV)).toBe(true);
    // Its vertices its own frame's: the tack at the origin.
    expect(k?.geometry.getAttribute('position').getZ(0)).toBe(0);
    // Not in the solids, nor taken for a headsail.
    const solidVertices = parts.solids.reduce(
      (n, s) => n + s.geometry.getAttribute('position').count,
      0,
    );
    expect(solidVertices).toBe(hull.geometry.getAttribute('position').count);
    expect(parts.jib?.rake).toBe(1.2);
  });
});
