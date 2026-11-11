// SPDX-License-Identifier: AGPL-3.0-only

// A boat's trapeze as its sailor needs it, from the boat's model: a node
// `trapeze` whose data says where its wires hang ({"hounds": [x, y, z],
// "rings": [starboard, port], "rackEdge": [x, y, z]}, in the model's frame;
// the rack's edge the starboard one, the port one its mirror); each side's
// wire a node of its own under it (`trapeze-starboard`, `trapeze-port`),
// hidden while the sailor hangs on that side and the wire is drawn to the
// hook instead. Read by the nodes' data, never by which boat it is.
//
// The clips on the wire are a file of their own beside a look's clips, and
// placed from the rack's edge on the clip's side; the harness, with the
// hook the wire's ring hangs on, another, worn only on such a boat.

import { Matrix4, type Object3D, Vector3 } from 'three';
import type { Rig } from './rig';

/** The clips on the wire, by name: out fully, and part out; their -port ones the mirror. */
export const TRAPEZE_CLIPS = {
  out: 'trapeze',
  low: 'trapeze-low',
} as const;
const PORT = '-port';
const ON_WIRE: readonly string[] = [
  TRAPEZE_CLIPS.out,
  `${TRAPEZE_CLIPS.out}${PORT}`,
  TRAPEZE_CLIPS.low,
  `${TRAPEZE_CLIPS.low}${PORT}`,
];

/** Whether a clip is on the wire: placed from the rack's edge, never moved to another seat. */
export function onWire(clip: string): boolean {
  return ON_WIRE.includes(clip);
}

/** The side a clip on the wire hangs on: −1 for a -port one, else +1. */
export function wireSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** A look's clips on the wire, beside its other clips (the art path of its clips' file). */
export function trapezeClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.trapeze.glb');
}

/** A look's trapeze harness, beside its clips (the art path of its clips' file). */
export function harnessFile(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.harness.glb');
}

/** A boat's trapeze, in its model's frame. */
export interface Trapeze {
  /** Where both wires meet the mast. */
  hounds: Vector3;
  /** Each wire's ring at rest: starboard, port. */
  rings: [Vector3, Vector3];
  /** The starboard rack's outer edge on its top at the helm's station: a clip on the wire is placed from it (the port one's its mirror). */
  rackEdge: Vector3;
  /** The physics' furthest reach out to windward (m): out fully on the wire. */
  reach: number;
}

function vec(a: unknown): Vector3 | null {
  return Array.isArray(a) &&
    a.length === 3 &&
    a.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? new Vector3(a[0] as number, a[1] as number, a[2] as number)
    : null;
}

/** A trapeze's points from its node's data, or null if the node says it is none. */
export function trapezeData(data: unknown): Omit<Trapeze, 'reach'> | null {
  const d = data as { hounds?: unknown; rings?: unknown; rackEdge?: unknown } | undefined;
  const hounds = vec(d?.hounds);
  const rackEdge = vec(d?.rackEdge);
  const rings = Array.isArray(d?.rings) ? (d.rings as unknown[]).map(vec) : [];
  const [starboard, port] = rings;
  if (
    hounds === null ||
    rackEdge === null ||
    rings.length !== 2 ||
    starboard === null ||
    starboard === undefined ||
    port === null ||
    port === undefined
  ) {
    return null;
  }
  return { hounds, rings: [starboard, port], rackEdge };
}

/**
 * The trapeze of a boat's model (its nodes by name), with the physics'
 * furthest reach; null if the model has none.
 */
export function trapezeOf(parts: Map<string, Object3D>, reach: number): Trapeze | null {
  const d = trapezeData(parts.get('trapeze')?.userData);
  return d === null ? null : { ...d, reach };
}

/** The model's wire node for a side (+1 starboard). */
export function wireNode(parts: Map<string, Object3D>, side: number): Object3D | undefined {
  return parts.get(side < 0 ? 'trapeze-port' : 'trapeze-starboard');
}

/** A clip's place on the wire (from the figure to the rack's edge) into the model's frame, on the clip's side. */
export function wirePlace(place: Matrix4, rackEdge: Vector3, side: number): Matrix4 {
  return new Matrix4().makeTranslation(side * rackEdge.x, rackEdge.y, rackEdge.z).multiply(place);
}

/**
 * Where the clips are blended, by how far out the sailor is (m) beyond the
 * rail (where the hiking ends, at rail): 0 at the rail, 1 with the part-out
 * clip fully, half way to the reach, 2 out fully at the reach.
 */
export function wireDepth(out: number, rail: number, reach: number): number {
  const low = (rail + reach) / 2;
  if (!(reach > rail) || out <= rail) {
    return 0;
  }
  if (out <= low) {
    return (out - rail) / (low - rail);
  }
  return 1 + Math.min(1, (out - low) / (reach - low));
}

/**
 * A point given in the figure's space at rest (the harness's hook), as
 * carried by the pelvis: against the bone's rest matrix, to be carried by
 * its posed one (its world matrix times this). The rig is left at rest.
 */
export function onPelvis(rig: Rig, point: Vector3, out = new Vector3()): Vector3 {
  const pelvis = rig.bone('pelvis');
  rig.reset();
  rig.fk();
  const m = new Matrix4().fromArray(rig.world, 16 * pelvis).invert();
  return out.copy(point).applyMatrix4(m);
}
