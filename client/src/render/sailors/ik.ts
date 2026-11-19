// SPDX-License-Identifier: AGPL-3.0-only

// Two-bone IK on a sailor's skeleton (an arm: upper arm, forearm, hand; a
// leg: thigh, shin, foot), by Daniel Holden's analytic solve ("Simple
// Two Joint IK"): the middle joint opened or closed until the end is as far
// from the root as the target, in the plane the limb bends in now (the
// clip's elbow kept), then the limb turned at the root to point at it. The
// stretch is eased toward its most, as the clips' bake eases it, so a target
// passing out of reach does not kink the path. Allocation-free.

import { Quaternion, Vector3 } from 'three';
import type { Rig } from './rig';

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const t = new Vector3();
const ab = new Vector3();
const ac = new Vector3();
const at = new Vector3();
const ba = new Vector3();
const bc = new Vector3();
const axis0 = new Vector3();
const axis1 = new Vector3();
const ag = new Quaternion();
const bg = new Quaternion();
const r0 = new Quaternion();
const r1 = new Quaternion();
const r2 = new Quaternion();
const lq = new Quaternion();
const inv = new Quaternion();

/** The most an arm stretches, of its length, and where the easing toward it starts. */
export const REACH = 0.85;
export const SOFT = 0.92;

const clampAcos = (x: number): number => Math.acos(Math.max(-1, Math.min(1, x)));

/**
 * Turns root and mid so the end bone's head reaches target (the figure's
 * space), as near as the limb's stretch allows (reach of its length);
 * fk() is run before and after. weight blends from the pose as it was (0)
 * to the solve (1).
 */
export function twoBone(
  rig: Rig,
  root: number,
  mid: number,
  end: number,
  target: Vector3,
  weight = 1,
  reach = REACH,
): void {
  if (weight <= 0) {
    return;
  }
  rig.fk();
  rig.position(root, a);
  rig.position(mid, b);
  rig.position(end, c);
  const lab = b.distanceTo(a);
  const lcb = c.distanceTo(b);
  const most = reach * (lab + lcb);
  t.copy(target);
  at.subVectors(t, a);
  let d = at.length();
  const knee = SOFT * most;
  if (d > knee) {
    d = knee + (most - knee) * (1 - Math.exp(-(d - knee) / (most - knee)));
  }
  d = Math.max(Math.abs(lab - lcb) + 1e-3, d);
  ac.subVectors(c, a);
  ab.subVectors(b, a);
  ba.subVectors(a, b);
  bc.subVectors(c, b);
  const lac = ac.length();
  if (lac < 1e-6 || at.lengthSq() < 1e-12) {
    return;
  }
  const acab0 = clampAcos(ac.dot(ab) / (lac * lab));
  const babc0 = clampAcos(ba.dot(bc) / (lab * lcb));
  const acat0 = clampAcos(ac.dot(at) / (lac * at.length()));
  const acab1 = clampAcos((lcb * lcb - lab * lab - d * d) / (-2 * lab * d));
  const babc1 = clampAcos((d * d - lab * lab - lcb * lcb) / (-2 * lab * lcb));
  // The plane the limb bends in now; straight, any plane but the target's.
  axis0.crossVectors(ac, ab);
  if (axis0.lengthSq() < 1e-10) {
    axis0.set(1, 0, 0).cross(ac);
  }
  axis0.normalize();
  axis1.crossVectors(ac, at);
  const turn1 = axis1.lengthSq() > 1e-12;
  axis1.normalize();
  rig.rotation(root, ag);
  rig.rotation(mid, bg);
  r0.setFromAxisAngle(t.copy(axis0).applyQuaternion(inv.copy(ag).invert()), acab1 - acab0);
  r1.setFromAxisAngle(t.copy(axis0).applyQuaternion(inv.copy(bg).invert()), babc1 - babc0);
  if (turn1) {
    r2.setFromAxisAngle(t.copy(axis1).applyQuaternion(inv.copy(ag).invert()), acat0);
  } else {
    r2.identity();
  }
  lq.fromArray(rig.quat, 4 * root);
  const before = inv.copy(lq);
  lq.multiply(r0.multiply(r2)).normalize();
  if (weight < 1) {
    lq.copy(before.slerp(lq, weight));
  }
  lq.toArray(rig.quat, 4 * root);
  lq.fromArray(rig.quat, 4 * mid);
  r2.copy(lq);
  lq.multiply(r1).normalize();
  if (weight < 1) {
    lq.copy(r2.slerp(lq, weight));
  }
  lq.toArray(rig.quat, 4 * mid);
  rig.fk();
}
