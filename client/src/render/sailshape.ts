// SPDX-License-Identifier: AGPL-3.0-only

// The sail's shape on the GPU, shared by the sail and the telltales sewn to
// it. The model holds the sail flat in the centreline plane, each vertex
// with its fraction of the chord (u) and of the luff (v). At height v the
// chord turns about the mast by the boom's angle plus the twist times v, and
// stands off its straight line by the camber, 4·depth·u(1 − u) of the chord,
// to the side the boom is out on. A luffing sail ripples: a wave runs aft
// along the chord, its size set for each sail strip by how far the strip is
// below its luffing angle.
//
// A reefed main is drawn short. Where the model has a row of vertices at
// each reef's height (a slab reef), the cloth above the reef's row comes
// down to the boom, keeping its shape, and the cloth below it is gathered
// along the boom in a fold; elsewhere (a smaller rig) the whole sail is
// drawn smaller, its luff and chord alike. At full sail it is the sail as
// it was, to the bit.
//
// The headsail (jibPoint) is shaped the same way about its stay: each
// height's chord turned about its luff point on the raked stay by the
// clew's angle plus its twist up the luff, with camber and ripple, and
// never reefed.
//
// The downwind sail (kitePoint) is a headsail about its tack, set flying:
// far fuller, its luff sagging to the side it fills to, the chord drawn in
// toward the luff while its clew is inside its sheeted-in angle (a gybe
// taking it across, ahead of the forestay), and the whole sail drawn at
// its hoist's share of its size about the tack, from nothing in its bag
// to full set.

import type { Object3D } from 'three';
import { cos, float, max, mix, normalize, select, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';

/** The sail's distance aft of the mast's centre, as the model has it, in metres. */
export const LUFF_OFFSET = 0.04;
/** The ripple's greatest depth, in metres. */
const RIPPLE_DEPTH = 0.07;
/** A slab reef's gathered cloth stands this high on the boom at the old foot, and bulges this far to the side, metres. */
const BUNDLE_HEIGHT = 0.07;
const BUNDLE_BULGE = 0.05;

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
  /** World time, seconds, modulo 2π: every frequency it drives is whole radians a second. */
  time: UniformNode<'float', number>;
  /** The share of its luff the sail keeps as reefed: 1 at full sail. */
  reefShare: UniformNode<'float', number>;
  /**
   * 1 where a reef gathers the cloth below its row along the boom (the
   * model has a row at each reef's height); 0 where a reefed sail is
   * drawn smaller.
   */
  reefGather: UniformNode<'float', number>;
  /** The sail's luff, metres. */
  luff: UniformNode<'float', number>;
}

