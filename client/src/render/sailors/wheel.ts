// SPDX-License-Identifier: AGPL-3.0-only

// A boat's wheel as its sailor needs it, from the boat's model: a node
// `wheel` whose data says it is one ({"wheel": {"radius": r, "spokes": n}}),
// its origin the hub, its axle fore and aft; and the `sailor` node, where
// the helmsman stands between the feet on the deck, facing forward. A boat
// of two wheels says how far out each is (its `spread`): the node is then
// on the centreline, at their hubs' height and station, with a child for
// each, `wheel-port` and `wheel-starboard`, and the `sailor` node between
// them, the helmsman standing aft of whichever wheel the physics puts the
// sailor at. Read by the nodes' data, never by which boat it is.

import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import type { WheelHelm } from './runtime';

/**
 * A look's clips at a wheel, beside its other clips (the art path of its
 * clips' file, as the catalog names it): only a boat steered by one loads
 * them.
 */
export function wheelClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.wheel.glb');
}

/** A wheel's numbers from its node's data, or null if the node says it is none: its spread 0 for one wheel on the centreline. */
export function wheelData(
  data: unknown,
): { radius: number; spokes: number; spread: number } | null {
  const w = (
    data as { wheel?: { radius?: unknown; spokes?: unknown; spread?: unknown } } | undefined
  )?.wheel;
  if (
    w === undefined ||
    typeof w.radius !== 'number' ||
    typeof w.spokes !== 'number' ||
    !(w.radius > 0) ||
    !(w.spokes >= 2)
  ) {
    return null;
  }
  const spread = typeof w.spread === 'number' && w.spread > 0 ? w.spread : 0;
  return { radius: w.radius, spokes: Math.round(w.spokes), spread };
}

/** The nodes that turn with the rudder: a boat's two wheels, or its one. */
export function wheelNodes(parts: Map<string, Object3D>): Object3D[] {
  const port = parts.get('wheel-port');
  const starboard = parts.get('wheel-starboard');
  if (port !== undefined && starboard !== undefined) {
    return [port, starboard];
  }
  const one = parts.get('wheel');
  return one === undefined ? [] : [one];
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
    spread: data.spread,
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
