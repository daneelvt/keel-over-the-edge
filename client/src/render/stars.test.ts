// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { Matrix3, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import {
  catalogueVector,
  ENTRY,
  FEW_STARS,
  findNamed,
  Stars,
  sceneStarMatrix,
  type TableStar,
  tableStar,
} from './stars';

const table = readFileSync(new URL('../sky/stars.bin', import.meta.url));
const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
const count = table.byteLength / ENTRY;

describe('the stars’ table', () => {
  test('holds 2,360 stars, brightest first, the first 1,336 to magnitude 5', () => {
    expect(count).toBe(2360);
    const s: TableStar = { ra: 0, dec: 0, magnitude: 0, colour: 0 };
    let last = -Infinity;
    for (let i = 0; i < count; i++) {
      tableStar(view, i, s);
      expect(s.magnitude).toBeGreaterThanOrEqual(last);
      expect(s.dec).toBeGreaterThanOrEqual(-45.01);
      last = s.magnitude;
    }
    const stars = new Stars();
    stars.load(
      table.buffer.slice(table.byteOffset, table.byteOffset + table.byteLength),
      catalog.sky.stars,
    );
    expect(stars.total).toBe(2360);
    expect(stars.brighterThan(FEW_STARS)).toBe(1336);
    expect(stars.mesh.geometry.index?.count).toBe(2360 * 6);
  });

  test('every named star is found in it, the Hub Star at the pole', () => {
    const named = findNamed(view, count, catalog.sky.stars);
    expect(named.map((n) => n.name)).toEqual(catalog.sky.stars.map((s) => s.name));
    const hub = named[0];
    const s = tableStar(view, hub?.index ?? -1, { ra: 0, dec: 0, magnitude: 0, colour: 0 });
    expect(s.dec).toBe(90);
    // Sirius is the brightest star in the sky.
    expect(named.find((n) => n.name === 'Sirius')?.index).toBe(0);
  });
});

describe('the stars’ matrix in the scene', () => {
  test('turns the module’s east, north and up into the scene’s x, y and −z', () => {
    // A turn of 30° about the pole, as the module would give it at the centre.
    const a = Math.PI / 6;
    const m: [number, number, number, number, number, number, number, number, number] = [
      Math.sin(a),
      -Math.cos(a),
      0,
      Math.cos(a),
      Math.sin(a),
      0,
      0,
      0,
      1,
    ];
    const s = sceneStarMatrix(m, 0, new Matrix3());
    const v = catalogueVector(45, 30, new Vector3());
    const got = v.clone().applyMatrix3(s);
    const e = m[0] * v.x + m[1] * v.y + m[2] * v.z;
    const n = m[3] * v.x + m[4] * v.y + m[5] * v.z;
    const u = m[6] * v.x + m[7] * v.y + m[8] * v.z;
    expect(got.x).toBeCloseTo(e, 12);
    expect(got.y).toBeCloseTo(u, 12);
    expect(got.z).toBeCloseTo(-n, 12);
  });
});