/** The sail's shape's inputs as nodes: the own boat's uniforms, or another boat's per-instance values. */
export type SailInputs = { [K in keyof SailUniforms]: Node<'float'> };

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
    reefShare: uniform(1),
    reefGather: uniform(0),
    luff: uniform(5),
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
  t: SailInputs,
  along: Node<'float'>,
  fu: Node<'float'>,
  fv: Node<'float'>,
  y: Node<'float'>,
): SailPoint {
  // The reef: the fraction of the luff below a slab reef's row, and how
  // much a smaller rig is shortened.
  const cut = float(1).sub(t.reefShare).mul(t.reefGather);
  const scale = mix(t.reefShare, float(1), t.reefGather);
  const gathered = fv.lessThan(cut);
  const inBundle = fv.div(max(cut, 1e-4));
  // The height up the reefed sail's luff, as a fraction of it, that sets
  // the twist and the ripple; in the gathered cloth none.
  const up = fv.sub(cut).div(max(float(1).sub(cut), 1e-4));
  const live = select(gathered, float(0), float(1));
  const height = select(
    gathered,
    float(1).sub(inBundle).mul(BUNDLE_HEIGHT),
    y.sub(cut.mul(t.luff)),
  ).mul(scale);
  const chord = along.mul(scale);
  const theta = t.boom.add(t.twist.mul(up).mul(live));
  const c = cos(theta);
  const s = sin(theta);
  const slope = t.camber
    .mul(4)
    .mul(float(1).sub(fu.mul(2)))
    .mul(t.side)
    .mul(live);
  // u(1 − u)·chord is along·(1 − u).
  const camber = t.camber.mul(4).mul(chord).mul(float(1).sub(fu)).mul(t.side).mul(live);
  const ripple = mix(t.rippleFoot, t.rippleHead, smoothstep(t.footV, t.headV, up))
    .mul(RIPPLE_DEPTH)
    .mul(fu)
    .mul(sin(fu.mul(16).sub(t.time.mul(19)).add(up.mul(5))))
    .mul(live);
  const bundle = sin(inBundle.mul(Math.PI)).mul(BUNDLE_BULGE).mul(float(1).sub(live));
  const d = camber.add(ripple).add(bundle);
  const z = chord.add(LUFF_OFFSET);
  const p = turn(d, z, c, s);
  const n = normalize(vec3(1, 0, slope.negate()));
  const a = normalize(vec3(slope, 0, 1));
  return {
    position: vec3(p.x, height, p.z),
    normal: turn(n.x, n.z, c, s),
    tangent: turn(a.x, a.z, c, s),
  };
}

/** The headsail's shape's inputs: as the main's, but for the reef, which a headsail is not. */
export type JibInputs = Omit<SailInputs, 'reefShare' | 'reefGather' | 'luff'>;

/**
 * The point of the shaped headsail at height y, fraction fu of its chord
 * and fv of its luff, its point on the stay rake·fv aft of the tack and
 * along aft of that; in the headsail node's frame (at the tack).
 */
export function jibPoint(
  t: JibInputs,
  along: Node<'float'>,
  fu: Node<'float'>,
  fv: Node<'float'>,
  y: Node<'float'>,
  rake: Node<'float'>,
): SailPoint {
  const p = sailPoint(
    { ...t, reefShare: float(1), reefGather: float(0), luff: float(1) },
    along.sub(LUFF_OFFSET),
    fu,
    fv,
    y,
  );
  return { ...p, position: p.position.add(vec3(0, 0, rake.mul(fv))) };
}

/** A downwind sail's luff's sag to the side it fills to, at half its height, metres at full size. */
export const KITE_LUFF_SAG = 0.3;

/**
 * The downwind sail's shape's inputs: a headsail's, and how far it is
 * hoisted (0 in its bag, 1 set) and the share of its chord drawn out (1
 * but while its clew is taken across).
 */
export type KiteInputs = JibInputs & { hoist: Node<'float'>; reach: Node<'float'> };

/** The downwind sail's camber, as a fraction of its chord: far fuller than a headsail's. */
export const KITE_CAMBER = 0.17;
/** The share of its chord a downwind sail is drawn with, its clew on the centreline. */
export const KITE_REACH_IN = 0.3;
/** How hard a downwind sail ripples as it goes up, half hoisted, 0 to 1: it fills as it is set. */
export const KITE_FLOG = 0.8;

/** A kind's downwind sail's numbers as its shape reads them: its sheeted-in angle and its twist, the main's twist's turn, its strips' heights. */
export interface KiteRig {
  /** Its clew's angle sheeted in, radians. */
  kiteIn: number;
  /** The twist's turn over as its clew crosses the centreline, radians (the main's). */
  twistTurn: number;
  footV: number;
  headV: number;
}

/** A kind's downwind sail's numbers, from its catalog physics; null for a kind without one. */
export function kiteRig(physics: {
  downwind: {
    downwindArea: number;
    downwindIn: number;
    downwindFootStrip: number;
    downwindHeadStrip: number;
  };
  rig: { twistTurn: number };
}): KiteRig | null {
  const d = physics.downwind;
  if (!(d.downwindArea > 0)) {
    return null;
  }
  return {
    kiteIn: (d.downwindIn * Math.PI) / 180,
    twistTurn: (physics.rig.twistTurn * Math.PI) / 180,
    footV: d.downwindFootStrip,
    headV: d.downwindHeadStrip,
  };
}

