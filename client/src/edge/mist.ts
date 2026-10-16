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
// The integral is taken at sixteen points along the straight ray through
// the scene, the density at each from its distance from the centre and its
// height above the curved sea: the k-th at u² of the way from the eye, u
// the middle of the k-th sixteenth, weighted 2u (the midpoint rule after
// t = u²). The points crowd toward the eye, where an upward ray's mist all
// lies; over the rays the game draws, from the deck, the cameras and the
// sky, the light let through is within 0.02 of a 20,000-step integral's
// (mist.test.ts). It is worked out once a vertex, carried to the fragments
// between, and only while the camera is near the edge: every material's
// fog carries it, and a short loop costs a software renderer's compiler,
// as CI draws with, much less than a long one. The page computes it
// the same way: mistAlong here, and its node below.

import { Color, Vector2 } from 'three';
import {
  cameraPosition,
  clamp,
  exp,
  Fn,
  float,
  int,
  Loop,
  length,
  max,
  positionWorld,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { DOME_RADIUS, domeCentre } from '../render/materials';

/** Koschmieder's constant: ln(1/0.02), the contrast threshold of 2%. */
export const KOSCHMIEDER = 3.912;

/** The points the mist is taken at along a ray. */
export const MIST_SAMPLES = 16;

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
  /** 1 to draw the edge's mist, the lip and the falls, 0 for none (?edge=off). */
  on: uniform(1),
  /**
   * 1 while the camera is near enough the band and the drain to see them,
   * else 0: the turns of a loop (nearEdge) the drain's lines are worked out
   * in, and a sixteenth of the mist's, so that elsewhere they are not
   * worked out at all.
   */
  near: uniform(0, 'int'),
  /** The sea's last tiles before the brink tip outward by this, rad, and drop by this, m. */
  tip: uniform(0.3),
  sag: uniform(0.2),
};

/** The mist's numbers: the band, its density at the lip and its scale height. */
export interface MistParams {
  band: number;
  lip: number;
  /** Extinction per metre at the lip at the sea, over the clear air's. */
  sigma: number;
  height: number;
}

/** The density at a point, per metre, r metres from the centre and z above the sea. */
export function mistDensity(r: number, z: number, p: MistParams): number {
  const m = Math.min(Math.max((r - p.band) / (p.lip - p.band), 0), 1);
  return p.sigma * m * Math.exp(-Math.max(z, 0) / p.height);
}

/** The visual range at a point at the sea, metres, in air of clear visual range clear. */
export function visualRangeAt(r: number, clear: number, p: MistParams): number {
  return KOSCHMIEDER / (KOSCHMIEDER / clear + mistDensity(r, 0, p));
}

/**
 * Where the scene lies in the world: its origin, metres east and north of
 * the centre, and the dome's centre, scene x and z.
 */
export interface MistFrame {
  origin: [number, number];
  dome: [number, number];
}

/** A scene point: x east, y up, z south, metres. */
export type ScenePoint = [number, number, number];

/** The density at a scene point, as the node takes it. */
export function mistDensityAt(q: ScenePoint, f: MistFrame, p: MistParams): number {
  const r = Math.hypot(q[0] + f.origin[0], -q[2] + f.origin[1]);
  const dx = q[0] - f.dome[0];
  const dz = q[2] - f.dome[1];
  return mistDensity(r, q[1] + (dx * dx + dz * dz) / (2 * DOME_RADIUS), p);
}

/** The mist's optical depth from the eye to p, scene points, at samples points as the node takes it. */
export function mistAlong(
  eye: ScenePoint,
  p: ScenePoint,
  f: MistFrame,
  params: MistParams,
  samples = MIST_SAMPLES,
): number {
  const d: ScenePoint = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    const t = u * u;
    sum +=
      2 * u * mistDensityAt([eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t], f, params);
  }
  return (sum * Math.hypot(d[0], d[1], d[2])) / samples;
}

// The node: the same samples, op for op.

/** A scene point's distance from the disk's centre, metres. */
export const centreDistance = (p: Node<'vec3'>): Node<'float'> =>
  length(vec2(p.x.add(edgeLook.origin.x), p.z.negate().add(edgeLook.origin.y)));

/** A scene point's height above the sea the dome curves away, metres: its bend undone. */
export const heightAboveSea = (p: Node<'vec3'>): Node<'float'> => {
  const d = p.xz.sub(domeCentre);
  return p.y.add(d.dot(d).mul(1 / (2 * DOME_RADIUS)));
};

/**
 * Runs body only while the camera is near the edge: as a loop of
 * edgeLook.near turns rather than an if, since a renderer that runs both
 * sides of an if, masking off the pixels that do not take it, still runs
 * no turn of a loop that has none.
 */
export const nearEdge = (body: () => void): void => {
  Loop({ start: int(0), end: edgeLook.near, type: 'int', condition: '<' }, body);
};

/** The mist's optical depth between two scene points, the eye first; nothing far from the edge. */
export const mistBetween = (eye: Node<'vec3'>, p: Node<'vec3'>): Node<'float'> =>
  Fn(() => {
    const d = p.sub(eye).toVar();
    const sum = float(0).toVar();
    const span = edgeLook.lip.sub(edgeLook.band);
    const invH = float(1).div(edgeLook.height);
    // Sixteen turns near the edge, none elsewhere.
    Loop(
      { start: int(0), end: edgeLook.near.mul(MIST_SAMPLES), type: 'int', condition: '<' },
      ({ i }: { i: Node<'int'> }) => {
        const u = float(i).add(0.5).div(float(MIST_SAMPLES));
        const q = eye.add(d.mul(u.mul(u)));
        const share = clamp(centreDistance(q).sub(edgeLook.band).div(span), 0, 1);
        const fall = exp(max(heightAboveSea(q), 0).mul(invH).negate());
        sum.addAssign(u.mul(2).mul(share).mul(fall));
      },
    );
    return sum.mul(edgeLook.sigma).mul(length(d)).div(float(MIST_SAMPLES));
  })() as unknown as Node<'float'>;

/**
 * The mist's optical depth from the camera to a vertex at p, scene
 * position, carried to each fragment between: a vertex of a tile, a boat or
 * a column of land lies a few metres from the next, and the mist varies
 * over hundreds, so it is worked out once a vertex, not once a fragment.
 */
export const mistTo = (p: Node<'vec3'>): Node<'float'> =>
  varying(mistBetween(cameraPosition, p)) as unknown as Node<'float'>;

/**
 * The mist from the camera to the sea's surface at scene (x, z), a vertex
 * of the sea: its waves' height is nothing to the mist's scale height, and
 * the sea's own position, built from the waves' sum in a loop of its own,
 * left that loop's body in the fragment shader when the mist was taken to
 * it.
 */
export const mistToSea = (xz: Node<'vec2'>): Node<'float'> => mistTo(seaPoint(xz));

/** The sea's surface at scene (x, z), as the dome curves it. */
export const seaPoint = (xz: Node<'vec2'>): Node<'vec3'> => {
  const d = xz.sub(domeCentre);
  return vec3(xz.x, d.dot(d).mul(-1 / (2 * DOME_RADIUS)), xz.y);
};

/** The mist from the camera to the vertex, as the scene's fog takes it. */
export const mistAtVertex = (): Node<'float'> => mistTo(positionWorld);
