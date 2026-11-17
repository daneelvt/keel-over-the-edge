// SPDX-License-Identifier: AGPL-3.0-only

import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Rig } from './rig';

/** A chain and a fork of bones, posed at random turns and places by a seed. */
function posed(seed: number): Rig {
  let s = seed;
  const r = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  const parent = Int32Array.from([-1, 0, 1, 2, 1, 4, 0]);
  const n = parent.length;
  const restPos = new Float32Array(3 * n);
  const restQuat = new Float32Array(4 * n);
  const rig = new Rig(
    Array.from({ length: n }, (_, i) => `bone${i}`),
    parent,
    restPos,
    restQuat,
  );
  const q = new Quaternion();
  for (let i = 0; i < n; i++) {
    q.set(r(), r(), r(), r())
      .normalize()
      .toArray(rig.quat, 4 * i);
    rig.pos.set([r() * 2, r() * 2, r() * 2], 3 * i);
  }
  // A base whose last row is not quite 0, 0, 0, 1, as an inverse can leave it.
  rig.base
    .compose(
      new Vector3(r(), r(), r()),
      q.set(r(), r(), r(), r()).normalize(),
      new Vector3(1, 1, 1),
    )
    .invert()
    .multiply(new Matrix4().makeRotationY(r()));
  return rig;
}

/** fk as it was: each bone's compose and multiply through Matrix4. */
function byMatrices(rig: Rig): Float32Array {
  const out = new Float32Array(rig.world.length);
  const local = new Matrix4();
  const m = new Matrix4();
  const q = new Quaternion();
  const v = new Vector3();
  const one = new Vector3(1, 1, 1);
  for (const i of rig.order) {
    local.compose(v.fromArray(rig.pos, 3 * i), q.fromArray(rig.quat, 4 * i), one);
    const p = rig.parent[i] as number;
    if (p < 0) {
      m.multiplyMatrices(rig.base, local);
    } else {
      m.fromArray(out, 16 * p).multiply(local);
    }
    m.toArray(out, 16 * i);
  }
  return out;
}

describe('a rig', () => {
  it('works each bone out to the same bits as three.js’s matrices do', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rig = posed(seed);
      rig.fk();
      const want = byMatrices(rig);
      for (let k = 0; k < want.length; k++) {
        // 0 and −0 alike.
        expect(rig.world[k] === want[k]).toBe(true);
      }
    }
  });

  it('works a bone and those below it out again alone, as fk would', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rig = posed(seed);
      rig.fk();
      for (const j of [1, 4, 6]) {
        new Quaternion(0.1 * j, 0.2, -0.3, 0.9).normalize().toArray(rig.quat, 4 * j);
        rig.fkFrom(j);
        const branch = Float32Array.from(rig.world);
        rig.fk();
        expect(branch).toEqual(rig.world);
      }
    }
  });
});
