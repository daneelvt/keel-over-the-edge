// SPDX-License-Identifier: AGPL-3.0-only

// The sailors' clips, sampled without three.js's AnimationMixer: each clip
// read once into tracks by bone, then sampled at any time into a pose of
// reused arrays, and poses blended by weight. The clips turn every bone and
// move only the hips (the build's): the pelvis's place carries the figure
// across the boat in a tack and over the side climbing in.
//
// Allocation-free once made: the frame loop samples and blends every frame.

import { type AnimationClip, type Matrix4, Vector3 } from 'three';
import type { Rig } from './rig';

/** One bone's keys: its turns (x, y, z, w) or its places (x, y, z). */
interface Track {
  bone: number;
  size: 3 | 4;
  times: Float32Array;
  values: Float32Array;
}

/** A clip, by bone, and where it seats the figure in the boat (the build's place). */
export class Clip {
  readonly tracks: Track[] = [];
  /** The last key found, per track: the next search starts there. */
  readonly #at: Int32Array;

  constructor(
    readonly name: string,
    readonly duration: number,
    tracks: Track[],
    /** From the figure's space to the boat model's; null where it stands (no boat). */
    readonly place: Matrix4 | null,
  ) {
    this.tracks = tracks;
    this.#at = new Int32Array(tracks.length);
  }

  /** The clip read for a skeleton: its turns and the hips' places, by bone. */
  static from(clip: AnimationClip, rig: Rig, place: Matrix4 | null): Clip {
    const tracks: Track[] = [];
    for (const t of clip.tracks) {
      const dot = t.name.lastIndexOf('.');
      const bone = rig.bone(t.name.slice(0, dot));
      const what = t.name.slice(dot + 1);
      if (bone < 0 || (what !== 'quaternion' && what !== 'position')) {
        continue;
      }
      tracks.push({
        bone,
        size: what === 'quaternion' ? 4 : 3,
        times: Float32Array.from(t.times),
        values: Float32Array.from(t.values),
      });
    }
    return new Clip(clip.name, clip.duration, tracks, place);
  }

  /** The key at or before t on a track, searched from the last one found. */
  #key(k: number, t: number): number {
    const times = (this.tracks[k] as Track).times;
    let i = Math.min(this.#at[k] ?? 0, times.length - 1);
    while (i > 0 && (times[i] as number) > t) {
      i--;
    }
    while (i < times.length - 2 && (times[i + 1] as number) <= t) {
      i++;
    }
    this.#at[k] = i;
    return i;
  }

  /**
   * The pose at t seconds (held at the ends) into out: every tracked bone's
   * turn and place; the rest left as they are.
   */
  sample(t: number, out: Pose): void {
    for (let k = 0; k < this.tracks.length; k++) {
      const tr = this.tracks[k] as Track;
      const n = tr.times.length;
      const dst = tr.size === 4 ? out.quat : out.pos;
      const o = tr.size * tr.bone;
      if (n === 1 || t <= (tr.times[0] as number)) {
        copy(dst, o, tr.values, 0, tr.size);
        continue;
      }
      if (t >= (tr.times[n - 1] as number)) {
        copy(dst, o, tr.values, (n - 1) * tr.size, tr.size);
        continue;
      }
      const i = this.#key(k, t);
      const t0 = tr.times[i] as number;
      const t1 = tr.times[i + 1] as number;
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      if (tr.size === 4) {
        nlerp(dst, o, tr.values, i * 4, tr.values, (i + 1) * 4, f);
      } else {
        for (let c = 0; c < 3; c++) {
          const a = tr.values[i * 3 + c] as number;
          dst[o + c] = a + ((tr.values[(i + 1) * 3 + c] as number) - a) * f;
        }
      }
    }
  }
}

/** A skeleton's pose: each bone's turn and place against its parent. */
export class Pose {
  readonly quat: Float32Array;
  readonly pos: Float32Array;

  constructor(readonly bones: number) {
    this.quat = new Float32Array(4 * bones);
    this.pos = new Float32Array(3 * bones);
  }

  /** The skeleton's rest. */
  rest(rig: Rig): this {
    this.quat.set(rig.restQuat);
    this.pos.set(rig.restPos);
    return this;
  }

  copy(p: Pose): this {
    this.quat.set(p.quat);
    this.pos.set(p.pos);
    return this;
  }

  /** Clears to nothing, to add weighted poses into. */
  clear(): this {
    this.quat.fill(0);
    this.pos.fill(0);
    return this;
  }

