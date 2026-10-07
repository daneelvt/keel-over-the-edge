// SPDX-License-Identifier: AGPL-3.0-only

// Every boat's model against the catalog: its named parts sit where the
// physics puts them, within 1 cm, and it is within its triangle budget.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';

/** Most triangles in a boat's model (starting value). */
const BUDGET = 15000;
const CM = 0.01;

interface Gltf {
  nodes: { name?: string; translation?: number[]; mesh?: number; children?: number[] }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: { name: string }[];
  accessors: { count: number; min?: number[]; max?: number[] }[];
}

function readGltf(path: string): Gltf {
  const glb = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

describe.each(catalog.boats.map((b) => [b.name, b] as const))('%s', (_, boat) => {
  const g = readGltf(boat.art.model);
  const node = (name: string) => {
    const n = g.nodes.find((x) => x.name === name);
    if (n === undefined) {
      throw new Error(`no node ${name}`);
    }
    return n;
  };
  const at = (name: string): number[] => node(name).translation ?? [0, 0, 0];
  /** The bounds of a node's primitives of a material, in the node's frame. */
  const bounds = (name: string, material?: string): { min: number[]; max: number[] } => {
    const n = node(name);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of g.meshes[n.mesh ?? -1]?.primitives ?? []) {
      if (material !== undefined && g.materials[p.material]?.name !== material) {
        continue;
      }
      const a = g.accessors[p.attributes.POSITION ?? -1];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, a?.min?.[k] ?? Infinity);
        max[k] = Math.max(max[k] as number, a?.max?.[k] ?? -Infinity);
      }
    }
    return { min, max };
  };
  const { rig, foils, hull, sailor } = boat.physics;

  test('has every named part', () => {
    for (const name of [
      'hull',
      'mast',
      'boom',
      'sail',
      'rudder',
      'tiller',
      'daggerboard',
      'sailor',
    ]) {
      expect(() => node(name)).not.toThrow();
    }
  });

  test('its parts sit where the physics puts them', () => {
    // The bow is -z; positions are from the centre of gravity's station.
    expect(at('mast')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('boom')[1]).toBeCloseTo(rig.boomHeight, 2);
    expect(at('boom')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('sail')).toEqual(at('boom'));
    expect(at('rudder')[2]).toBeCloseTo(foils.rudderPosition, 2);
    expect(at('daggerboard')[2]).toBeCloseTo(-foils.boardPosition, 2);
    expect(at('sailor')[1]).toBeCloseTo(hull.centreOfGravity + sailor.sailorSeatHeight, 2);
    for (const name of ['mast', 'boom', 'rudder', 'daggerboard', 'sailor']) {
      expect(Math.abs(at(name)[0] ?? 1)).toBeLessThan(CM);
    }
  });

  test('its hull, sail and foils have the physics’ dimensions', () => {
    const deck = bounds('hull', 'deck');
    const planks = bounds('hull', 'timber');
    expect(Math.abs((deck.max[0] ?? 0) - (deck.min[0] ?? 0) - boat.beam)).toBeLessThan(CM);
    expect(Math.abs((planks.max[2] ?? 0) - (planks.min[2] ?? 0) - boat.lengthOverall)).toBeLessThan(
      CM,
    );
    expect(Math.abs((planks.min[1] ?? 0) + hull.hullDraught)).toBeLessThan(CM);
    const sail = bounds('sail');
    expect(Math.abs((sail.max[1] ?? 0) - (sail.min[1] ?? 0) - rig.luff)).toBeLessThan(CM);
    expect(Math.abs((sail.max[2] ?? 0) - (sail.min[2] ?? 0) - rig.foot)).toBeLessThan(CM);
    const board = bounds('daggerboard');
    expect(Math.abs((board.min[1] ?? 0) + hull.hullDraught + foils.boardSpan)).toBeLessThan(CM);
    expect(Math.abs((board.max[2] ?? 0) - (board.min[2] ?? 0) - foils.boardChord)).toBeLessThan(CM);
    const rudder = bounds('rudder');
    expect(Math.abs((rudder.min[1] ?? 0) + hull.hullDraught + foils.rudderSpan)).toBeLessThan(CM);
  });

  test(`is under ${BUDGET.toLocaleString('en')} triangles`, () => {
    let triangles = 0;
    for (const m of g.meshes) {
      for (const p of m.primitives) {
        triangles += (g.accessors[p.indices]?.count ?? 0) / 3;
      }
    }
    expect(triangles).toBeGreaterThan(1000);
    expect(triangles).toBeLessThan(BUDGET);
  });

  test('the sail carries its fraction of chord and luff, for its vertex node', () => {
    const sail = g.meshes[node('sail').mesh ?? -1]?.primitives[0];
    expect(sail?.attributes.TEXCOORD_1).toBeDefined();
  });
});
