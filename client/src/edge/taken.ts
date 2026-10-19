// SPDX-License-Identifier: AGPL-3.0-only

// The world's end, staged: the falls take the world on every phone at the
// same moment, by the world clock. A minute before, the falls' roar rises
// wherever the boat is and the mist closes in; twenty seconds before, the
// near sea's tiles break off and fall, ring by ring from the far edge of
// the near sea toward the boat, as the slabs at the brink do (falls.ts):
// they tip outward, spin and fall at the slabs' gravity into the mist; at
// the end the boat is left on the last of the water and the screen fades
// to the mist, reading "The falls take the world". The new world rises out
// of the mist once its Welcome comes. It is drawing alone: the boat's
// physics is the world's until the end's tick.
//
// Every part is a function of the time left, so two pages draw the same
// tiles falling at the same world time.

import {
  BufferAttribute,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
} from 'three';
import {
  attribute,
  cos,
  float,
  max,
  mix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { type Hex, hexAt, hexCentre, type Point, TILE_ACROSS } from '../ocean/hex';
import { tileGeometry } from '../ocean/tiles';
import { basicMaterial } from '../render/materials';
import { look, toLinear } from '../render/sky';
import { endLook } from './broken';
import { hash01 } from './falls';
import { edgeLook } from './mist';

/** The staged end's timings: the catalog's world.edge.end, s. */
export interface EndLook {
  sound: number;
  mist: number;
  tiles: number;
  rise: number;
}

/** The near sea that breaks away, m from the boat: beyond it the sea is gone first. */
export const NEAR_SEA = 120;
/** How long the screen takes to fade to the mist at the end, s. */
export const VEIL = 3;
/** The visual range the mist closes in to, m: the lip's. */
export const MIST_RANGE = 300;
/** A slab's gravity, m/s², and how long one is drawn falling, s. */
const SLAB_GRAVITY = 3;
const SLAB_LIFE = 6;
/** The most slabs drawn at once. */
export const MAX_END_SLABS = 2048;
/** A slab's thickness, m: the depth of a tile's skirt. */
const SLAB_THICKNESS = 1.1;

/** The staged end at a moment. */
export interface EndStage {
  /** How loud the falls are, 0 to 1 of their roar falling; how far the mist has closed in, 0 to 1. */
  sound: number;
  mist: number;
  /** The radius about the boat within which the sea still stands, m; Infinity before it breaks. */
  cut: number;
  /** How far the screen has faded to the mist, 0 to 1. */
  veil: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** The end's stage with left seconds to go; negative left is past the end. */
export function endStage(l: EndLook, left: number): EndStage {
  if (!Number.isFinite(left) || left > Math.max(l.sound, l.mist, l.tiles)) {
    return { sound: 0, mist: 0, cut: Number.POSITIVE_INFINITY, veil: 0 };
  }
  return {
    sound: smooth(1 - left / l.sound),
    mist: smooth(1 - left / l.mist),
    cut: left >= l.tiles ? Number.POSITIVE_INFINITY : Math.max(0, (NEAR_SEA * left) / l.tiles),
    veil: smooth(1 - left / VEIL),
  };
}

/** The rising: how far the new world has risen out of the mist, s after its Welcome; 1 risen. */
export function risen(l: EndLook, since: number): number {
  return smooth(since / l.rise);
}

/** The visual range with the mist closed in by m, 0 to 1: the clear air's to the lip's, evenly in its log. */
export function closedIn(clear: number, m: number): number {
  if (m <= 0 || clear <= MIST_RANGE) {
    return clear;
  }
  return Math.exp(Math.log(clear) + (Math.log(MIST_RANGE) - Math.log(clear)) * m);
}

/** When a cell of the lattice at d m from the boat breaks away, s before the end. */
export function breaksAt(l: EndLook, d: number): number {
  return (l.tiles * d) / NEAR_SEA;
}

/**
 * The near sea's slabs: each cell of the lattice within NEAR_SEA of the
 * boat breaks away as the cut passes it, then tips outward from the boat,
 * spins and falls at the slabs' gravity into the mist; those beyond it go
 * with the far sea, unseen in the mist.
 */
export class EndSlabs {
  readonly mesh: Mesh;
  readonly #place: InstancedBufferAttribute;
  readonly #geometry: InstancedBufferGeometry;

  constructor() {
    const t = tileGeometry();
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(t.position, 3));
    geometry.setIndex(new BufferAttribute(t.index, 1));
    // Each slab's cell, east and north of the boat; its age since it broke
    // away, s; and its spin, rad/s.
    const place = new InstancedBufferAttribute(new Float32Array(MAX_END_SLABS * 4), 4);
    place.setUsage(35048); // DynamicDrawUsage
    geometry.setAttribute('place', place);
    geometry.instanceCount = 0;
    this.#place = place;
    this.#geometry = geometry;

    const p = attribute<'vec4'>('place', 'vec4');
    const age = max(p.z, 0);
    const r0 = vec2(p.x, p.y).length();
    const outward = vec2(p.x, p.y).div(max(r0, 1));
    const down = age.mul(age).mul(0.5 * SLAB_GRAVITY);
    const tip = age.mul(0.9).add(0.2);
    const spin = p.w.mul(age);
    // The slab's own vertex, spun about its up, then tipped outward about
    // the tangent of its ring.
    const e = positionGeometry.xz;
    const y0 = positionGeometry.y.mul(SLAB_THICKNESS);
    const ex = e.x.mul(cos(spin)).sub(e.y.mul(sin(spin)));
    const ez = e.x.mul(sin(spin)).add(e.y.mul(cos(spin)));
    const ns = vec2(outward.x, outward.y.negate());
    const ts = vec2(ns.y.negate(), ns.x);
    const along = ex.mul(ns.x).add(ez.mul(ns.y));
    const across = ex.mul(ts.x).add(ez.mul(ts.y));
    const a2 = along.mul(cos(tip)).add(y0.mul(sin(tip)));
    const y2 = y0.mul(cos(tip)).sub(along.mul(sin(tip)));
    // Out a little as it tips, from the boat.
    const out = age.mul(0.6);
    const east = endLook.centre.x.add(p.x).add(outward.x.mul(out));
    const north = endLook.centre.y.add(p.y).add(outward.y.mul(out));
    const sx = east.sub(edgeLook.origin.x).add(ns.x.mul(a2)).add(ts.x.mul(across));
    const sz = north.sub(edgeLook.origin.y).negate().add(ns.y.mul(a2)).add(ts.y.mul(across));
    const hidden = p.z.lessThan(0).or(endLook.on.lessThan(0.5));
    const vertex = select(hidden, vec3(sx, -1000, sz), vec3(sx, y2.sub(down), sz));
    const depth = varying(down);
    const side = varying(positionGeometry.y);
    const m = basicMaterial({ side: DoubleSide }, vertex);
    const water = look.deep
      .mul(1.1)
      .add(look.scatter.mul(select(side.lessThan(-0.01), float(0.05), float(0.2))));
    const white = mix(water, look.cloud, select(side.lessThan(-0.01), float(0.35), float(0.12)));
    m.colorNode = vec4(toLinear(mix(white, edgeLook.colour, smoothstep(2, 40, depth))), 1);
    const mesh = new Mesh(geometry, m);
    mesh.name = 'end-slabs';
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.mesh = mesh;
  }

  /**
   * Brings the slabs to the end's stage: the cells whose break is under
   * way, about the boat at (east, north), with left seconds to go; a cell
   * over land, by ground's height there, has no sea to break.
   */
  frame(
    l: EndLook,
    left: number,
    east: number,
    north: number,
    ground: ((east: number, north: number) => number | null) | null = null,
  ): void {
    if (!(left < l.tiles) || left < -SLAB_LIFE) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    // The cells in the ring the cut has passed in the last SLAB_LIFE s.
    const outer = Math.min(NEAR_SEA, (NEAR_SEA * (left + SLAB_LIFE)) / l.tiles);
    const inner = Math.max(0, (NEAR_SEA * left) / l.tiles);
    const place = this.#place.array as Float32Array;
    const c: Point = { x: 0, y: 0 };
    // The lattice is the world's, fixed: its cells about the boat's.
    const h: Hex = hexAt(east, north, { q: 0, r: 0 });
    const span = Math.ceil(outer / TILE_ACROSS) + 1;
    let n = 0;
    for (let dq = -span; dq <= span && n < MAX_END_SLABS; dq++) {
      const r0 = Math.max(-span, -dq - span);
      const r1 = Math.min(span, -dq + span);
      for (let dr = r0; dr <= r1 && n < MAX_END_SLABS; dr++) {
        const q = h.q + dq;
        const r = h.r + dr;
        hexCentre(q, r, c);
        const dx = c.x - east;
        const dy = c.y - north;
        const d = Math.hypot(dx, dy);
        if (d < inner || d >= outer) {
          continue;
        }
        if (ground !== null && (ground(c.x, c.y) ?? -1) > 0) {
          continue;
        }
        const age = breaksAt(l, d) - left;
        const key = Math.imul(q, 73856093) ^ Math.imul(r, 19349663);
        place.set([dx, dy, age, 0.9 * (2 * hash01(key, 4) - 1)], n * 4);
        n++;
      }
    }
    this.#geometry.instanceCount = n;
    this.#place.needsUpdate = true;
  }

  /** How many slabs are drawn (the panel, the measurements). */
  get count(): number {
    return this.mesh.visible ? this.#geometry.instanceCount : 0;
  }
}
