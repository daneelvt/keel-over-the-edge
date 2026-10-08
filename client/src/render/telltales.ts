// SPDX-License-Identifier: AGPL-3.0-only

// The telltales: a pair of wool ribbons at the height of each sail strip's
// centre of effort, one on each face, set from that strip's flow as sailing
// guides teach them read:
//
//   attached  both stream aft;
//   luffing   the windward one lifts and flutters (sheet in or bear away);
//   stalled   the leeward one droops and curls (ease or head up);
//   aback     both stream forward.
//
// Each ribbon's pose is four numbers: how far it reaches aft along the
// cloth (negative: forward), how far it lifts off its face, how far it
// droops, and how hard it flutters. The poses ease between states over a few
// frames; the vertex node bends each ribbon by them.

import { Vector4 } from 'three';
import { Fn, float, normalLocal, positionGeometry, sin, uniform, uv, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { RECORDS } from '../predict/layout.gen';
import { LUFF_OFFSET, type SailUniforms, sailPoint } from './sailshape';

/** The flows of Out.FootFlow and Out.HeadFlow (internal/physics/records.go). */
export const FLOW_LUFFING = 0;
export const FLOW_ATTACHED = 1;
export const FLOW_STALLED = 2;
export const FLOW_ABACK = 3;

/** The model's ribbons: their length and how far they stand off the cloth, in metres. */
const LENGTH = 0.17;
const OFFSET = 0.004;
/** Seconds over which a ribbon eases into a new pose. */
const EASE = 0.15;

type Pose = readonly [aft: number, lift: number, droop: number, flutter: number];

const STREAMING: Pose = [1, 0.04, 0.05, 0.12];
const LIFTED: Pose = [0.45, 0.8, -0.1, 1];
const DROOPED: Pose = [0.3, 0.35, 0.85, 0.25];
const FORWARD: Pose = [-0.9, 0.2, 0.1, 0.45];

/** The pose of a ribbon on the windward or leeward face of a strip with this flow. */
export function ribbonPose(flow: number, windward: boolean): Pose {
  switch (flow) {
    case FLOW_LUFFING:
      return windward ? LIFTED : STREAMING;
    case FLOW_STALLED:
      return windward ? STREAMING : DROOPED;
    case FLOW_ABACK:
      return FORWARD;
    default:
      return STREAMING;
  }
}

/** Ribbon i's place: the strip (0 the foot, 1 the head) times two, plus one on the starboard face. */
export function ribbonIndex(strip: number, starboard: boolean): number {
  return strip * 2 + (starboard ? 1 : 0);
}

/**
 * Writes each ribbon's target pose into out (four numbers a ribbon, by
 * ribbonIndex) from Out's flows. boomSide is the side the boom is out on,
 * +1 to starboard: the sail's leeward side, so the windward face is the
 * other.
 */
export function telltalePoses(
  foot: number,
  head: number,
  boomSide: number,
  out: Float32Array,
): void {
  for (let strip = 0; strip < 2; strip++) {
    const flow = strip === 0 ? foot : head;
    for (let side = 0; side < 2; side++) {
      const starboard = side === 1;
      const windward = boomSide >= 0 ? !starboard : starboard;
      const p = ribbonPose(flow, windward);
      out.set(p, ribbonIndex(strip, starboard) * 4);
    }
  }
}

export class Telltales {
  readonly poses = [0, 1, 2, 3].map(() => uniform(new Vector4(...STREAMING)));
  readonly #target = new Float32Array(16);
  readonly #current = new Float32Array(16);

  constructor() {
    telltalePoses(FLOW_ATTACHED, FLOW_ATTACHED, 1, this.#current);
  }

  /** Eases the ribbons toward the poses for Out over dt seconds. */
  update(out: Float64Array, boom: number, dt: number): void {
    telltalePoses(
      out[RECORDS.out.footFlow] ?? FLOW_ATTACHED,
      out[RECORDS.out.headFlow] ?? FLOW_ATTACHED,
      boom >= 0 ? 1 : -1,
      this.#target,
    );
    const f = dt > 0 ? 1 - Math.exp(-dt / EASE) : 0;
    for (let i = 0; i < 16; i++) {
      const c = this.#current[i] ?? 0;
      this.#current[i] = c + ((this.#target[i] ?? 0) - c) * f;
    }
    for (let r = 0; r < 4; r++) {
      const c = this.#current;
      this.poses[r]?.value.set(
        c[r * 4] ?? 0,
        c[r * 4 + 1] ?? 0,
        c[r * 4 + 2] ?? 0,
        c[r * 4 + 3] ?? 0,
      );
    }
  }

  /** The pose drawn for ribbon i, for tests. */
  pose(i: number): number[] {
    return Array.from(this.#current.subarray(i * 4, i * 4 + 4));
  }

  /**
   * The ribbons' vertex node. Each vertex finds its ribbon's root on the
   * shaped sail, then lies along the cloth by the pose: aft along the chord,
   * off its face, down, and fluttering, more toward the free end.
   */
  node(sail: SailUniforms): Node<'vec3'> {
    const [p0, p1, p2, p3] = this.poses as [
      (typeof this.poses)[0],
      (typeof this.poses)[0],
      (typeof this.poses)[0],
      (typeof this.poses)[0],
    ];
    return Fn(() => {
      const f = uv().x;
      const index = uv().y;
      const fu = uv(1).x;
      const fv = uv(1).y;
      const face = positionGeometry.x.sign();
      const along = positionGeometry.z.sub(LUFF_OFFSET).sub(f.mul(LENGTH));
      const at = sailPoint(sail, along, fu, fv, positionGeometry.y);
      const pose = index
        .lessThan(0.5)
        .select(p0, index.lessThan(1.5).select(p1, index.lessThan(2.5).select(p2, p3)));
      const outward = at.normal.mul(face);
      const bend = f.mul(f);
      const flutter = sin(f.mul(9).sub(sail.time.mul(26)).add(index.mul(1.7)))
        .mul(pose.w)
        .mul(0.3)
        .mul(f);
      const ribbon = at.tangent
        .mul(pose.x.mul(f))
        .add(outward.mul(pose.y.mul(bend).add(flutter)))
        .add(vec3(0, -1, 0).mul(pose.z.mul(bend)));
      normalLocal.assign(outward);
      return at.position.add(outward.mul(OFFSET)).add(ribbon.mul(float(LENGTH)));
    })() as unknown as Node<'vec3'>;
  }
}
