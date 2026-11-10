// SPDX-License-Identifier: AGPL-3.0-only

import { Object3D } from 'three';
import { describe, expect, test } from 'vitest';
import { RAIL_REACH, STRAPPED, seating } from './restage';

/** A model's nodes by name: a sailor node with its seat's move, and a strap if asked. */
function nodes(restage: [number, number, number] | null, strap = false): Map<string, Object3D> {
  const parts = new Map<string, Object3D>();
  const sailor = new Object3D();
  if (restage !== null) {
    sailor.userData = { restage };
  }
  parts.set('sailor', sailor);
  if (strap) {
    parts.set('strap', new Object3D());
  }
  return parts;
}

describe('a boat’s sailor hikes', () => {
  test('to the strap’s depth where the model has a strap', () => {
    expect(seating(nodes(null, true), 0.956).hike).toEqual(STRAPPED);
  });

  test('to the rail at the physics’ reach where that is within the clip’s', () => {
    // A seat 0.46 m further out than the stage's, the physics' reach 1.1 m.
    const s = seating(nodes([0.46, 0.38, 0.9]), 1.1);
    expect(s.hike.full).toBeCloseTo(1.1, 12);
    expect(s.hike.from).toBeCloseTo(0.9, 12);
    expect(s.hike.depth).toBe(1);
  });

  test('to the rail where the clip reaches it, on a boat whose sailor goes further out', () => {
    // A trapeze: the physics puts the sailor 1.84 m out, past the rail; the
    // figure is hiked on the rail from where the clip puts it there.
    for (const out of [0, 0.19]) {
      const s = seating(nodes(out === 0 ? null : [out, 0, 0]), 1.84);
      expect(s.hike.full).toBeCloseTo(RAIL_REACH + out, 12);
      expect(s.hike.full).toBeLessThan(1.84);
      expect(s.hike.from).toBeCloseTo(s.hike.full - 0.2, 12);
    }
  });
});
