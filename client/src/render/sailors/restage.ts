// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's clips in a boat other than the one they were placed in.
//
// The sailors' build places every clip in one boat, the stage
// (art/sailors/tables.yaml): each clip's place is a transform from the
// figure's space into that boat's model. Another boat lays out its helm as
// the stage does about its seat (the side deck as wide, the cockpit's floor
// as deep below the gunwale, the tiller's hinge as far from the seat), and
// says in its model's `sailor` node how far its seat is from the stage's:
// `restage`, [x, y, z] on the starboard side. A clip seated on a side deck
// is moved by it there (on the port side deck by its mirror). A clip that
// carries the sailor across the boat (a tack's cross) also has its hips'
// travel across widened, about the centreline, so it starts on one side
// deck and ends on the other of the wider boat.
//
// Boats with a hiking strap hike to the strap's depth (the hiking clips in
// turn, as the physics puts the sailor further out); boats without one only
// sit out on the rail: the first hiking clip, at the physics' furthest
// reach.

import { type AnimationClip, Matrix4, type Object3D, Quaternion, Vector3 } from 'three';
import { Clip, Pose } from './clips';
import type { Rig } from './rig';

/** How the hiking clips are blended by the sailor's offset (m): from where, to where fully, and how many of them. */
export interface Hike {
  from: number;
  full: number;
  depth: number;
}

/** A dinghy with a hiking strap: from 0.55 m out to fully hiked at 0.95 m, through all three hiking clips. */
export const STRAPPED: Hike = { from: 0.55, full: 0.95, depth: 3 };
/** On the rail: the sailor comes out to the rail over this much of its reach. */
const RAIL = 0.2;

/** How a boat's sailor sits: the move from the stage's seat, if any, and how it hikes. */
export interface Seating {
  restage: Vector3 | null;
  hike: Hike;
}

/**
 * How a boat's sailor sits, from its model's nodes by name: its `sailor`
 * node's data (`restage`), and whether it has a hiking `strap`; and the
 * physics' furthest reach out to windward.
 */
export function seating(parts: Map<string, Object3D>, hikeReach: number): Seating {
  return {
    restage: restageOf(parts.get('sailor')?.userData),
    hike: parts.has('strap')
      ? STRAPPED
      : { from: Math.max(0, hikeReach - RAIL), full: hikeReach, depth: 1 },
  };
}

/** A seat's move from the stage's, from its node's data; null if it has none (it is the stage). */
export function restageOf(data: unknown): Vector3 | null {
  const r = (data as { restage?: unknown } | undefined)?.restage;
  if (
    !Array.isArray(r) ||
    r.length !== 3 ||
    r.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  ) {
    return null;
  }
  return new Vector3(r[0] as number, r[1] as number, r[2] as number);
}

/** A place on the starboard side deck (as a far level's), moved to this boat. */
export function restagePlace(place: Matrix4, by: Vector3, side = 1): Matrix4 {
  return new Matrix4().makeTranslation(side * by.x, by.y, by.z).multiply(place);
}

const v = new Vector3();
const d = new Vector3();
const q = new Quaternion();
const q2 = new Quaternion();
const s = new Vector3();
const t = new Vector3();

/**
 * A clip moved to this boat: its place moved by the seats' difference on
 * the side it starts on, and, if it crosses the boat, its hips' travel
 * across widened. A clip with no place (it stands, or is in the water at no
 * place of the boat's) is the same clip.
 */
export function restageClip(clip: Clip, rig: Rig, by: Vector3): Clip {
  const place = clip.place;
  if (place === null) {
    return clip;
  }
  const pelvis = rig.bone('pelvis');
  const pose = new Pose(rig.names.length);
  /** Where the hips are across the boat at a time of the clip, as the stage places it. */
  const across = (time: number): number => {
    pose.rest(rig);
    clip.sample(time, pose);
    pose.to(rig);
    rig.fk();
    return rig.position(pelvis, v).applyMatrix4(place).x;
  };
  const x0 = across(0);
  const x1 = across(clip.duration);
  const side = x0 < 0 ? -1 : 1;
  const moved = restagePlace(place, by, side);
  const k = clip.tracks.findIndex((tr) => tr.bone === pelvis && tr.size === 3);
  const track = clip.tracks[k];
  rig.reset();
  if (track === undefined || x0 * x1 >= 0 || Math.abs(x0) < 1e-3) {
    return new Clip(clip.name, clip.duration, clip.tracks, moved);
  }
  // A cross: the hips at x across the stage's boat are at x times this
  // across this one's, the move along the place's turn and the hips'
  // parent's undone into the hips' own track.
  const widen = (Math.abs(x0) + by.x) / Math.abs(x0);
  place.decompose(t, q2, s);
  const values = Float32Array.from(track.values);
  for (let i = 0; i < track.times.length; i++) {
    const x = across(track.times[i] as number);
    const extra = (widen - 1) * x - side * by.x;
    rig.parentRotation(pelvis, q);
    q.premultiply(q2).invert();
    d.set(extra, 0, 0).applyQuaternion(q);
    values[3 * i] = (values[3 * i] as number) + d.x;
    values[3 * i + 1] = (values[3 * i + 1] as number) + d.y;
    values[3 * i + 2] = (values[3 * i + 2] as number) + d.z;
  }
  rig.reset();
  const tracks = clip.tracks.slice();
  tracks[k] = { ...track, values };
  return new Clip(clip.name, clip.duration, tracks, moved);
}

/**
 * A file's animation moved to this boat as restageClip moves it, for a
 * player of three.js's own (the dressing room's mixer): the same
 * animation with its hips' track as moved, and its place.
 */
export function restageAnimation(
  a: AnimationClip,
  place: Matrix4,
  rig: Rig,
  by: Vector3,
): { animation: AnimationClip; place: Matrix4 } {
  const moved = restageClip(Clip.from(a, rig, place), rig, by);
  const pelvis = rig.bone('pelvis');
  const hips = moved.tracks.find((tr) => tr.bone === pelvis && tr.size === 3);
  const animation = a.clone();
  const track = animation.tracks.find((tr) => tr.name === `${rig.names[pelvis]}.position`);
  if (hips !== undefined && track !== undefined && track.values.length === hips.values.length) {
    track.values = Float32Array.from(hips.values);
  }
  return { animation, place: moved.place ?? place };
}
