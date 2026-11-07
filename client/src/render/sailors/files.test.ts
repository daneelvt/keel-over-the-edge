// SPDX-License-Identifier: AGPL-3.0-only

// The sailors the Blender build committed (art/sailors/<look>/), read as
// the game will load them: each version's close and deck levels skinned to
// one skeleton, the far level one rigid figure with the place it sits in,
// one material whose base colour is the atlas and whose occlusion texture
// is the mask, both KTX2; and the clips with a place each, those at a wheel
// in a file of their own.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface Gltf {
  extensionsUsed?: string[];
  nodes: { name?: string; mesh?: number; skin?: number; matrix?: number[] }[];
  skins?: { joints: number[] }[];
  materials?: {
    name: string;
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } };
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

    test('every clip has its place', () => {
      const names = (clips.animations ?? []).map((a) => a.name);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(clips.nodes.find((n) => n.name === `place-${name}`)?.matrix).toHaveLength(16);
      }
    });
  });
});
