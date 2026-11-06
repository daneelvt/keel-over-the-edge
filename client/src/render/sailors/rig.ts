// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's skeleton as data: every bone's rest place and turn, its pose
// now (a turn and a place against its parent), and where that puts it in the
// figure's own space. The runtime poses the figure here, without three.js's
// matrices, and writes the pose to whichever level's bones are drawn: the
// deck level's, or the close level's when the camera is near; they share the
// skeleton, bone for bone by name.
//
// The figure's space is its file's: x to its left, y up, z forward, the
// origin on the ground between its feet. Nothing here allocates once made.

import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';

const q = new Quaternion();
const v = new Vector3();
const s1 = new Vector3(1, 1, 1);
const m = new Matrix4();
const local = new Matrix4();

export class Rig {
  readonly names: string[];
  readonly index = new Map<string, number>();
  /** Each bone's parent's index, or -1 for the root's. */
  readonly parent: Int32Array;
  /** The bones in an order where each comes after its parent. */
  readonly order: Int32Array;
  readonly restPos: Float32Array;
  readonly restQuat: Float32Array;
  /** The pose: each bone's turn (x, y, z, w) and place against its parent. */
  readonly quat: Float32Array;
  readonly pos: Float32Array;
  /** Each bone's matrix in the figure's space, column-major, from fk(). */
  readonly world: Float32Array;
  /** Where the root bone's parent is in the figure's space. */
  readonly base = new Matrix4();

  constructor(names: string[], parent: Int32Array, restPos: Float32Array, restQuat: Float32Array) {
    this.names = names;
    this.parent = parent;
    this.restPos = restPos;
    this.restQuat = restQuat;
    const n = names.length;
    names.forEach((name, i) => {
      this.index.set(name, i);
    });
    this.quat = new Float32Array(4 * n);
    this.pos = new Float32Array(3 * n);
    this.world = new Float32Array(16 * n);
    const order: number[] = [];
    const placed = new Uint8Array(n);
    while (order.length < n) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const p = parent[i] ?? -1;
        if (placed[i] === 0 && (p < 0 || placed[p] === 1)) {
          placed[i] = 1;
          order.push(i);
          moved = true;
        }
      }
      if (!moved) {
        throw new Error('the skeleton has a loop');
      }
    }
    this.order = Int32Array.from(order);
    this.reset();
  }

  /**
   * The skeleton under root (a file's scene): its bones, the nodes named
   * by names, at rest.
   */
  static from(root: Object3D, names: readonly string[]): Rig {
    const nodes = names.map((name) => {
      const o = root.getObjectByName(name);
      if (o === undefined) {
        throw new Error(`no bone ${name}`);
      }
      return o;
    });
    const parent = new Int32Array(nodes.length).fill(-1);
    const restPos = new Float32Array(3 * nodes.length);
    const restQuat = new Float32Array(4 * nodes.length);
    nodes.forEach((o, i) => {
      parent[i] = o.parent === null ? -1 : nodes.indexOf(o.parent);
      o.position.toArray(restPos, 3 * i);
      o.quaternion.toArray(restQuat, 4 * i);
    });
    const rig = new Rig([...names], parent, restPos, restQuat);
    // The root bone's parents, up to the scene: their place in it.
    root.updateMatrixWorld(true);
    const top = nodes.find((_, i) => parent[i] === -1)?.parent ?? null;
    if (top !== null) {
      rig.base.copy(root.matrixWorld).invert().multiply(top.matrixWorld);
    }
    return rig;
  }

  /** Every bone at rest. */
  reset(): void {
    this.quat.set(this.restQuat);
    this.pos.set(this.restPos);
  }

  /** Each bone's matrix in the figure's space, from the pose. */
  fk(): void {
    const { order, parent, quat, pos, world } = this;
    for (let k = 0; k < order.length; k++) {
      const i = order[k] as number;
      q.fromArray(quat, 4 * i);
      v.fromArray(pos, 3 * i);
      local.compose(v, q, s1);
      const p = parent[i] as number;
      if (p < 0) {
        m.multiplyMatrices(this.base, local);
      } else {
        m.fromArray(world, 16 * p).multiply(local);
      }
      m.toArray(world, 16 * i);
    }
  }

  /** Where a bone is in the figure's space, from the last fk(). */
  position(i: number, out: Vector3): Vector3 {
    const o = 16 * i;
    return out.set(this.world[o + 12] ?? 0, this.world[o + 13] ?? 0, this.world[o + 14] ?? 0);
  }

  /** A bone's turn in the figure's space, from the last fk(). */
  rotation(i: number, out: Quaternion): Quaternion {
    return out.setFromRotationMatrix(m.fromArray(this.world, 16 * i));
  }

  /** The turn of a bone's parent in the figure's space (the base's for the root). */
  parentRotation(i: number, out: Quaternion): Quaternion {
    const p = this.parent[i] as number;
    return p < 0 ? out.setFromRotationMatrix(this.base) : this.rotation(p, out);
  }

  /**
   * Turns a bone by a turn given in the figure's space (applied after its
   * pose), its children with it: on the last fk()'s parents.
   */
  turn(i: number, by: Quaternion): void {
    const pr = this.parentRotation(i, qa);
    // local' = parent⁻¹ · by · parent · local
    qb.copy(pr).invert().multiply(by).multiply(pr);
    q.fromArray(this.quat, 4 * i);
    qb.multiply(q)
      .normalize()
      .toArray(this.quat, 4 * i);
  }

  /** The bone's index by name; -1 if the skeleton has none. */
  bone(name: string): number {
    return this.index.get(name) ?? -1;
  }

  /** Writes the pose to bones listed in this skeleton's order (null where a level lacks one). */
  write(bones: readonly (Object3D | null)[]): void {
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      if (b !== null && b !== undefined) {
        b.quaternion.fromArray(this.quat, 4 * i);
        b.position.fromArray(this.pos, 3 * i);
      }
    }
  }
}

const qa = new Quaternion();
const qb = new Quaternion();

/** A level's bones in a skeleton's order, by name. */
export function bonesFor(rig: Rig, root: Object3D): (Object3D | null)[] {
  return rig.names.map((name) => root.getObjectByName(name) ?? null);
}
