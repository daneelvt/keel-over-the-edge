// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { Group, Object3D, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { placeBoatNodes } from '../render/boat';
import { HULL_FILL, type HullShape, hullShape, insideHull, STATIONS, toHullFrame } from './hulls';

/** A model's hull node's own data, from its file. */
function hullData(path: string): unknown {
  const glb = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
    nodes: { name?: string; extras?: unknown }[];
  };
  return json.nodes.find((n) => n.name === 'hull')?.extras;
}

describe.each(catalog.boats.map((b) => [b.name, b] as const))('%s’s hull', (_, boat) => {
  const shape = hullShape(hullData(boat.art.model)) as HullShape;
  const hull = boat.physics.hull;

  test('carries its volume, measured from its mesh', () => {
    expect(shape).not.toBeNull();
    expect(shape.stations).toHaveLength(STATIONS);
    // From the transom forward to where the stem leaves the water.
    for (let i = 1; i < STATIONS; i++) {
      expect(shape.stations[i]?.[0]).toBeLessThan(shape.stations[i - 1]?.[0] ?? 0);
    }
    const length = (shape.stations[0]?.[0] ?? 0) - (shape.stations[STATIONS - 1]?.[0] ?? 0);
    expect(length).toBeGreaterThan(0.8 * hull.waterlineLength);
    expect(length).toBeLessThan(boat.lengthOverall);
    const widest = Math.max(...shape.stations.map((s) => s[1] ?? 0));
    expect(2 * widest).toBeGreaterThan(0.85 * hull.waterlineBeam);
    expect(2 * widest).toBeLessThan(boat.beam);
    const deepest = Math.max(...shape.stations.map((s) => s[2] ?? 0));
    expect(Math.abs(deepest - hull.hullDraught)).toBeLessThan(0.02);
    // The waterline ends in a point at the stem.
    expect(shape.stations[STATIONS - 1]?.slice(1)).toEqual([0, 0]);
    expect(shape.bilge).toBeGreaterThan(1);
    expect(shape.bilge).toBeLessThan(4);
  });

  test('holds the cockpit and not the water beside the boat', () => {
    const z = shape.stations[3]?.[0] ?? 0;
    const beam = shape.stations[3]?.[1] ?? 0;
    const depth = shape.stations[3]?.[2] ?? 0;
    // On the centreline, at the waterline, above it without limit, and down to the bottom.
    expect(insideHull(shape, 0, 0, z)).toBe(true);
    expect(insideHull(shape, 0, 3, z)).toBe(true);
    expect(insideHull(shape, 0, -depth + 0.005, z)).toBe(true);
    expect(insideHull(shape, 0, -depth - 0.005, z)).toBe(false);
    // Out to the planking at the waterline, less the margin; never beyond it.
    expect(insideHull(shape, HULL_FILL * beam - 0.005, 0, z)).toBe(true);
    expect(insideHull(shape, -(HULL_FILL * beam - 0.005), 0, z)).toBe(true);
    expect(insideHull(shape, beam, 0, z)).toBe(false);
    expect(insideHull(shape, beam + 0.05, 0.2, z)).toBe(false);
    // Narrower toward the bottom.
    expect(insideHull(shape, 0.8 * beam, -0.8 * depth, z)).toBe(false);
    expect(insideHull(shape, 0.8 * beam, -0.1 * depth, z)).toBe(true);
    // Not astern of the transom, nor ahead of the waterline's end.
    expect(insideHull(shape, 0, 0, (shape.stations[0]?.[0] ?? 0) + 0.01)).toBe(false);
    expect(insideHull(shape, 0, 0, (shape.stations[STATIONS - 1]?.[0] ?? 0) - 0.01)).toBe(false);
    // Between stations it is their blend.
    const mid = (z + (shape.stations[4]?.[0] ?? 0)) / 2;
    const between = (beam + (shape.stations[4]?.[1] ?? 0)) / 2;
    expect(insideHull(shape, HULL_FILL * between - 0.003, 0, mid)).toBe(true);
    expect(insideHull(shape, HULL_FILL * between + 0.003, 0, mid)).toBe(false);
  });

  test('the far model carries a volume too', () => {
    expect(hullShape(hullData(boat.art.far))).not.toBeNull();
  });
});

describe('a hull’s volume', () => {
  test('is refused when its data is not eight stations of three numbers', () => {
    expect(hullShape(undefined)).toBeNull();
    expect(hullShape({})).toBeNull();
    expect(hullShape({ waterline: { stations: [[0, 1, 2]], bilge: 2 } })).toBeNull();
    const stations = Array.from({ length: STATIONS }, (_, i) => [1 - i, 0.5, 0.1]);
    expect(hullShape({ waterline: { stations, bilge: 'two' } })).toBeNull();
    expect(
      hullShape({ waterline: { stations: stations.map((s) => s.slice(1)), bilge: 2 } }),
    ).toBeNull();
    expect(hullShape({ waterline: { stations, bilge: 1.7 } })).toEqual({ stations, bilge: 1.7 });
  });

  test('a point is taken into the hull’s frame by undoing the boat’s own turns', () => {
    const cg = 0.3;
    const root = new Group();
    const heel = new Group();
    const model = new Group();
    heel.position.y = cg;
    model.position.y = -cg;
    root.add(heel);
    heel.add(model);
    const part = new Object3D();
    model.add(part);
    for (const [heading, heelAngle, pitch, heave] of [
      [0, 0, 0, 0],
      [1.1, 0.5, 0, 0],
      [-2.4, 0, 0.12, 0.3],
      [0.7, -0.6, -0.08, -0.2],
      [Math.PI, 1.4, 0.1, 0.05],
    ] as const) {
      // A point of the model, where the boat's nodes put it in the scene …
      part.position.set(0.31, -0.05, -1.2);
      placeBoatNodes(root, heel, { x: 40, y: 0, z: -17 }, heading, heelAngle, pitch, heave);
      root.updateMatrixWorld(true);
      const p = part.getWorldPosition(new Vector3());
      // … is that point again in the hull's frame, from its centre of gravity.
      const m = toHullFrame(
        { x: p.x - 40, y: p.y - (heave + cg), z: p.z + 17 },
        heading,
        pitch,
        heelAngle,
      );
      expect(m.x).toBeCloseTo(0.31, 12);
      expect(m.y + cg).toBeCloseTo(-0.05, 12);
      expect(m.z).toBeCloseTo(-1.2, 12);
    }
  });
});
