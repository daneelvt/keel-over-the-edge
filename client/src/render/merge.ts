// SPDX-License-Identifier: AGPL-3.0-only

// A boat's parts that never move against her hull and share a material,
// drawn as one: the hull's fittings, a tall ship's masts and their iron,
// rope and blackwood. Each draw costs the main thread the same however
// little it draws, and a part is drawn twice a frame, in the shadow's pass
// and the scene's. Their geometries are put one after the other in the
// hull's frame, in float (a model's quantized positions would not survive
// being moved), in the file's order; what each draws is the same.

import {
  BufferAttribute,
  type BufferGeometry,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A geometry's attributes as plain floats, its index kept, moved by m. */
function floatsMoved(g: BufferGeometry, m: Matrix4): BufferGeometry {
  const out = g.clone();
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name);
    const f = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) {
        f[i * a.itemSize + c] = a.getComponent(i, c);
      }
    }
    out.setAttribute(name, new BufferAttribute(f, a.itemSize));
  }
  out.applyMatrix4(m);
  return out;
}

/** What parts must share to be drawn as one. */
function keyOf(mesh: Mesh): string {
  const g = mesh.geometry;
  const names = Object.keys(g.attributes)
    .sort()
    .map((n) => `${n}${g.getAttribute(n).itemSize}`)
    .join(',');
  return [
    (mesh.material as Material).uuid,
    mesh.castShadow,
    mesh.receiveShadow,
    mesh.renderOrder,
    g.index === null ? 'flat' : 'indexed',
    names,
  ].join('|');
}

/** What mergeStill is told of a boat's nodes. */
export interface Still {
  /** A mesh that is not to be merged: shaped, or found by its name. */
  kept(mesh: Mesh): boolean;
  /** A node whose meshes, and all below it, are not to be merged at all. */
  apart(node: Object3D): boolean;
  /** A node the boat moves: what hangs from it is merged in its frame, not root's. */
  moves(node: Object3D): boolean;
}

/**
 * Merges the meshes under root that share a material and all else a draw is
 * made from and hang still from the same node: root, or the nearest node
 * above them that moves. Returns how many meshes went into others.
 */
export function mergeStill(root: Object3D, still: Still): number {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { anchor: Object3D; meshes: Mesh[] }>();
  root.traverse((o) => {
    if (!(o instanceof Mesh) || o.type !== 'Mesh' || Array.isArray(o.material)) {
      return;
    }
    const g = o.geometry;
    if (
      g.groups.length > 0 ||
      Object.keys(g.morphAttributes).length > 0 ||
      !o.visible ||
      still.kept(o)
    ) {
      return;
    }
    let anchor: Object3D | null = null;
    for (let p: Object3D | null = o; p !== null && p !== root; p = p.parent) {
      if (still.apart(p)) {
        return;
      }
      if (anchor === null && p !== o && still.moves(p)) {
        anchor = p;
      }
    }
    const at = anchor ?? root;
    const key = `${at.uuid}|${keyOf(o)}`;
    const group = groups.get(key) ?? { anchor: at, meshes: [] };
    group.meshes.push(o);
    groups.set(key, group);
  });
  let merged = 0;
  for (const { anchor, meshes } of groups.values()) {
    if (meshes.length < 2) {
      continue;
    }
    const toAnchor = new Matrix4().copy(anchor.matrixWorld).invert();
    const first = meshes[0] as Mesh;
    const geometry = mergeGeometries(
      meshes.map((m) =>
        floatsMoved(m.geometry, new Matrix4().multiplyMatrices(toAnchor, m.matrixWorld)),
      ),
    );
    if (geometry === null) {
      continue;
    }
    const one = new Mesh(geometry, first.material);
    one.name = `${first.name} and ${meshes.length - 1} more`;
    one.castShadow = first.castShadow;
    one.receiveShadow = first.receiveShadow;
    one.renderOrder = first.renderOrder;
    one.frustumCulled = first.frustumCulled;
    one.userData = { ...first.userData };
    anchor.add(one);
    for (const m of meshes) {
      m.removeFromParent();
    }
    merged += meshes.length - 1;
  }
  return merged;
}
