// SPDX-License-Identifier: AGPL-3.0-only

import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { mergeStill } from './merge';

/** A box drawn in one draw, as a file's single primitive is. */
function box(x = 1, y = 1, z = 1): BoxGeometry {
  const g = new BoxGeometry(x, y, z);
  g.clearGroups();
  return g;
}

function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

/** Every vertex of root's meshes, in root's frame, sorted. */
function points(root: Object3D): string[] {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const out: string[] = [];
  for (const m of meshes(root)) {
    const p = m.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const v = new Vector3()
        .fromBufferAttribute(p, i)
        .applyMatrix4(m.matrixWorld)
        .applyMatrix4(inverse);
      out.push(`${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`);
    }
  }
  return out.sort();
}

describe('a boat’s still parts', () => {
  it('that share a material and hang still are drawn as one, where they were', () => {
    const spar = new MeshBasicMaterial();
    const rope = new MeshBasicMaterial();
    const hull = new Group();
    hull.name = 'hull';
    const mast = new Group();
    mast.name = 'foremast';
    mast.position.set(0, 2, 1);
    mast.rotation.z = 0.1;
    hull.add(mast);
    const boom = new Group();
    boom.name = 'boom';
    boom.position.set(0, 1, -1);
    hull.add(boom);
    const part = (name: string, m: MeshBasicMaterial, parent: Object3D, x: number): Mesh => {
      const mesh = new Mesh(box(0.1, 1, 0.1), m);
      mesh.name = name;
      mesh.position.x = x;
      parent.add(mesh);
      return mesh;
    };
    part('mesh_0', spar, hull, 0);
    part('mesh_1', spar, mast, 1);
    part('mesh_2', rope, mast, 2);
    part('mesh_3', spar, boom, 3);
    part('mesh_4', spar, boom, 4);
    // Named: found by its name, kept.
    part('telltale', spar, hull, 5);
    const before = points(hull);
    const merged = mergeStill(hull, {
      kept: (m) => !/^mesh_\d/.test(m.name),
      apart: () => false,
      moves: (o) => o.name === 'boom',
    });
    // The hull's and the foremast's spars as one, the boom's two as one.
    expect(merged).toBe(2);
    expect(meshes(hull)).toHaveLength(4);
    expect(boom.children.filter((c) => c instanceof Mesh)).toHaveLength(1);
    expect(points(hull)).toEqual(before);
    // What hangs from the boom still moves with it.
    boom.rotation.y = 1;
    const swung = meshes(boom)[0]?.getWorldPosition(new Vector3());
    expect(swung).toBeDefined();
  });

  it('leaves alone what is set apart', () => {
    const m = new MeshBasicMaterial();
    const root = new Group();
    const sail = new Group();
    sail.name = 'sail';
    root.add(sail);
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(box(), m);
      mesh.name = `mesh_${i}`;
      sail.add(mesh);
    }
    expect(
      mergeStill(root, { kept: () => false, apart: (o) => o.name === 'sail', moves: () => false }),
    ).toBe(0);
    expect(meshes(root)).toHaveLength(3);
  });
});