/** Whether a downwind sail is drawn at a hoist: from the first of it out of its bag. */
export function kiteShown(hoist: number): boolean {
  return hoist > 1e-3;
}

/**
 * How hard the downwind sail ripples: as its strips' flow says (want, 0 to
 * 1), or as it flogs going up or coming down, hardest out of its bag and
 * none once set.
 */
export function kiteRipple(want: number, hoist: number): number {
  const h = Math.max(0, Math.min(1, hoist));
  return Math.max(want, h < 1 ? KITE_FLOG * (1 - h) : 0);
}

/**
 * The downwind sail's shape's inputs as nodes, for the own boat's
 * uniforms or another boat's instance values: its clew's angle, its
 * signed twist, its strips' ripples and its hoist; the side it fills to and the
 * share of its chord drawn worked out from the clew's angle.
 */
export function kiteInputs(
  clew: Node<'float'>,
  twist: Node<'float'>,
  rippleFoot: Node<'float'>,
  rippleHead: Node<'float'>,
  hoist: Node<'float'>,
  rig: KiteRig,
  time: Node<'float'>,
): KiteInputs {
  const side = clew.div(rig.twistTurn > 0 ? rig.twistTurn : 1).clamp(-1, 1);
  const reach = float(KITE_REACH_IN).add(
    smoothstep(float(0), float(rig.kiteIn > 0 ? rig.kiteIn : 1), clew.abs()).mul(1 - KITE_REACH_IN),
  );
  return {
    boom: clew,
    twist,
    camber: float(KITE_CAMBER),
    side: side as unknown as Node<'float'>,
    rippleFoot,
    rippleHead,
    footV: float(rig.footV),
    headV: float(rig.headV),
    time,
    hoist,
    reach: reach as unknown as Node<'float'>,
  };
}

/** The share of its chord a downwind sail is drawn with at its clew's angle (radians): kiteInputs' reach, on the CPU. */
export function kiteReach(clew: number, kiteIn: number): number {
  const x = Math.max(0, Math.min(1, Math.abs(clew) / (kiteIn > 0 ? kiteIn : 1)));
  return KITE_REACH_IN + (1 - KITE_REACH_IN) * x * x * (3 - 2 * x);
}

/**
 * The point of the shaped downwind sail, as jibPoint's, its chord drawn to
 * its reach, its luff sagging to the side it fills to, and the whole drawn
 * at its hoist's share about the tack: nothing at a hoist of 0.
 */
export function kitePoint(
  t: KiteInputs,
  along: Node<'float'>,
  fu: Node<'float'>,
  fv: Node<'float'>,
  y: Node<'float'>,
  rake: Node<'float'>,
): SailPoint {
  const p = jibPoint(t, along.mul(t.reach), fu, fv, y, rake);
  const sag = sin(fv.mul(Math.PI)).mul(KITE_LUFF_SAG).mul(t.side);
  return { ...p, position: p.position.add(vec3(sag, 0, 0)).mul(t.hoist) };
}

/**
 * The frame a headsail is shaped in: the nearest node at or above it with
 * a rake in its extras (its tack, its head that far aft), or else the
 * headsails' node 'jib', its rake or none.
 */
export function headsailFrame(o: Object3D): { node: Object3D; rake: number } {
  let jib: Object3D | null = null;
  for (let p: Object3D | null = o; p !== null; p = p.parent) {
    const rake = (p.userData as { rake?: unknown }).rake;
    if (typeof rake === 'number' && Number.isFinite(rake)) {
      return { node: p, rake };
    }
    if (p.name === 'jib' && jib === null) {
      jib = p;
    }
  }
  return { node: jib ?? o, rake: 0 };
}
