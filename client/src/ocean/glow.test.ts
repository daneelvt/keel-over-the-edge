// SPDX-License-Identifier: AGPL-3.0-only

// Glowing water is a uniform: set every frame, it changes no material and
// makes no new value.

import { type Material, Scene, Vector4 } from 'three';
import { afterEach, describe, expect, test } from 'vitest';
import { Ocean } from './ocean';
import { seaGlow } from './seamaterial';

describe('the water’s glow', () => {
  afterEach(() => {
    (seaGlow.value as Vector4).set(0, 0, 0, 0);
  });

  test('is none until set', () => {
    expect((seaGlow.value as Vector4).toArray()).toEqual([0, 0, 0, 0]);
  });

  test('set every frame, changes only the uniform’s value, in place', () => {
    const ocean = new Ocean(new Scene());
    const meshes = [ocean.passTiles.mesh, ocean.vertexTiles.mesh, ocean.far.mesh];
    const materials = meshes.map((m) => m.material as Material);
    const versions = materials.map((m) => m.version);
    const fragments = materials.map(
      (m) => (m as unknown as { fragmentNode: unknown }).fragmentNode,
    );
    const value = seaGlow.value;
    for (let i = 0; i < 1000; i++) {
      ocean.setGlow(0.38, 0.94, 0.81, (i % 100) / 99);
    }
    expect(seaGlow.value).toBe(value);
    expect(meshes.map((m) => m.material)).toEqual(materials);
    meshes.forEach((m, i) => {
      expect(m.material).toBe(materials[i]);
    });
    expect(materials.map((m) => m.version)).toEqual(versions);
    expect(materials.map((m) => (m as unknown as { fragmentNode: unknown }).fragmentNode)).toEqual(
      fragments,
    );
    const v = seaGlow.value as Vector4;
    expect(v.x).toBe(0.38);
    expect(v.y).toBe(0.94);
    expect(v.z).toBe(0.81);
    expect(v.w).toBe(1);
  });

  test('holds its strength from 0 to 1', () => {
    const ocean = new Ocean(new Scene());
    ocean.setGlow(0.4, 0.9, 0.8, 2);
    expect((seaGlow.value as Vector4).w).toBe(1);
    ocean.setGlow(0.4, 0.9, 0.8, -1);
    expect((seaGlow.value as Vector4).w).toBe(0);
    ocean.setGlow(0.4, 0.9, 0.8, Number.NaN);
    expect((seaGlow.value as Vector4).w).toBe(0);
    expect(seaGlow.value).toBeInstanceOf(Vector4);
  });
});
