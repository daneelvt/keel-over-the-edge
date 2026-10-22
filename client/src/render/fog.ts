// SPDX-License-Identifier: AGPL-3.0-only

// The weather's fog and rain on the page, drawn as the rules see them: the
// optical depth along each ray from the camera, the fog banks', the rain's
// cores' and a front's band of rain, each a Gaussian in plan and an
// exponential in height, integrated along the ray in closed form as the
// physics module integrates it (physics.OpticalDepth): the exponent along a
// straight line over the dome is a quadratic, so its integral is a
// difference of erfc, Numerical Recipes' erfcc with the peak's exponent
// folded into each. Quílez's analytic fog, Wenzel's (SIGGRAPH 2006) and
// Unreal's Local Fog Volumes, which on phones fog surfaces per vertex, draw
// bounded fog the same way, with no march and no pass after the scene. The
// module gives the sources near the camera (AirSources), the nearest fog
// banks first, and the GPU sums them in a loop of their count: with none
// near, nothing is worked out.
//
// The depth joins the mist band's (edge/mist.ts) in every material's fog,
// the sea's finish, the clouds' puffs and the stars, worked out once a
// vertex and carried to the fragments; the sky works it out once a
// fragment, since its vertices are degrees apart and a bank's edge needs
// finer. A drifting noise varies the drawn fog by a quarter about the
// rules', for a bank's ragged edge and uneven top: drawing only.
//
// A lit light inside a bank lights the fog about it: the light scattered
// once toward the eye from a point source along a ray, in closed form
// (Sun, Ramamoorthi, Narasimhan and Nayar 2005), (atan((D − t) / h) +
// atan(t / h)) / h for a ray of length D passing h from the light, its
// nearest point t along the ray; the glows in fog, haze and mist that
// Narasimhan and Nayar (2003) find.

