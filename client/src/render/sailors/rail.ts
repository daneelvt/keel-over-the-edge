// SPDX-License-Identifier: AGPL-3.0-only

// The crew on a keelboat's rail, as their clips have it: sat on the deck's
// edge facing outboard with the legs over the side, upright (`rail`) or
// leaning out over the water (`rail-out`), each with its -port mirror for
// the port side's rail; and a crouch to move about the deck under a boom:
// down into it from standing (`crouch-enter`), walking in it
// (`crouch-walk`, a loop) and up out of it (`crouch-exit`).
//
// They are a file of their own beside a look's clips, `<version>.rail.glb`,
// loaded only when someone is drawn on a rail or moving about in a crouch.
// A clip on the rail is placed from the deck's edge on its side (its
// `place-<clip>` from the figure to the edge's point, the starboard edge's
// for a clip, the port's for its -port): put the edge's point of a station
// on the rail under it. The keelboat's model marks one such point, its
// `rail` node: the starboard deck's edge beside the cuddy. The crouch's
// clips are not placed: the figure stands on a flat deck at its origin,
// facing +z, the soles on the deck.
//
// The walk is in place: a foot bearing on the deck moves back (−z) at
// CROUCH_SPEED, so a figure moved forward at that speed, times the rate the
// clip plays at, keeps its feet still on the deck. While crouched, the
// head's joint is no higher than CROUCH_HEAD over the deck.

import { Matrix4, type Object3D, type Vector3 } from 'three';

/** The clips on the rail, by name: sat upright, and leaning out; their -port ones the mirror. */
export const RAIL_CLIPS = {
  up: 'rail',
  out: 'rail-out',
} as const;

/** The crouch's clips, by name: going down into it, walking in it (a loop), and coming up. */
export const CROUCH_CLIPS = {
  enter: 'crouch-enter',
  walk: 'crouch-walk',
  exit: 'crouch-exit',
} as const;

/** How fast the walk goes over the deck at its own rate, m/s: a foot bearing on it moves back this fast. */
export const CROUCH_SPEED = 0.7;
/** The most the head's joint is over the deck while crouched, m. */
export const CROUCH_HEAD = 0.7;

const PORT = '-port';
const ON_RAIL: readonly string[] = [
  RAIL_CLIPS.up,
  `${RAIL_CLIPS.up}${PORT}`,
  RAIL_CLIPS.out,
  `${RAIL_CLIPS.out}${PORT}`,
];
const IN_FILE: readonly string[] = [...ON_RAIL, ...Object.values(CROUCH_CLIPS)];

/** Whether a clip is on the rail: placed from the deck's edge on its side. */
export function onRail(clip: string): boolean {
  return ON_RAIL.includes(clip);
}

/** Whether a clip is in the rail's file: those on the rail and the crouch's. */
export function inRailFile(clip: string): boolean {
  return IN_FILE.includes(clip);
}

/** The side a clip on the rail sits on: −1 for a -port one, else +1. */
export function railSide(clip: string): number {
  return clip.endsWith(PORT) ? -1 : 1;
}

/** A look's clips on the rail and its crouch, beside its other clips (the art path of its clips' file). */
export function railClips(clips: string): string {
  return clips.replace(/\.clips\.glb$/, '.rail.glb');
}

/** The starboard deck's edge on the rail a boat's model marks (its `rail` node), in the model's frame; null if it has none. */
export function railEdge(parts: Map<string, Object3D>): Vector3 | null {
  const node = parts.get('rail');
  return node === undefined ? null : node.position.clone();
}

/**
 * A clip's place on the rail (from the figure to the deck's edge) into the
 * model's frame, at a point of the starboard deck's edge (edge), on the
 * clip's side: the port side's the edge's mirror.
 */
export function railPlace(place: Matrix4, edge: Vector3, side: number): Matrix4 {
  return new Matrix4().makeTranslation(side * edge.x, edge.y, edge.z).multiply(place);
}
