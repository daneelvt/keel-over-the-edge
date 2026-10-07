// SPDX-License-Identifier: AGPL-3.0-only

import { Mesh, MeshBasicMaterial, Scene } from 'three';
import { describe, expect, test } from 'vitest';
import {
  basicMaterial,
  checkScene,
  domeDrop,
  horizonDistance,
  litMaterial,
  materialInfo,
  seaMaterial,
  skyMaterial,
} from './materials';

describe('the dome', () => {
  test('drops 2 m at 100 m and 20 m at 316 m', () => {
    expect(domeDrop(100)).toBeCloseTo(2, 10);
    expect(domeDrop(316)).toBeCloseTo(19.97, 2);
  });

  test('puts the horizon 100 m away from 2 m up, 316 m from 20 m', () => {
    expect(horizonDistance(2)).toBeCloseTo(100, 10);
    expect(horizonDistance(20)).toBeCloseTo(316.2, 1);
    expect(horizonDistance(-1)).toBe(0);
  });
});

describe('the factory', () => {
  test('marks every material with its kind and bend', () => {
    expect(materialInfo(litMaterial())).toEqual({ kind: 'lit', bend: 'vertex' });
    expect(materialInfo(basicMaterial())).toEqual({ kind: 'basic', bend: 'vertex' });
    expect(materialInfo(seaMaterial('sea-tile'))).toEqual({
      kind: 'sea-tile',
      bend: 'tile-centre',
    });
    expect(materialInfo(seaMaterial('sea-far'))).toEqual({
      kind: 'sea-far',
      bend: 'vertex-in-node',
    });
    expect(materialInfo(skyMaterial())).toEqual({ kind: 'sky', bend: 'none' });
    expect(materialInfo(new MeshBasicMaterial())).toBeUndefined();
  });

  test('the bend is the vertex node of every bent kind', () => {
    expect(litMaterial().positionNode).not.toBeNull();
    expect(basicMaterial().positionNode).not.toBeNull();
  });

  test('the scene walk passes the factory’s materials and fails a plain one', () => {
    const scene = new Scene();
    scene.add(new Mesh(undefined, litMaterial()), new Mesh(undefined, skyMaterial()));
    expect(checkScene(scene)).toEqual([]);
    const plain = new Mesh(undefined, new MeshBasicMaterial());
    plain.name = 'plain';
    scene.add(plain);
    expect(checkScene(scene)).toEqual([
      'plain (MeshBasicMaterial): not made by the material factory',
    ]);
  });
});
