// SPDX-License-Identifier: AGPL-3.0-only

// The sailors the Blender build committed (art/sailors/<look>/), read as
// the game will load them: each version's close and deck levels skinned to
// one skeleton, the far level one rigid figure with the place it sits in,
// one material whose base colour is the atlas and whose occlusion texture
// is the mask, both KTX2; and the clips with a place each, those at a
// wheel, those on a trapeze's wire, those on a rail (with the crouch) and
// the ship's company's (about her decks, and her work and aloft) in files
// of their own; and the trapeze harness, skinned to the same skeleton, with
// its hook.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ALOFT_CLIPS, DECK_CLIPS, NOT_FOR_MACHINES, shipAnchor } from './ship';

interface Gltf {
  extensionsUsed?: string[];
  nodes: { name?: string; mesh?: number; skin?: number; matrix?: number[] }[];
  skins?: { joints: number[] }[];
  materials?: {
    name: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number }; baseColorFactor?: number[] };
    occlusionTexture?: { index: number };
  }[];
  images?: { mimeType?: string }[];
  animations?: { name: string }[];
}

const ART = new URL('../../../../art/sailors/', import.meta.url);

function readGltf(path: string): Gltf {
  const glb = readFileSync(new URL(path, ART));
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString('utf8')) as Gltf;
}

/** The looks' folders: each holds a look's files, by version. */
const looks = readdirSync(ART, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() && readdirSync(new URL(`${d.name}/`, ART)).some((f) => f.endsWith('.glb')),
  )
  .filter((d) => d.name !== 'vendor')
  .map((d) => d.name);

test('the test sailor is committed', () => {
  expect(looks).toContain('test');
});

