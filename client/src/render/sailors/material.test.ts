// SPDX-License-Identifier: AGPL-3.0-only

import {
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Scene,
  SkinnedMesh,
  type Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';
import { checkScene, materialInfo } from '../materials';
import { readSailorLight, sailorColours, sailorLight, sailorMaterial } from './material';

const texture = () => new DataTexture(new Uint8Array(4), 1, 1);

describe('the sailor material', () => {
  test('is the factory’s, with the bend, and seen from both sides', () => {
    const m = sailorMaterial(texture(), texture());
    expect(materialInfo(m)).toEqual({ kind: 'lit', bend: 'vertex' });
    expect(m.side).toBe(DoubleSide);
    const scene = new Scene();
    scene.add(new SkinnedMesh(undefined, m));
    expect(checkScene(scene)).toEqual([]);
  });

  test('reads its colours from #RRGGBB, in linear values', () => {
    const c = sailorColours('#ffffff', '#000000', '#808080');
    expect(c.main.r).toBeCloseTo(1, 6);
    expect(c.skin.g).toBe(0);
    expect(c.hair.b).toBeCloseTo(0.2158, 3);
  });

  test('takes its light from the scene’s main and hemisphere lights', () => {
    const sun = new DirectionalLight(new Color(1, 0.5, 0.25), 2);
    sun.position.set(0, 3, 4);
    const hemi = new HemisphereLight(new Color(0.4, 0.5, 0.6), new Color(0.1, 0.1, 0.1), 2);
    readSailorLight(sun, hemi);
    const toward = sailorLight.toward.value as Vector3;
    expect(toward.x).toBeCloseTo(0, 6);
    expect(toward.y).toBeCloseTo(0.6, 6);
    expect(toward.z).toBeCloseTo(0.8, 6);
    expect((sailorLight.main.value as Color).r).toBeCloseTo(2, 6);
    const sky = sailorLight.sky.value as Color;
    expect(sky.b).toBeCloseTo(1.2, 6);
    // The sea a quarter of the sky's brightness, in the ground's colour.
    const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const sea = sailorLight.sea.value as Color;
    expect(lum(sea) / lum(sky)).toBeCloseTo(0.25, 6);
    expect(sea.r).toBeCloseTo(sea.g, 6);
  });
});
