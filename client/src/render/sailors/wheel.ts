// SPDX-License-Identifier: AGPL-3.0-only

// A boat's wheel as its sailor needs it, from the boat's model: a node
// `wheel` whose data says it is one ({"wheel": {"radius": r, "spokes": n}}),
// its origin the hub, its axle fore and aft; and the `sailor` node, where
// the helmsman stands between the feet on the deck, facing forward. Read by
// the nodes' data, never by which boat it is.

import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import type { WheelHelm } from './runtime';

/** A wheel's numbers from its node's data, or null if the node says it is none. */
export function wheelData(data: unknown): { radius: number; spokes: number } | null {
  const w = (data as { wheel?: { radius?: unknown; spokes?: unknown } } | undefined)?.wheel;
  if (
    w === undefined ||
    typeof w.radius !== 'number' ||
    typeof w.spokes !== 'number' ||
    !(w.radius > 0) ||
    !(w.spokes >= 2)
  ) {
    return null;
  }
  return { radius: w.radius, spokes: Math.round(w.spokes) };
}

/** A node's frame in an ancestor's (the model's; null, its topmost's), from the local transforms between them. */
export function frameIn(o: Object3D, model: Object3D | null, out: Matrix4): Matrix4 {
  out.identity();
  for (let p: Object3D | null = o; p !== null && p !== model; p = p.parent) {
    p.updateMatrix();
    out.premultiply(p.matrix);
  }
  return out;
}

/**
 * The wheel of a boat's model (its nodes by name, under model: null for
 * the topmost node they are under), at rest,
 * and the turn of its node then; null if the model has no wheel or no
 * place for its helmsman.
 */
export function wheelOf(parts: Map<string, Object3D>, model: Object3D | null): WheelHelm | null {
  const node = parts.get('wheel');
  const stand = parts.get('sailor');
  const data = wheelData(node?.userData);
  if (node === undefined || stand === undefined || data === null) {
    return null;
  }
  const at = frameIn(node, model, new Matrix4());
  return {
    stand: frameIn(stand, model, new Matrix4()),
    hub: new Vector3().setFromMatrixPosition(at),
    radius: data.radius,
    spokes: data.spokes,
    turn: 0,
  };
}

const m = new Matrix4();
const q = new Quaternion();
const r = new Quaternion();
const s = new Vector3();
const t = new Vector3();

/** A node's turn in the model's frame, into out: a wheel's at rest, to measure its turn from. */
export function turnIn(node: Object3D, model: Object3D, out: Quaternion): Quaternion {
  frameIn(node, model, m).decompose(t, out, s);
  return out;
}

/**
 * How far a wheel's node has turned from its rest (its turn in the model's
 * frame then), about the boat's fore-and-aft axis: positive, the top to
 * starboard. Within a turn either way: all the hands need of it.
 */
export function wheelTurnOf(node: Object3D, model: Object3D, rest: Quaternion): number {
  turnIn(node, model, q).multiply(r.copy(rest).invert());
  // The change's twist about z: about −z (forward) takes the top to starboard.
  return -2 * Math.atan2(q.z, q.w);
}
