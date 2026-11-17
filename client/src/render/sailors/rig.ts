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

import { Matrix4, type Object3D, Quaternion, type Vector3 } from 'three';

const q = new Quaternion();
const m = new Matrix4();

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

  /**
   * Each bone's matrix in the figure's space, from the pose: its parent's
   * times its own turn and place, worked as Matrix4's compose and multiply
   * work them, less the terms a turn and a place make 0 or 1 (so to the
   * same bits), with no matrices copied in and out.
   */
  fk(): void {
    const order = this.order;
    for (let k = 0; k < order.length; k++) {
      this.#bone(order[k] as number);
    }
  }

  /**
   * fk() for a bone and the bones below it alone, after a change to its
   * pose: the rest are as they were.
   */
  fkFrom(i: number): void {
    let branch = this.#branches[i];
    if (branch === undefined) {
      const below = new Uint8Array(this.names.length);
      below[i] = 1;
      const list: number[] = [];
      for (const b of this.order) {
        const p = this.parent[b] as number;
        if (b === i || (p >= 0 && below[p] === 1)) {
          below[b] = 1;
          list.push(b);
        }
      }
      branch = Int32Array.from(list);
      this.#branches[i] = branch;
    }
    for (let k = 0; k < branch.length; k++) {
      this.#bone(branch[k] as number);
    }
  }

  /** Each bone's branch for fkFrom, made at its first use. */
  readonly #branches: (Int32Array | undefined)[] = [];

  #bone(i: number): void {
    const { parent, quat, pos, world } = this;
    const base = this.base.elements;
    const qi = 4 * i;
    const x = quat[qi] as number;
    const y = quat[qi + 1] as number;
    const z = quat[qi + 2] as number;
    const w = quat[qi + 3] as number;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    // The bone's own: a turn and a place, its last row 0, 0, 0, 1.
    const b11 = 1 - (yy + zz);
    const b21 = xy + wz;
    const b31 = xz - wy;
    const b12 = xy - wz;
    const b22 = 1 - (xx + zz);
    const b32 = yz + wx;
    const b13 = xz + wy;
    const b23 = yz - wx;
    const b33 = 1 - (xx + yy);
    const b14 = pos[3 * i] as number;
    const b24 = pos[3 * i + 1] as number;
    const b34 = pos[3 * i + 2] as number;
    const p = parent[i] as number;
    const a: ArrayLike<number> = p < 0 ? base : world;
    const o = p < 0 ? 0 : 16 * p;
    const a11 = a[o] as number;
    const a21 = a[o + 1] as number;
    const a31 = a[o + 2] as number;
    const a41 = a[o + 3] as number;
    const a12 = a[o + 4] as number;
    const a22 = a[o + 5] as number;
    const a32 = a[o + 6] as number;
    const a42 = a[o + 7] as number;
    const a13 = a[o + 8] as number;
    const a23 = a[o + 9] as number;
    const a33 = a[o + 10] as number;
    const a43 = a[o + 11] as number;
    const a14 = a[o + 12] as number;
    const a24 = a[o + 13] as number;
    const a34 = a[o + 14] as number;
    const a44 = a[o + 15] as number;
    const t = 16 * i;
    world[t] = a11 * b11 + a12 * b21 + a13 * b31;
    world[t + 4] = a11 * b12 + a12 * b22 + a13 * b32;
    world[t + 8] = a11 * b13 + a12 * b23 + a13 * b33;
    world[t + 12] = a11 * b14 + a12 * b24 + a13 * b34 + a14;
    world[t + 1] = a21 * b11 + a22 * b21 + a23 * b31;
    world[t + 5] = a21 * b12 + a22 * b22 + a23 * b32;
    world[t + 9] = a21 * b13 + a22 * b23 + a23 * b33;
    world[t + 13] = a21 * b14 + a22 * b24 + a23 * b34 + a24;
    world[t + 2] = a31 * b11 + a32 * b21 + a33 * b31;
    world[t + 6] = a31 * b12 + a32 * b22 + a33 * b32;
    world[t + 10] = a31 * b13 + a32 * b23 + a33 * b33;
    world[t + 14] = a31 * b14 + a32 * b24 + a33 * b34 + a34;
    world[t + 3] = a41 * b11 + a42 * b21 + a43 * b31;
    world[t + 7] = a41 * b12 + a42 * b22 + a43 * b32;
    world[t + 11] = a41 * b13 + a42 * b23 + a43 * b33;
    world[t + 15] = a41 * b14 + a42 * b24 + a43 * b34 + a44;
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