describe.each(looks)('%s', (look) => {
  const versions = readdirSync(new URL(`${look}/`, ART))
    .map((f) => /^([a-z]+)\.glb$/.exec(f)?.[1])
    .filter((v) => v !== undefined);

  test('has both versions', () => {
    expect(versions.sort()).toEqual(['female', 'male']);
  });

  describe.each(versions)('%s', (version) => {
    const levels = {
      close: readGltf(`${look}/${version}.glb`),
      deck: readGltf(`${look}/${version}.deck.glb`),
      far: readGltf(`${look}/${version}.far.glb`),
    };
    const clips = readGltf(`${look}/${version}.clips.glb`);
    const joints = (g: Gltf) => (g.skins?.[0]?.joints ?? []).map((j) => g.nodes[j]?.name);

    test('every level has one material: the atlas and the mask, in KTX2', () => {
      for (const g of Object.values(levels)) {
        expect(g.materials?.map((m) => m.name)).toEqual(['sailor']);
        const m = g.materials?.[0];
        expect(m?.pbrMetallicRoughness?.baseColorTexture).toBeDefined();
        expect(m?.occlusionTexture).toBeDefined();
        expect(g.images?.map((i) => i.mimeType)).toEqual(['image/ktx2', 'image/ktx2']);
        expect(g.extensionsUsed).toContain('KHR_texture_basisu');
      }
    });

    test('the close and deck levels share one skeleton, the clips’ too', () => {
      const bones = joints(levels.close);
      expect(bones.length).toBeGreaterThan(53);
      expect(joints(levels.deck)).toEqual(bones);
      expect(joints(clips)).toEqual(bones);
      for (const g of [levels.close, levels.deck]) {
        const meshes = g.nodes.filter((n) => n.mesh !== undefined);
        expect(meshes.length).toBeGreaterThan(0);
        expect(meshes.every((n) => n.skin === 0)).toBe(true);
      }
    });

    test('the far level is one rigid figure, with the place it sits in', () => {
      expect(levels.far.skins ?? []).toEqual([]);
      expect(levels.far.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name)).toEqual([
        'figure',
      ]);
      expect(levels.far.nodes.find((n) => n.name === 'place')?.matrix).toHaveLength(16);
    });

    test('its clips at a wheel, a file of their own on its skeleton, placed from the helmsman’s place', () => {
      if (look === 'test') {
        return;
      }
      const wheel = readGltf(`${look}/${version}.wheel.glb`);
      const names = (wheel.animations ?? []).map((a) => a.name).sort();
      expect(names).toEqual(['habit-wheel', 'helm-wheel', 'helm-wheel-port']);
      expect(joints(wheel)).toEqual(joints(clips));
      for (const name of names) {
        const m = wheel.nodes.find((n) => n.name === `place-${name}`)?.matrix ?? [];
        // Standing on the deck at the helmsman's place, facing forward (−z).
        expect(Math.hypot(m[12] ?? 9, m[14] ?? 9), name).toBeLessThan(0.3);
        expect(Math.abs(m[13] ?? 9), name).toBeLessThan(0.1);
        expect(m[10], name).toBeLessThan(-0.99);
      }
    });

    test('its clips on a trapeze’s wire, a file of their own on its skeleton, placed from the rack’s edge', () => {
      if (look === 'test') {
        return;
      }
      const wire = readGltf(`${look}/${version}.trapeze.glb`);
      const names = (wire.animations ?? []).map((a) => a.name).sort();
      expect(names).toEqual(['trapeze', 'trapeze-low', 'trapeze-low-port', 'trapeze-port']);
      expect(joints(wire)).toEqual(joints(clips));
      for (const name of names) {
        const m = wire.nodes.find((n) => n.name === `place-${name}`)?.matrix ?? [];
        // About the rack's edge, the figure's up lying back outboard on its side.
        expect(Math.hypot(m[12] ?? 9, m[13] ?? 9, m[14] ?? 9), name).toBeLessThan(0.3);
        const side = name.endsWith('-port') ? -1 : 1;
        expect(side * (m[4] ?? 0), name).toBeGreaterThan(0.5);
      }
    });

    test('its clips on a rail and its crouch, a file of their own on its skeleton: those on the rail placed from the deck’s edge facing outboard, the crouch not placed', () => {
      if (look === 'test') {
        return;
      }
      const rail = readGltf(`${look}/${version}.rail.glb`);
      const names = (rail.animations ?? []).map((a) => a.name).sort();
      expect(names).toEqual([
        'crouch-enter',
        'crouch-exit',
        'crouch-walk',
        'rail',
        'rail-out',
        'rail-out-port',
        'rail-port',
      ]);
      expect(joints(rail)).toEqual(joints(clips));
      for (const name of names) {
        const m = rail.nodes.find((n) => n.name === `place-${name}`)?.matrix ?? [];
        if (name.startsWith('crouch')) {
          expect(m, name).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          continue;
        }
        // About the deck's edge, upright, the figure's front (+z) outboard on its side.
        expect(Math.hypot(m[12] ?? 9, m[13] ?? 9, m[14] ?? 9), name).toBeLessThan(1.2);
        expect(m[5] ?? 0, name).toBeGreaterThan(0.99);
        const side = name.endsWith('-port') ? -1 : 1;
        expect(side * (m[8] ?? 0), name).toBeGreaterThan(0.99);
      }
    });

    test('its clips about the ship’s decks and of her work and aloft, two files of their own on its skeleton: those set on her placed upright from their place, the rest not placed', () => {
      if (look === 'test') {
        return;
      }
      const deck = readGltf(`${look}/${version}.ship.glb`);
      const aloft = readGltf(`${look}/${version}.aloft.glb`);
      const names = (g: Gltf) => (g.animations ?? []).map((a) => a.name).sort();
      expect(names(deck)).toEqual(
        [...DECK_CLIPS.idles, ...DECK_CLIPS.leaning, ...DECK_CLIPS.seated, DECK_CLIPS.walk]
          .filter((c) => look !== 'machine' || !NOT_FOR_MACHINES.includes(c))
          .sort(),
      );
      expect(names(aloft)).toEqual(
        Object.values(ALOFT_CLIPS)
          .flatMap((c) => [c, `${c}-port`])
          .sort(),
      );
      for (const g of [deck, aloft]) {
        expect(joints(g)).toEqual(joints(clips));
        for (const name of names(g)) {
          const m = g.nodes.find((n) => n.name === `place-${name}`)?.matrix ?? [];
          if (shipAnchor(name) === null) {
            expect(m, name).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            continue;
          }
          // Upright, near its place on the ship.
          expect(m[5] ?? 0, name).toBeGreaterThan(0.99);
          expect(Math.hypot(m[12] ?? 9, m[13] ?? 9, m[14] ?? 9), name).toBeLessThan(1.5);
        }
      }
      // Leaning on the starboard rail facing outboard (+x); sat on the hatch
      // and in the top and on the yard facing forward (−z); hauling facing
      // aft along the fall (+z).
      const facing = (g: Gltf, n: string) =>
        g.nodes.find((x) => x.name === `place-${n}`)?.matrix ?? [];
      expect(facing(deck, 'leaning')[8]).toBeGreaterThan(0.99);
      expect(facing(deck, 'hatch-sit')[10]).toBeLessThan(-0.99);
      expect(facing(aloft, 'aloft')[10]).toBeLessThan(-0.99);
      expect(facing(aloft, 'yard-port')[10]).toBeLessThan(-0.99);
      expect(facing(aloft, 'haul')[10]).toBeGreaterThan(0.95);
    });

    test('its trapeze harness: one mesh on its skeleton, leather and bronze, and its hook', () => {
      if (look === 'test') {
        return;
      }
      const harness = readGltf(`${look}/${version}.harness.glb`);
      expect(harness.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name)).toEqual([
        'harness',
      ]);
      expect(harness.nodes.find((n) => n.name === 'harness')?.skin).toBe(0);
      expect(joints(harness)).toEqual(joints(clips));
      expect(harness.materials?.map((m) => m.name)).toEqual(['harness-leather', 'harness-bronze']);
      for (const m of harness.materials ?? []) {
        expect(m.pbrMetallicRoughness?.baseColorFactor).toHaveLength(4);
        expect(m.pbrMetallicRoughness?.baseColorTexture).toBeUndefined();
      }
      expect(harness.images ?? []).toEqual([]);
      // The hook's eye before the waist, standing at rest.
      const hook = harness.nodes.find((n) => n.name === 'place-hook')?.matrix ?? [];
      expect(hook).toHaveLength(16);
      expect(hook[13]).toBeGreaterThan(0.7);
      expect(hook[13]).toBeLessThan(1.3);
      expect(hook[14]).toBeGreaterThan(0.05);
    });

    test('every clip has its place', () => {
      const names = (clips.animations ?? []).map((a) => a.name);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(clips.nodes.find((n) => n.name === `place-${name}`)?.matrix).toHaveLength(16);
      }
    });
  });
});
