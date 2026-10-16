// SPDX-License-Identifier: AGPL-3.0-only

// The mist band at the edge of the world. Over the clear air's haze lies a
// mist whose density rises linearly across the band, from nothing at its
// inner edge to the lip's, and thins with height above the sea as
// e^(−z / H); beyond the lip it is the lip's at every distance, and below
// the sea it does not thin. A colour seen through it keeps exp(−τ) of its
// contrast, τ the integral of the density along the ray from the eye
// (Beer–Lambert; with a uniform density, Koschmieder's exp(−3.912 d / V)).
// So near water is misty and far land clear of the band's mist yet seen
// through it, as a fragment's own distance from the centre could not tell.
//
// Along a straight ray the integral has a closed form, taken over each half
// of the ray: the band's share is linear in the distance from the centre at
// the half's ends, clamped to 0 and 1 (the halves' ends, the ray's middle
// among them, give the distance's curve along a ray across the band), and
// the height is linear between the ends' heights above the curved sea,
// clamped at the sea; a half splits where either clamp
// starts, and each piece is a linear function times an exponential, whose
// integral is closed (exponential height fog: Quílez, "Fog"), with a
// Taylor series where the ray is nearly level and the closed form divides
// by nearly nothing (as Flax Engine's ExponentialHeightFog does). The
// shaders and the page compute it the same way: mistDepth here, and its
// node below.