  /**
   * Adds a pose by a weight: the places weighted, the turns weighted on the
   * side of the sphere of what is already here (normalize() after).
   */
  add(p: Pose, w: number): this {
    if (w <= 0) {
      return this;
    }
    const { quat, pos } = this;
    for (let i = 0; i < this.bones; i++) {
      const o = 4 * i;
      const d =
        (quat[o] as number) * (p.quat[o] as number) +
        (quat[o + 1] as number) * (p.quat[o + 1] as number) +
        (quat[o + 2] as number) * (p.quat[o + 2] as number) +
        (quat[o + 3] as number) * (p.quat[o + 3] as number);
      const s = d < 0 ? -w : w;
      for (let c = 0; c < 4; c++) {
        quat[o + c] = (quat[o + c] as number) + (p.quat[o + c] as number) * s;
      }
    }
    for (let c = 0; c < pos.length; c++) {
      pos[c] = (pos[c] as number) + (p.pos[c] as number) * w;
    }
    return this;
  }

  /** The turns made whole again, and the places divided by the weight added. */
  normalize(total: number): this {
    const { quat, pos } = this;
    for (let i = 0; i < this.bones; i++) {
      const o = 4 * i;
      const l = Math.hypot(
        quat[o] as number,
        quat[o + 1] as number,
        quat[o + 2] as number,
        quat[o + 3] as number,
      );
      if (l > 1e-9) {
        for (let c = 0; c < 4; c++) {
          quat[o + c] = (quat[o + c] as number) / l;
        }
      } else {
        quat[o + 3] = 1;
      }
    }
    if (total > 0) {
      for (let c = 0; c < pos.length; c++) {
        pos[c] = (pos[c] as number) / total;
      }
    }
    return this;
  }

  /** Blends toward another pose by f (0 this, 1 the other), in place. */
  mix(p: Pose, f: number): this {
    if (f <= 0) {
      return this;
    }
    if (f >= 1) {
      return this.copy(p);
    }
    for (let i = 0; i < this.bones; i++) {
      nlerp(this.quat, 4 * i, this.quat, 4 * i, p.quat, 4 * i, f);
    }
    for (let c = 0; c < this.pos.length; c++) {
      const a = this.pos[c] as number;
      this.pos[c] = a + ((p.pos[c] as number) - a) * f;
    }
    return this;
  }

  /** Writes the pose to a skeleton. */
  to(rig: Rig): void {
    rig.quat.set(this.quat);
    rig.pos.set(this.pos);
  }
}

function copy(dst: Float32Array, o: number, src: Float32Array, s: number, n: number): void {
  for (let c = 0; c < n; c++) {
    dst[o + c] = src[s + c] as number;
  }
}

/** Normalised linear blend of two quaternions, the short way, into dst at o. */
function nlerp(
  dst: Float32Array,
  o: number,
  a: Float32Array,
  ia: number,
  b: Float32Array,
  ib: number,
  f: number,
): void {
  const ax = a[ia] as number;
  const ay = a[ia + 1] as number;
  const az = a[ia + 2] as number;
  const aw = a[ia + 3] as number;
  let bx = b[ib] as number;
  let by = b[ib + 1] as number;
  let bz = b[ib + 2] as number;
  let bw = b[ib + 3] as number;
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = ax + (bx - ax) * f;
  const y = ay + (by - ay) * f;
  const z = az + (bz - az) * f;
  const w = aw + (bw - aw) * f;
  const l = Math.hypot(x, y, z, w) || 1;
  dst[o] = x / l;
  dst[o + 1] = y / l;
  dst[o + 2] = z / l;
  dst[o + 3] = w / l;
}

/** Each walk's time with both feet down and nearest side by side, its steps begun and ended there. */
const together = new WeakMap<Clip, number>();

/** How near its lowest the higher foot must be for both to be down, m. */
const FEET_DOWN = 0.02;

/** The time in a walk where both its feet are down, nearest side by side fore and aft: found once. */
export function feetTogether(clip: Clip, rig: Rig): number {
  let t0 = together.get(clip);
  if (t0 === undefined) {
    const pose = new Pose(rig.names.length);
    const v = new Vector3();
    const w = new Vector3();
    const l = rig.bone('foot_l');
    const r = rig.bone('foot_r');
    // Each moment's feet: how far apart fore and aft, and how high the higher is.
    const apart: number[] = [];
    const high: number[] = [];
    for (let k = 0; k < 120; k++) {
      const t = (clip.duration * k) / 120;
      pose.rest(rig);
      clip.sample(t, pose);
      pose.to(rig);
      rig.fk();
      rig.position(l, v);
      rig.position(r, w);
      apart.push(Math.abs(v.z - w.z));
      high.push(Math.max(v.y, w.y));
    }
    // Both feet down (the higher within FEET_DOWN of its lowest), nearest side by side.
    const low = Math.min(...high);
    let best = Number.POSITIVE_INFINITY;
    t0 = 0;
    for (let k = 0; k < 120; k++) {
      if ((high[k] as number) <= low + FEET_DOWN && (apart[k] as number) < best) {
        best = apart[k] as number;
        t0 = (clip.duration * k) / 120;
      }
    }
    rig.reset();
    together.set(clip, t0);
  }
  return t0;
}
