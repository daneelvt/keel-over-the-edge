// SPDX-License-Identifier: AGPL-3.0-only

// Every boat's model against the catalog: its named parts sit where the
// physics puts them, within 1 cm, and it is within its triangle budget.
// Every sailor's art is the sailors' build's: its deck level skinned and
// within its budget, its far level one posed figure seated by its place, and
// its clips every one the runtime sails with.

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';

/** Most triangles in a boat's model (starting value). */
const BUDGET = 15000;
/** Most triangles in a sailor's deck and far levels (the build's tables.yaml). */
const DECK_BUDGET = 3300;
const FAR_BUDGET = 300;
const CM = 0.01;

interface Gltf {
  nodes: {
    name?: string;
    skin?: number;
    translation?: number[];
    mesh?: number;
    children?: number[];
    extras?: { plan?: { deviation: number } };
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  materials: { name: string }[];
  accessors: { count: number; min?: number[]; max?: number[] }[];
  animations?: { name: string }[];
}

function triangles(g: Gltf): number {
  let n = 0;
  for (const m of g.meshes ?? []) {
    for (const p of m.primitives) {
      n += (g.accessors[p.indices]?.count ?? 0) / 3;
    }
  }
  return n;
}

function readGltf(path: string): Gltf {
  const glb = readFileSync(new URL(`../../../art/${path}`, import.meta.url));
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

/** Every look's versions, the people's and the machine's, by name. */
const versions = [
  ...catalog.sailors.flatMap((s) => s.versions.map((v) => [`${s.name} ${v.name}`, v] as const)),
  ...catalog.machine.versions.map((v) => [`machine ${v.name}`, v] as const),
];

describe.each(versions)('sailor %s', (_, sailor) => {
  test(`its deck level is skinned, under ${DECK_BUDGET.toLocaleString('en')} triangles`, () => {
    const g = readGltf(sailor.art.model);
    expect(g.nodes.some((n) => n.skin !== undefined)).toBe(true);
    expect(triangles(g)).toBeGreaterThan(1000);
    expect(triangles(g)).toBeLessThan(DECK_BUDGET);
  });

  test(`its far level is one figure seated by its place, under ${FAR_BUDGET} triangles`, () => {
    const g = readGltf(sailor.art.far);
    expect(g.nodes.some((n) => n.name === 'place')).toBe(true);
    expect(triangles(g)).toBeLessThanOrEqual(FAR_BUDGET);
  });

  test('its clips are every one the runtime sails with, on both side decks', () => {
    const names = (readGltf(sailor.art.clips).animations ?? []).map((a) => a.name);
    for (const c of ['helm', 'hiking-1', 'hiking-2', 'hiking-3', 'cross', 'habit', 'climbing-in']) {
      expect(names).toContain(c);
      expect(names).toContain(`${c}-port`);
    }
    for (const c of ['treading-water', 'righting', 'standing-idle', 'habit-standing']) {
      expect(names).toContain(c);
    }
  });
});

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
      'telltales',
      'pennant',
      'rudder',
      'tiller',
      'daggerboard',
      'sailor',
      // What the sailor holds, stands on and sits against.
      'extension',
      'grip',
      'sheet',
      'sheet-boom',
      'strap',
      'gunwale',
      'board-root',
    ]) {
      expect(() => node(name)).not.toThrow();
    }
  });

  test('its hull is a solid the sailor is kept out of, and its gunwale is the outline’s', () => {
    const solid = (node('hull') as { extras?: { solid?: { stations: number[][] } } }).extras?.solid;
    expect(solid?.stations.length ?? 0).toBeGreaterThan(10);
    const g = at('gunwale');
    const u = (hull.transom - (g[2] ?? 0)) / boat.lengthOverall;
    const o = hull.outline;
    const x = u * (o.length - 1);
    const i = Math.floor(x);
    const half = (o[i] ?? 0) + ((o[i + 1] ?? 0) - (o[i] ?? 0)) * (x - i);
    expect(g[0] ?? 0).toBeCloseTo(half, 2);
    expect(g[2] ?? 0).toBeCloseTo(at('sailor')[2] ?? 1, 2);
  });

  test('its parts sit where the physics puts them', () => {
    // The bow is -z; positions are from the centre of gravity's station.
    expect(at('mast')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('boom')[1]).toBeCloseTo(rig.boomHeight, 2);
    expect(at('boom')[2]).toBeCloseTo(-rig.mastPosition, 2);
    expect(at('sail')).toEqual(at('boom'));
    expect(at('telltales')).toEqual(at('boom'));
    // The lantern stands on the masthead, and the pennant flies from a
    // short staff above it.
    const masthead = rig.boomHeight + rig.luff;
    for (const light of boat.lights) {
      expect(at(light)[2]).toBeCloseTo(-rig.mastPosition, 2);
      expect(at(light)[1] ?? 0).toBeGreaterThan(masthead);
      expect(at(light)[1] ?? 0).toBeLessThan(masthead + 0.3);
    }
    expect(at('pennant')[2]).toBeCloseTo(-rig.mastPosition, 2);
    for (const light of boat.lights) {
      expect(at('pennant')[1] ?? 0).toBeGreaterThan(at(light)[1] ?? 0);
    }
    expect(at('pennant')[1] ?? 0).toBeLessThan(masthead + 0.5);
    expect(at('rudder')[2]).toBeCloseTo(foils.rudderPosition, 2);
    expect(at('daggerboard')[2]).toBeCloseTo(-foils.boardPosition, 2);
    expect(at('sailor')[1]).toBeCloseTo(hull.centreOfGravity + sailor.sailorSeatHeight, 2);
    for (const name of ['mast', 'boom', 'rudder', 'daggerboard', 'sailor']) {
      expect(Math.abs(at(name)[0] ?? 1)).toBeLessThan(CM);
    }
  });

  test('its sheer is the outline the physics bumps hulls with, within 1 cm', () => {
    const plan = node('hull').extras?.plan;
    expect(plan).toBeDefined();
    expect(plan?.deviation ?? 1).toBeLessThan(CM);
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

  test('its telltales sit at the height of each sail strip’s centre of effort', () => {
    const t = bounds('telltales');
    const width = 0.012;
    expect(Math.abs((t.min[1] ?? 0) + width / 2 - rig.footStrip * rig.luff)).toBeLessThan(CM);
    expect(Math.abs((t.max[1] ?? 0) - width / 2 - rig.headStrip * rig.luff)).toBeLessThan(CM);
    // On both faces of the cloth, close aft of the luff.
    expect(t.min[0]).toBeLessThan(0);
    expect(t.max[0]).toBeGreaterThan(0);
    expect(t.min[2] ?? 1).toBeLessThan(0.5);
    const p = g.meshes[node('telltales').mesh ?? -1]?.primitives[0];
    expect(p?.attributes.TEXCOORD_1).toBeDefined();
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