import { Color, Vector2 } from 'three';
import { abs, clamp, exp, Fn, float, If, length, max, min, select, uniform, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { DOME_RADIUS, domeCentre } from '../render/materials';

/** Koschmieder's constant: ln(1/0.02), the contrast threshold of 2%. */
export const KOSCHMIEDER = 3.912;

/** What the mist is drawn with: its uniforms, which the scene sets each frame. */
export const edgeLook = {
  /** The scene's origin in the world: metres east and north of the disk's centre. */
  origin: uniform(new Vector2()),
  /** The band's inner edge and the lip, metres from the centre. */
  band: uniform(7778.4),
  lip: uniform(8334),
  /** The mist's own extinction at the lip at the sea, per metre, over the clear air's. */
  sigma: uniform(KOSCHMIEDER / 300 - KOSCHMIEDER / 6000),
  /** Its scale height, metres. */
  height: uniform(40),
  /** Its colour, a display value, by the hour. */
  colour: uniform(new Color(0.8, 0.83, 0.85)),
  /** 1 to draw the edge's mist, 0 for none (?edge=off). */
  on: uniform(1),
};

/** The mist's numbers: the band, its density at the lip and its scale height. */
export interface MistParams {
  band: number;
  lip: number;
  /** Extinction per metre at the lip at the sea, over the clear air's. */
  sigma: number;
  height: number;
}

/**
 * A ray's two ends and its middle: each one's distance from the centre,
 * metres, and height above the sea, metres; and its length.
 */
export interface MistRay {
  r0: number;
  z0: number;
  rm: number;
  zm: number;
  r1: number;
  z1: number;
  length: number;
}

/** Below this |k w| a piece's exponential is a Taylor series. */
const LEVEL = 0.02;

/**
 * ∫₀ʷ clamp(a + b u) e^(−max(z + c u, 0) / H) du over a piece in which the
 * clamp and the sea do not change, judged at the piece's middle.
 */
function piece(
  t0: number,
  t1: number,
  a0: number,
  da: number,
  z0: number,
  dz: number,
  invH: number,
): number {
  const w = t1 - t0;
  if (!(w > 0)) {
    return 0;
  }
  const tm = 0.5 * (t0 + t1);
  const am = a0 + da * tm;
  if (am <= 0) {
    return 0;
  }
  const alpha = am >= 1 ? 1 : a0 + da * t0;
  const beta = am >= 1 ? 0 : da;
  if (z0 + dz * tm <= 0) {
    return alpha * w + 0.5 * beta * w * w;
  }
  const e0 = Math.exp(-Math.max(z0 + dz * t0, 0) * invH);
  const k = dz * invH;
  if (Math.abs(k * w) < LEVEL) {
    const w2 = w * w;
    return (
      e0 *
      (alpha * w +
        ((beta - alpha * k) * w2) / 2 +
        (((alpha * k * k) / 2 - beta * k) * w2 * w) / 3 +
        (beta * k * k * w2 * w2) / 8)
    );
  }
  const g0 = alpha / k + beta / (k * k);
  const g1 = Math.exp(-k * w) * ((alpha + beta * w) / k + beta / (k * k));
  return e0 * (g0 - g1);
}

/** Where a linear value v0 + dv t reaches target, or 2 (beyond the ray) if it never does. */
function cross(v0: number, dv: number, target: number): number {
  return Math.abs(dv) > 1e-12 ? Math.min(Math.max((target - v0) / dv, 0), 1) : 2;
}

/**
 * The mist's optical depth along a ray: the integral of its density from
 * one end to the other, the clear air's left out.
 */
export function mistDepth(ray: MistRay, p: MistParams): number {
  const half = ray.length / 2;
  return (
    mistDepthLinear(ray.r0, ray.z0, ray.rm, ray.zm, half, p) +
    mistDepthLinear(ray.rm, ray.zm, ray.r1, ray.z1, half, p)
  );
}

/** The optical depth along a piece of ray whose distance from the centre and height are linear along it. */
function mistDepthLinear(
  r0: number,
  z0: number,
  r1: number,
  z1: number,
  len: number,
  p: MistParams,
): number {
  const span = p.lip - p.band;
  const a0 = (r0 - p.band) / span;
  const da = (r1 - p.band) / span - a0;
  if (a0 <= 0 && a0 + da <= 0) {
    return 0;
  }
  const dz = z1 - z0;
  const invH = 1 / p.height;
  const x = cross(a0, da, 0);
  const y = cross(a0, da, 1);
  const z = cross(z0, dz, 0);
  const s1 = Math.min(x, y, z, 1);
  const s3 = Math.min(Math.max(x, y, z), 1);
  const s2 = Math.min(Math.max(Math.min(x, y), Math.min(Math.max(x, y), z)), 1);
  const sum =
    piece(0, s1, a0, da, z0, dz, invH) +
    piece(s1, s2, a0, da, z0, dz, invH) +
    piece(s2, s3, a0, da, z0, dz, invH) +
    piece(s3, 1, a0, da, z0, dz, invH);
  return p.sigma * len * sum;
}

/** The density at a point, per metre: the reference the closed form is held to. */
export function mistDensity(r: number, z: number, p: MistParams): number {
  const m = Math.min(Math.max((r - p.band) / (p.lip - p.band), 0), 1);
  return p.sigma * m * Math.exp(-Math.max(z, 0) / p.height);
}

/** The visual range at a point at the sea, metres, in air of clear visual range clear. */
export function visualRangeAt(r: number, clear: number, p: MistParams): number {
  return KOSCHMIEDER / (KOSCHMIEDER / clear + mistDensity(r, 0, p));
}

// The node: the same pieces, op for op.

const pieceNode = /* @__PURE__ */ Fn(
  ([t0, t1, a0, da, z0, dz, invH]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const w = max(t1.sub(t0), 0);
    const tm = t0.add(t1).mul(0.5);
    const am = a0.add(da.mul(tm));
    const full = am.greaterThanEqual(1);
    const alpha = select(full, float(1), a0.add(da.mul(t0)));
    const beta = select(full, float(0), da);
    const flat = alpha.mul(w).add(beta.mul(w).mul(w).mul(0.5));
    const e0 = exp(
      max(z0.add(dz.mul(t0)), 0)
        .mul(invH)
        .negate(),
    );
    const k = dz.mul(invH);
    const kw = k.mul(w);
    const w2 = w.mul(w);
    const taylor = alpha
      .mul(w)
      .add(beta.sub(alpha.mul(k)).mul(w2).mul(0.5))
      .add(alpha.mul(k).mul(k).mul(0.5).sub(beta.mul(k)).mul(w2).mul(w).div(3))
      .add(beta.mul(k).mul(k).mul(w2).mul(w2).mul(0.125));
    // Away from level, k is far from 0 and the divisions are safe.
    const ks = select(abs(kw).lessThan(LEVEL), float(1), k);
    const g0 = alpha.div(ks).add(beta.div(ks.mul(ks)));
    const g1 = exp(ks.mul(w).negate()).mul(
      alpha
        .add(beta.mul(w))
        .div(ks)
        .add(beta.div(ks.mul(ks))),
    );
    const sloped = select(abs(kw).lessThan(LEVEL), taylor, g0.sub(g1));
    const above = z0.add(dz.mul(tm)).greaterThan(0);
    const value = select(above, e0.mul(sloped), flat);
    return select(am.lessThanEqual(0).or(w.lessThanEqual(0)), float(0), value);
  },
);

const crossNode = (v0: Node<'float'>, dv: Node<'float'>, target: number): Node<'float'> =>
  select(
    abs(dv).greaterThan(1e-6),
    clamp(
      float(target)
        .sub(v0)
        .div(select(abs(dv).greaterThan(1e-6), dv, float(1))),
      0,
      1,
    ),
    float(2),
  );

/**
 * The mist's optical depth along a piece of ray, as mistDepth computes each
 * half: its ends' distances from the centre and heights above the sea, and
 * its length.
 */
const mistLinearNode = /* @__PURE__ */ Fn(
  ([r0, z0, r1, z1, len]: [
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
    Node<'float'>,
  ]) => {
    const tau = float(0).toVar();
    const span = edgeLook.lip.sub(edgeLook.band);
    const a0 = r0.sub(edgeLook.band).div(span);
    const da = r1.sub(edgeLook.band).div(span).sub(a0);
    If(max(a0, a0.add(da)).greaterThan(0).and(edgeLook.on.greaterThan(0)), () => {
      const dz = z1.sub(z0);
      const invH = float(1).div(edgeLook.height);
      const x = crossNode(a0, da, 0);
      const y = crossNode(a0, da, 1);
      const z = crossNode(z0, dz, 0);
      const s1 = min(min(min(x, y), z), 1);
      const s3 = min(max(max(x, y), z), 1);
      const s2 = min(max(min(x, y), min(max(x, y), z)), 1);
      const sum = pieceNode(float(0), s1, a0, da, z0, dz, invH)
        .add(pieceNode(s1, s2, a0, da, z0, dz, invH))
        .add(pieceNode(s2, s3, a0, da, z0, dz, invH))
        .add(pieceNode(s3, float(1), a0, da, z0, dz, invH));
      tau.assign(edgeLook.sigma.mul(len).mul(sum));
    });
    return tau;
  },
);

/** A scene point's distance from the disk's centre, metres. */
export const centreDistance = (p: Node<'vec3'>): Node<'float'> =>
  length(vec2(p.x.add(edgeLook.origin.x), p.z.negate().add(edgeLook.origin.y)));

/** A scene point's height above the sea the dome curves away, metres: its bend undone. */
export const heightAboveSea = (p: Node<'vec3'>): Node<'float'> => {
  const d = p.xz.sub(domeCentre);
  return p.y.add(d.dot(d).mul(1 / (2 * DOME_RADIUS)));
};

/** The mist's optical depth between two scene points, the eye first. */
export const mistBetween = (eye: Node<'vec3'>, p: Node<'vec3'>): Node<'float'> => {
  const mid = eye.add(p).mul(0.5);
  const half = length(p.sub(eye)).mul(0.5);
  const rm = centreDistance(mid);
  const zm = heightAboveSea(mid);
  return mistLinearNode(centreDistance(eye), heightAboveSea(eye), rm, zm, half).add(
    mistLinearNode(rm, zm, centreDistance(p), heightAboveSea(p), half),
  );
};
