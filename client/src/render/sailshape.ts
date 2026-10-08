// SPDX-License-Identifier: AGPL-3.0-only

// The sail's shape on the GPU, shared by the sail and the telltales sewn to
// it. The model holds the sail flat in the centreline plane, each vertex
// with its fraction of the chord (u) and of the luff (v). At height v the
// chord turns about the mast by the boom's angle plus the twist times v, and
// stands off its straight line by the camber, 4·depth·u(1 − u) of the chord,
// to the side the boom is out on. A luffing sail ripples: a wave runs aft
// along the chord, its size set for each sail strip by how far the strip is
// below its luffing angle.

import { cos, float, mix, normalize, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';

/** The sail's distance aft of the mast's centre, as the model has it, in metres. */
export const LUFF_OFFSET = 0.04;
/** The ripple's greatest depth, in metres. */
const RIPPLE_DEPTH = 0.07;

export interface SailUniforms {
  /** The boom's angle, radians, positive to starboard. */
  boom: UniformNode<'float', number>;
  /** The head's twist beyond the boom, radians, signed to the side the boom is on. */
  twist: UniformNode<'float', number>;
  /** The camber's depth, as a fraction of the chord. */
  camber: UniformNode<'float', number>;
  /** −1 to 1: the side the sail fills to, turning over as the boom crosses the centreline. */
  side: UniformNode<'float', number>;
  /** How much each strip ripples, 0 to 1. */
  rippleFoot: UniformNode<'float', number>;
  rippleHead: UniformNode<'float', number>;
  /** The strips' heights, as fractions of the luff. */
  footV: UniformNode<'float', number>;
  headV: UniformNode<'float', number>;
  /** World time, seconds. */
  time: UniformNode<'float', number>;
}

export function sailUniforms(): SailUniforms {
  return {
    boom: uniform(0),
    twist: uniform(0),
    camber: uniform(0.09),
    side: uniform(0),
    rippleFoot: uniform(0),
    rippleHead: uniform(0),
    footV: uniform(0.15),
    headV: uniform(0.58),
    time: uniform(0),
  };
}

export interface SailPoint {
  position: Node<'vec3'>;
  /** The starboard face's normal (the face that looks to +x at rest). */
  normal: Node<'vec3'>;
  /** The chord's direction aft, at the point. */
  tangent: Node<'vec3'>;
}

/** Turns (x, z) about y by the angle with this cosine and sine, as the sail's chord turns. */
function turn(
  x: Node<'float'>,
  z: Node<'float'>,
  c: Node<'float'>,
  s: Node<'float'>,
): Node<'vec3'> {
  return vec3(x.mul(c).add(z.mul(s)), 0, z.mul(c).sub(x.mul(s)));
}

/**
 * The point of the shaped sail at distance along aft of the luff, fraction
 * fu of the chord and fv of the luff, height y; in the sail node's frame.
 * Builds nodes for use inside a vertex function.
 */
export function sailPoint(
  t: SailUniforms,
  along: Node<'float'>,
  fu: Node<'float'>,
  fv: Node<'float'>,
  y: Node<'float'>,
): SailPoint {
  const theta = t.boom.add(t.twist.mul(fv));
  const c = cos(theta);
  const s = sin(theta);
  const slope = t.camber
    .mul(4)
    .mul(float(1).sub(fu.mul(2)))
    .mul(t.side);
  // u(1 − u)·chord is along·(1 − u).
  const camber = t.camber.mul(4).mul(along).mul(float(1).sub(fu)).mul(t.side);
  const ripple = mix(t.rippleFoot, t.rippleHead, smoothstep(t.footV, t.headV, fv))
    .mul(RIPPLE_DEPTH)
    .mul(fu)
    .mul(sin(fu.mul(16).sub(t.time.mul(19)).add(fv.mul(5))));
  const d = camber.add(ripple);
  const z = along.add(LUFF_OFFSET);
  const p = turn(d, z, c, s);
  const n = normalize(vec3(1, 0, slope.negate()));
  const a = normalize(vec3(slope, 0, 1));
  return {
    position: vec3(p.x, y, p.z),
    normal: turn(n.x, n.z, c, s),
    tangent: turn(a.x, a.z, c, s),
  };
}
