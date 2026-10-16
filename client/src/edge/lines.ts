// SPDX-License-Identifier: AGPL-3.0-only

// The drain on the water: lines of foam streaming toward the mist, about a
// line's spacing apart across the drain, each broken into dashes that the
// drain carries out at its own speed, faster toward the lip. A pattern is
// carried by a flow exactly when it is a function of the flow's travel time
// less world time: the drain is radial and linear in the distance from the
// centre between its points, so its travel time from where the lines begin
// has a closed form, τ(r) = ∫ dr / u(r), a logarithm on each piece (where
// a flow map must scroll and blend its phases to hide their reset: Vlachos,
// "Water Flow in Portal 2", 2010). The lines show from where the drain runs
// faster than the catalog's from, and more strongly as it quickens. They
// are foam, held in the tiles as all foam is.

import { Vector3, Vector4 } from 'three';
import {
  abs,
  float,
  floor,
  fract,
  log,
  max,
  min,
  select,
  sin,
  smoothstep,
  uniform,
  vec2,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { edgeLook } from './mist';

/** The time the dashes repeat in: a dash's time times the dashes before the pattern repeats. */
const DASH_TIME = 8;
const DASHES = 64;
export const LINES_PERIOD = DASH_TIME * DASHES;
/** A line's half-width, m, and the most foam it lays: the foam's pattern tears it. */
const HALF_WIDTH = 0.35;
const MOST = 0.8;

/** The drain as the lines read it: its points, m, its speeds there, m/s. */
export interface Drain {
  at: [number, number, number];
  speed: [number, number, number];
}

export const linesLook = {
  /** The drain's three points, m from the centre, and its speeds there, m/s; the lines' start speed, m/s. */
  at: uniform(new Vector3(6482, 7778.4, 8334)),
  speed: uniform(new Vector4(0, 0.309, 1.029, 0.154)),
  /** The lines' spacing across the drain, m. */
  apart: uniform(12),
  /** World time, s, reduced to the pattern's period. */
  time: uniform(0),
};

/** The drain's speed r metres from the centre, m/s: linear between its points. */
export function drainSpeed(d: Drain, r: number): number {
  const [r0, r1, r2] = d.at;
  const [u0, u1, u2] = d.speed;
  if (r <= r0) {
    return u0;
  }
  if (r < r1) {
    return u0 + ((u1 - u0) * (r - r0)) / (r1 - r0);
  }
  if (r < r2) {
    return u1 + ((u2 - u1) * (r - r1)) / (r2 - r1);
  }
  return u2;
}

/**
 * The drain's travel time from where it runs at start m/s to r metres from
 * the centre, s: ∫ dr / u(r), a logarithm on each piece; −∞ before start.
 */
export function travelTime(d: Drain, start: number, r: number): number {
  const [r0, r1, r2] = d.at;
  const [u0, u1, u2] = d.speed;
  const k1 = (u1 - u0) / (r1 - r0);
  const k2 = (u2 - u1) / (r2 - r1);
  const u = drainSpeed(d, r);
  if (!(u > start)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (r < r1) {
    return Math.log(u / start) / k1;
  }
  const t1 = Math.log(u1 / start) / k1;
  if (r < r2) {
    return t1 + Math.log(u / u1) / k2;
  }
  return t1 + Math.log(u2 / u1) / k2 + (r - r2) / u2;
}

const hash = (a: Node<'float'>, b: Node<'float'>): Node<'float'> =>
  fract(sin(a.mul(127.1).add(b.mul(311.7))).mul(43758.5453));

/**
 * The lines' foam at a scene point (x, z), 0 to 1: a dash of a line there,
 * as strong as the drain is fast. The start speed is lower than the second
 * point's, as the catalog has it.
 */
export function drainLines(p: Node<'vec2'>): Node<'float'> {
  const L = linesLook;
  const e = p.x.add(edgeLook.origin.x);
  const n = p.y.negate().add(edgeLook.origin.y);
  const r = vec2(e, n).length();
  const [r0, r1, r2] = [L.at.x, L.at.y, L.at.z];
  const [u0, u1, u2, start] = [L.speed.x, L.speed.y, L.speed.z, L.speed.w];
  const k1 = u1.sub(u0).div(r1.sub(r0));
  const k2 = u2.sub(u1).div(r2.sub(r1));
  const first = u0.add(k1.mul(r.sub(r0)));
  const second = u1.add(k2.mul(r.sub(r1)));
  const u = select(r.lessThan(r1), first, min(second, u2));
  const t1 = log(u1.div(start)).div(k1);
  const tau = select(
    r.lessThan(r1),
    log(max(u, start).div(start)).div(k1),
    select(
      r.lessThan(r2),
      t1.add(log(u.div(u1)).div(k2)),
      t1.add(log(u2.div(u1)).div(k2)).add(r.sub(r2).div(u2)),
    ),
  );
  // Across: the line's index and the place within its spacing, by the
  // angle at the band's inner edge.
  const across = vec2(e, n).normalize();
  const angle = across.x.atan(across.y);
  const lane = angle.mul(r1).div(L.apart);
  const line = floor(lane);
  const within = abs(fract(lane).sub(0.5)).mul(L.apart);
  // Along: dashes carried out by the drain.
  const phase = tau.sub(L.time).div(DASH_TIME);
  const dash = floor(phase);
  const inDash = fract(phase);
  const on = hash(line, dash.sub(floor(dash.div(DASHES)).mul(DASHES))).greaterThan(0.45);
  const shape = smoothstep(0, 0.15, inDash).mul(float(1).sub(smoothstep(0.75, 1, inDash)));
  const thin = float(1).sub(smoothstep(HALF_WIDTH * 0.5, HALF_WIDTH, within));
  const strength = smoothstep(start, u2, u).mul(MOST);
  return select(
    on.and(u.greaterThan(start)).and(edgeLook.on.greaterThan(0.5)),
    shape.mul(thin).mul(strength),
    float(0),
  );
}