import { Color, Vector3, Vector4 } from 'three';
import {
  atan,
  cameraPosition,
  clamp,
  exp,
  Fn,
  float,
  int,
  Loop,
  max,
  min,
  select,
  sin,
  sqrt,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { edgeLook, heightAboveSea, mistBetween, seaPoint } from '../edge/mist';
import { SIZES } from '../predict/layout.gen';
import { DOME_RADIUS } from './materials';

/** The most sources the GPU sums: the module's fog banks and rain. */
export const AIR_SOURCES = 10;

/** A source with no top: above any ray. */
const NO_TOP = 1e9;

/** The drawn fog varies by this share about the rules', and over these lengths, m, drifting so fast, m/s. */
const NOISE = { share: 0.25, scale: [170, 230], drift: [0.6, 0.45] } as const;

/** How near a lit light must be, m, for its light in the fog about it to be drawn. */
export const HALO_REACH = 300;

/** What the air is drawn with: its uniforms, which the scene sets each frame. */
export const airLook = {
  /** How many sources are summed. */
  count: uniform(0, 'int'),
  /** Each source's centre, m east and north, and the direction its along axis runs, sine and cosine. */
  where: uniformArray(
    Array.from({ length: AIR_SOURCES }, () => new Vector4()),
    'vec4',
  ),
  /** Each source's along and across coefficients, 1/m², its inverse scale height, 1/m, and its extinction at its centre at the sea, 1/m. */
  shape: uniformArray(
    Array.from({ length: AIR_SOURCES }, () => new Vector4()),
    'vec4',
  ),
  /** Each source's top, m: nothing above it. */
  top: uniformArray(
    Array.from({ length: AIR_SOURCES }, () => new Vector4(NO_TOP, 0, 0, 0)),
    'vec4',
  ),
  /** World time, s, the noise drifts by; 1 to draw the noise, 0 for the rules' fog alone. */
  seconds: uniform(0),
  noise: uniform(1),
  /** The lit light whose light the fog about it scatters: its scene place, its strength (0 for none) and its colour, linear. */
  halo: uniform(new Vector4(0, 0, 0, 0)),
  haloColour: uniform(new Color(1, 0.9, 0.7)),
};

/** e^(−x) with x held above −60, for float32. */
const expNeg = (x: Node<'float'>): Node<'float'> => exp(max(x, -60).negate());

/** erfc(x) e^(−k), for x ≥ 0: Numerical Recipes' erfcc, its exponent folded with k. */
const erfcFolded = (x: Node<'float'>, k: Node<'float'>): Node<'float'> => {
  const t = float(1).div(float(1).add(x.mul(0.5)));
  let p: Node<'float'> = t.mul(0.17087277).sub(0.82215223);
  for (const c of [1.48851587, -1.13520398, 0.27886807, -0.18628806, 0.09678418, 0.37409196, 1.00002368]) {
    p = t.mul(p).add(c);
  }
  p = t.mul(p).sub(1.26551223);
  return t.mul(expNeg(x.mul(x).add(k).sub(p)));
};

/** a u² + b u + c. */
const quad = (a: Node<'float'>, b: Node<'float'>, c: Node<'float'>, u: Node<'float'>): Node<'float'> =>
  a.mul(u).mul(u).add(b.mul(u)).add(c);

/**
 * The integral of e^(−(a u² + b u + c)) from u0 to u1: where the exponent
 * changes by under a tenth, two points of Gauss–Legendre; where it is near
 * linear, the exponential's own; else the difference of erfc.
 */
const gaussInt = (
  a: Node<'float'>,
  b: Node<'float'>,
  c: Node<'float'>,
  u0: Node<'float'>,
  u1: Node<'float'>,
): Node<'float'> => {
  const w = max(u1.sub(u0), 0);
  const e0 = quad(a, b, c, u0);
  const e1 = quad(a, b, c, u1);
  const safeA = max(a, 1e-12);
  const m = b.negate().div(safeA.mul(2));
  const em = quad(a, b, c, clamp(m, u0, u1));
  const spread = max(e0, e1).sub(min(min(e0, e1), em));
  // Two points of Gauss–Legendre.
  const mid = u0.add(u1).mul(0.5);
  const off = w.mul(0.5 / Math.sqrt(3));
  const gl = w.mul(0.5).mul(expNeg(quad(a, b, c, mid.sub(off))).add(expNeg(quad(a, b, c, mid.add(off)))));
  // Near linear: its slope.
  const linear = w.mul(expNeg(e0).sub(expNeg(e1))).div(select(e1.sub(e0).abs().greaterThan(1e-6), e1.sub(e0), float(1e-6)));
  // The closed form.
  const s = sqrt(safeA);
  const k = c.sub(b.mul(b).div(safeA.mul(4)));
  const x0 = s.mul(u0.sub(m));
  const x1 = s.mul(u1.sub(m));
  const diff = select(
    x0.greaterThanEqual(0),
    erfcFolded(x0, k).sub(erfcFolded(x1, k)),
    select(
      x1.lessThanEqual(0),
      erfcFolded(x1.negate(), k).sub(erfcFolded(x0.negate(), k)),
      expNeg(k).mul(2).sub(erfcFolded(x1, k)).sub(erfcFolded(x0.negate(), k)),
    ),
  );
  const closed = diff.mul(Math.sqrt(Math.PI) / 2).div(s);
  return select(
    spread.lessThan(0.1),
    gl,
    select(a.mul(w).mul(w).lessThan(spread.mul(1e-4)), linear, closed),
  );
};

/** A scene point's place in the world, m east and north. */
const worldOf = (p: Node<'vec3'>): Node<'vec2'> =>
  vec2(p.x.add(edgeLook.origin.x), p.z.negate().add(edgeLook.origin.y));

/**
 * The weather's optical depth between two scene points, the eye first: the
 * sources' closed forms summed, nothing with none near. noise says whether
 * the drawn noise is laid over it.
 */
export const airBetween = (eye: Node<'vec3'>, p: Node<'vec3'>, noise = true): Node<'float'> =>
  Fn(() => {
    const e = worldOf(eye);
    const q = worldOf(p);
    const d = q.sub(e).toVar();
    const h0 = heightAboveSea(eye).toVar();
    const h1 = heightAboveSea(p);
    const dh = h1.sub(h0).toVar();
    const d2 = d.dot(d);
    const g = d2.mul(1 / (2 * DOME_RADIUS)).toVar();
    const length = sqrt(d2.add(dh.mul(dh))).toVar();
    const sum = float(0).toVar();
    Loop(
      { start: int(0), end: airLook.count, type: 'int', condition: '<' },
      ({ i }: { i: Node<'int'> }) => {
        const where = airLook.where.element(i) as unknown as Node<'vec4'>;
        const shape = airLook.shape.element(i) as unknown as Node<'vec4'>;
        const top = (airLook.top.element(i) as unknown as Node<'vec4'>).x;
        const o = e.sub(where.xy);
        const a0 = o.x.mul(where.z).add(o.y.mul(where.w));
        const a1 = d.x.mul(where.z).add(d.y.mul(where.w));
        const c0 = o.x.mul(where.w).sub(o.y.mul(where.z));
        const c1 = d.x.mul(where.w).sub(d.y.mul(where.z));
        const qa = shape.x.mul(a1.mul(a1)).add(shape.y.mul(c1.mul(c1))).add(g.mul(shape.z));
        const qb = shape.x
          .mul(a0.mul(a1))
          .add(shape.y.mul(c0.mul(c1)))
          .mul(2)
          .add(dh.sub(g).mul(shape.z));
        const qc = shape.x.mul(a0.mul(a0)).add(shape.y.mul(c0.mul(c0))).add(h0.mul(shape.z));
        // The stretch of the ray below the source's top: its height,
        // h0 + u dh − g u (1 − u), is convex in u, so it is one.
        const bb = dh.sub(g);
        const cc = h0.sub(top);
        const disc = max(bb.mul(bb).sub(g.mul(cc).mul(4)), 0);
        const root = sqrt(disc);
        const flat = g.lessThan(1e-6);
        const r0 = select(
          flat,
          select(dh.lessThan(0), cc.negate().div(min(dh, -1e-6)), float(-1e9)),
          bb.negate().sub(root).div(max(g, 1e-6).mul(2)),
        );
        const r1 = select(
          flat,
          select(dh.greaterThan(0), cc.negate().div(max(dh, 1e-6)), float(1e9)),
          bb.negate().add(root).div(max(g, 1e-6).mul(2)),
        );
        const whole = max(h0, h1).lessThanEqual(top);
        const u0 = select(whole, float(0), clamp(r0, 0, 1));
        const u1 = select(whole, float(1), clamp(r1, 0, 1));
        sum.addAssign(shape.w.mul(gaussInt(qa, qb, qc, u0, u1)));
      },
    );
    let tau: Node<'float'> = sum.mul(length);
    if (noise) {
      const t = airLook.seconds;
      const n = sin(q.x.div(NOISE.scale[0]).add(t.mul(NOISE.drift[0] / NOISE.scale[0]))).mul(
        sin(q.y.div(NOISE.scale[1]).sub(t.mul(NOISE.drift[1] / NOISE.scale[1]))),
      );
      tau = tau.mul(float(1).add(n.mul(NOISE.share).mul(airLook.noise)));
    }
    return tau;
  })() as unknown as Node<'float'>;

/** The mist band's and the weather's optical depth between two scene points, the eye first. */
export const depthBetween = (eye: Node<'vec3'>, p: Node<'vec3'>): Node<'float'> =>
  mistBetween(eye, p).add(airBetween(eye, p));

/** The optical depth from the camera to a vertex at p, scene position, carried to each fragment between. */
export const depthTo = (p: Node<'vec3'>): Node<'float'> =>
  varying(depthBetween(cameraPosition, p)) as unknown as Node<'float'>;

/** The optical depth from the camera to the sea's surface at scene (x, z), a vertex of the sea. */
export const depthToSea = (xz: Node<'vec2'>): Node<'float'> => depthTo(seaPoint(xz));

/**
 * The light of the halo's light the fog scatters toward the eye along the
 * ray from eye to p, scene points: Sun and others' single scattering from a
 * point source, without the attenuation within, times the fog's extinction
 * at the light, which the strength carries.
 */
export const haloBetween = (eye: Node<'vec3'>, p: Node<'vec3'>): Node<'vec3'> =>
  Fn(() => {
    const h = airLook.halo;
    const d = p.sub(eye);
    const length = max(d.length(), 1e-3);
    const dir = d.div(length);
    const toLight = vec3(h.x, h.y, h.z).sub(eye);
    const t = toLight.dot(dir);
    const off = max(toLight.sub(dir.mul(t)).length(), 0.5);
    const along = atan(length.sub(t).div(off)).add(atan(t.div(off))).div(off);
    return (airLook.haloColour as unknown as Node<"vec3">).mul(along.mul(h.w));
  })() as unknown as Node<'vec3'>;

/**
 * Writes the module's sources (its airSource records) into the uniforms:
 * as many as there are room for.
 */
export function setAirSources(records: Float64Array, fields: Record<string, number>): void {
  const per = SIZES.airSource;
  const n = Math.min(Math.floor(records.length / per), AIR_SOURCES);
  for (let i = 0; i < n; i++) {
    const o = i * per;
    const v = (k: string): number => records[o + (fields[k] ?? 0)] ?? 0;
    (airLook.where.array[i] as Vector4).set(v('east'), v('north'), v('sin'), v('cos'));
    (airLook.shape.array[i] as Vector4).set(v('along'), v('across'), v('invHeight'), v('sigma'));
    (airLook.top.array[i] as Vector4).set(Math.min(v('top'), NO_TOP), 0, 0, 0);
  }
  airLook.count.value = n;
}

/** Places the halo's light at a scene point, of a strength (0 for none). */
export function setHalo(at: Vector3 | null, strength: number, colour?: readonly number[]): void {
  const h = airLook.halo.value as Vector4;
  if (at === null || !(strength > 0)) {
    h.w = 0;
    return;
  }
  h.set(at.x, at.y, at.z, strength);
  if (colour !== undefined) {
    (airLook.haloColour.value as Color).setRGB(colour[0] ?? 1, colour[1] ?? 1, colour[2] ?? 1);
  }
}

/**
 * The weather's optical depth along a line as the GPU sums it, in float64:
 * the same sources and the same closed form, for the tests against the
 * module's.
 */
export function airDepth(
  sources: readonly {
    east: number;
    north: number;
    sin: number;
    cos: number;
    along: number;
    across: number;
    invHeight: number;
    sigma: number;
    top: number;
  }[],
  x0: number,
  y0: number,
  h0: number,
  x1: number,
  y1: number,
  h1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dh = h1 - h0;
  const d2 = dx * dx + dy * dy;
  const g = d2 / (2 * DOME_RADIUS);
  const length = Math.sqrt(d2 + dh * dh);
  let sum = 0;
  for (const s of sources) {
    const ox = x0 - s.east;
    const oy = y0 - s.north;
    const a0 = ox * s.sin + oy * s.cos;
    const a1 = dx * s.sin + dy * s.cos;
    const c0 = ox * s.cos - oy * s.sin;
    const c1 = dx * s.cos - dy * s.sin;
    const qa = s.along * a1 * a1 + s.across * c1 * c1 + g * s.invHeight;
    const qb = 2 * (s.along * a0 * a1 + s.across * c0 * c1) + (dh - g) * s.invHeight;
    const qc = s.along * a0 * a0 + s.across * c0 * c0 + h0 * s.invHeight;
    let u0 = 0;
    let u1 = 1;
    if (Math.max(h0, h1) > s.top) {
      const b = dh - g;
      const c = h0 - s.top;
      if (g < 1e-6) {
        [u0, u1] = dh > 0 ? [0, -c / dh] : [-c / dh, 1];
      } else {
        const r = Math.sqrt(Math.max(b * b - 4 * g * c, 0));
        u0 = (-b - r) / (2 * g);
        u1 = (-b + r) / (2 * g);
      }
      u0 = Math.min(Math.max(u0, 0), 1);
      u1 = Math.min(Math.max(u1, 0), 1);
    }
    sum += s.sigma * gaussIntCpu(qa, qb, qc, u0, u1);
  }
  return sum * length;
}

function erfcFoldedCpu(x: number, k: number): number {
  const t = 1 / (1 + 0.5 * x);
  let p = t * 0.17087277 - 0.82215223;
  for (const c of [1.48851587, -1.13520398, 0.27886807, -0.18628806, 0.09678418, 0.37409196, 1.00002368]) {
    p = t * p + c;
  }
  p = t * p - 1.26551223;
  return t * Math.exp(-Math.max(x * x + k - p, -60));
}

function gaussIntCpu(a: number, b: number, c: number, u0: number, u1: number): number {
  const q = (u: number): number => a * u * u + b * u + c;
  const w = Math.max(u1 - u0, 0);
  const e0 = q(u0);
  const e1 = q(u1);
  const sa = Math.max(a, 1e-12);
  const m = -b / (2 * sa);
  const em = q(Math.min(Math.max(m, u0), u1));
  const spread = Math.max(e0, e1) - Math.min(e0, e1, em);
  const ex = (x: number): number => Math.exp(-Math.max(x, -60));
  if (spread < 0.1) {
    const mid = (u0 + u1) / 2;
    const off = (w / 2) / Math.sqrt(3);
    return (w / 2) * (ex(q(mid - off)) + ex(q(mid + off)));
  }
  if (a * w * w < spread * 1e-4) {
    const slope = Math.abs(e1 - e0) > 1e-6 ? e1 - e0 : 1e-6;
    return (w * (ex(e0) - ex(e1))) / slope;
  }
  const s = Math.sqrt(sa);
  const k = c - (b * b) / (4 * sa);
  const x0 = s * (u0 - m);
  const x1 = s * (u1 - m);
  const diff =
    x0 >= 0
      ? erfcFoldedCpu(x0, k) - erfcFoldedCpu(x1, k)
      : x1 <= 0
        ? erfcFoldedCpu(-x1, k) - erfcFoldedCpu(-x0, k)
        : 2 * ex(k) - erfcFoldedCpu(x1, k) - erfcFoldedCpu(-x0, k);
  return (diff * Math.sqrt(Math.PI)) / (2 * s);
}

/** A scratch place for the halo. */
export const haloAt = new Vector3();
