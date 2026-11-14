// SPDX-License-Identifier: AGPL-3.0-only

// The winner's cockade: a small rosette of pleated gold ribbon about a
// button, pinned to the hat's left side (or the coat's left breast, for a
// look with no hat), worn by a race's winner for the rest of the world. It
// is painted where the look's art puts it (the catalog's art.cockade): a
// disc on the figure as it is bound, so it moves with the hat as the figure
// does, drawn by the sailors' material on whatever cloth lies within it.
// Each vertex carries its place on the disc (cockadeCoords), across it in
// two ways and out from it, in the disc's radii, a varying: linear in the
// vertex's place, so its fragments' are exact; the fragment draws the
// rosette there (rosette).

import { Color, Vector3 } from 'three';
import {
  abs,
  atan,
  cos,
  cross,
  dot,
  exp,
  float,
  length,
  mix,
  normalize,
  select,
  smoothstep,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Cockade, PrizeCockade } from '../../catalog/types.gen';

/** How deep the disc reaches either side of its plane, in its radii. */
const DEPTH = 0.55;
/** The button's radius, the inner tier's edge, in the disc's radii. */
const BUTTON = 0.3;
const TIER = 0.64;
/** Pleats round it. */
const PLEATS = 18;

/** A cockade's place on a figure, its plane's two ways across, and its radius, m. */
export interface CockadePlace {
  at: Vector3;
  across: Vector3;
  up: Vector3;
  facing: Vector3;
  radius: number;
}

/** A look's cockade's place, from its art's and the prize's width. */
export function cockadePlace(c: Cockade, across: number): CockadePlace {
  const facing = new Vector3(...(c.facing as [number, number, number])).normalize();
  // Across the disc level, then up it; a disc facing straight up takes
  // the figure's forward for its up.
  const ref = Math.abs(facing.y) > 0.95 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(ref, facing).normalize();
  const up = new Vector3().crossVectors(facing, side).normalize();
  return {
    at: new Vector3(...(c.at as [number, number, number])),
    across: side,
    up,
    facing,
    radius: across / 2,
  };
}

/** A point's place on a disc, in its radii: across, up, and out from its plane. */
export function onDisc(p: Vector3, c: CockadePlace, out: Vector3): Vector3 {
  const r = out.copy(p).sub(c.at);
  return r.set(r.dot(c.across) / c.radius, r.dot(c.up) / c.radius, r.dot(c.facing) / c.radius);
}

/**
 * The vertex's place on the disc in its radii (onDisc on the GPU), from
 * its place on the figure as bound, the disc's middle and the way it
 * faces (each figure's own), and its radius.
 */
export function cockadeCoords(
  bound: Node<'vec3'>,
  at: Node<'vec3'>,
  facing: Node<'vec3'>,
  radius: number,
): Node<'vec3'> {
  const f = normalize(facing);
  const ref = select(abs(f.y).greaterThan(0.95), vec3(0, 0, 1), vec3(0, 1, 0));
  const side = normalize(cross(ref, f));
  const up = cross(f, side);
  const r = bound.sub(at).div(radius);
  return vec3(dot(r, side), dot(r, up), dot(r, f)) as unknown as Node<'vec3'>;
}

/** The prize's colours, linear. */
export function cockadeColours(p: PrizeCockade): { ribbon: Color; button: Color } {
  return { ribbon: new Color(p.ribbon), button: new Color(p.button) };
}

/**
 * The rosette at a fragment's place on the disc (cockadeCoords, a
 * varying), worn where wears is 1: how much of it is there (0 off it), and
 * its colour there: a button in the middle, a tier of pleats about it, a
 * wider tier of pleats behind, scalloped at its edge.
 */
export function rosette(
  coords: Node<'vec3'>,
  wears: Node<'float'>,
  colours: { ribbon: Color; button: Color },
): { on: Node<'float'>; colour: Node<'vec3'> } {
  const r = length(coords.xy);
  const angle = atan(coords.y, coords.x);
  const pleat = cos(angle.mul(PLEATS)).mul(0.5).add(0.5);
  const edge = float(1).sub(pleat.mul(0.08));
  const inside = float(1).sub(smoothstep(edge.sub(0.04), edge, r));
  const near = float(1).sub(smoothstep(DEPTH * 0.8, DEPTH, abs(coords.z)));
  const on = wears.mul(inside).mul(near);
  const ribbon = vec3(colours.ribbon.r, colours.ribbon.g, colours.ribbon.b);
  const button = vec3(colours.button.r, colours.button.g, colours.button.b);
  // The pleats' light and shade, a shadow where the inner tier lies on
  // the outer, the button domed.
  const folds = ribbon.mul(pleat.mul(0.35).add(0.65));
  const tier = float(1).sub(exp(r.sub(TIER).div(0.05).pow(2).negate()).mul(0.35));
  const dome = float(1.15).sub(r.div(BUTTON).mul(0.45));
  const colour = mix(
    folds.mul(tier),
    button.mul(dome),
    float(1).sub(smoothstep(BUTTON - 0.03, BUTTON, r)),
  );
  return { on: on as unknown as Node<'float'>, colour: colour as unknown as Node<'vec3'> };
}
