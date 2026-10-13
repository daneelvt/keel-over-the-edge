// SPDX-License-Identifier: AGPL-3.0-only

// Water never shows inside a hull. The sea's surface passes through a boat
// as if it were not there, so its own shader leaves out every fragment that
// lies inside a hull: within a volume built from stations along the hull,
// each with the half-beam at the waterline and the depth of the bottom,
// measured from the hull's own mesh by the script that builds the model.
// Between stations the volume is their blend; below the waterline its sides
// narrow to the bottom as a superellipse; above the waterline it has no
// top, so a wave that rises above the gunwale is not drawn inside the boat
// either, which a lid at the gunwale would let through. The fragment is
// taken into the hull's own frame first, its heave, pitch and heel
// included, so the volume holds however the boat lies.
//
// This is clipping the water's surface by a primitive (Crest, "Water
// Exclusion": clip surface, signed distance primitives): it needs no
// stencil buffer and no extra pass, and works where volumes overlap.
//
// The same walk over the hulls gives the foam a hull makes: a ring at its
// waterline, more at the bow, and two arms that trail from the bow at the
// half-angle of a ship's wake, arcsin ⅓ (Thomson, "On ship waves", 1887).
// Both grow with the hull's speed through the water; a hull at rest has the
// ring alone.

import { Vector4 } from 'three';
import {
  abs,
  clamp,
  Discard,
  dot,
  exp,
  Fn,
  float,
  floor,
  If,
  int,
  Loop,
  length,
  max,
  min,
  mix,
  pow,
  smoothstep,
  uniform,
  uniformArray,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { DOME_RADIUS, domeCentre } from '../render/materials';
import { WAKE } from './look';

/** The most hulls the sea is kept out of: the player's own and the nearest others. */
export const HULLS = 8;
/** Stations along a hull. */
export const STATIONS = 8;
/** Other boats further than this from the player's are left to the sea, metres. */
export const HULL_REACH = 150;
/** The volume is this fraction of the hull's width, so the sea meets the planking. */
export const HULL_FILL = 0.94;
/** A fragment's own place is taken a little off the fragment's, so a tile this much further off than a hull reaches may still need the walk, metres. */
export const HULL_MARGIN = 0.5;
/** A hull's foam reaches this many of its half-lengths astern of its middle. */
export const WAKE_REACH = 3.5;

/** A hull's volume: its stations from the transom forward, each [z, half-beam at the waterline, depth of the bottom], and the exponent of its sections' narrowing. */
export interface HullShape {
  stations: number[][];
  bilge: number;
}

/** Reads a hull's volume from its model's node data; null if it has none. */
export function hullShape(data: unknown): HullShape | null {
  const w = (data as { waterline?: { stations?: unknown; bilge?: unknown } } | undefined)
    ?.waterline;
  if (w === undefined || !Array.isArray(w.stations) || typeof w.bilge !== 'number') {
    return null;
  }
  const stations = w.stations as number[][];
  if (
    stations.length !== STATIONS ||
    stations.some((s) => !Array.isArray(s) || s.length !== 3 || s.some((v) => !Number.isFinite(v)))
  ) {
    return null;
  }
  return { stations, bilge: w.bilge };
}

/**
 * Whether the point (x to starboard, y above the waterline, z aft, in the
 * hull's own frame) lies in the volume, widened or narrowed to `fill` of the
 * hull's width: the shader's test, for the tests and whoever else asks.
 */
export function insideHull(
  shape: HullShape,
  x: number,
  y: number,
  z: number,
  fill = HULL_FILL,
): boolean {
  const s = shape.stations;
  const aft = s[0]?.[0] ?? 0;
  const fore = s[STATIONS - 1]?.[0] ?? 0;
  if (!(z < aft && z > fore)) {
    return false;
  }
  const t = ((aft - z) / (aft - fore)) * (STATIONS - 1);
  const i = Math.min(Math.floor(t), STATIONS - 2);
  const f = t - i;
  const a = s[i] as number[];
  const b = s[i + 1] as number[];
  const beam = (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * f;
  const depth = (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * f;
  if (!(y > -depth)) {
    return false;
  }
  const below = Math.min(Math.max(-y / Math.max(depth, 1e-4), 0), 1);
  const side = (1 - below ** shape.bilge) ** (1 / shape.bilge);
  return Math.abs(x) < fill * beam * side;
}

/**
 * A scene vector from a boat's centre of gravity, in the boat's own frame
 * (x to starboard, y up, z aft): the turns that place a boat, its heel, then
 * its pitch, then its heading, undone in reverse. The shader's inHull, on
 * the CPU.
 */
export function toHullFrame(
  d: { x: number; y: number; z: number },
  heading: number,
  pitch: number,
  heel: number,
): { x: number; y: number; z: number } {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const ax = d.x * ch + d.z * sh;
  const az = d.z * ch - d.x * sh;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const by = d.y * cp + az * sp;
  const bz = az * cp - d.y * sp;
  const cr = Math.cos(heel);
  const sr = Math.sin(heel);
  return { x: ax * cr - by * sr, y: ax * sr + by * cr, z: bz };
}

export class HullVolumes {
  /** Hulls this frame. */
  readonly count: UniformNode<'float', number> = uniform(0);
  /** Each hull's centre of gravity in the scene, and its heading. */
  readonly #places: Vector4[] = Array.from({ length: HULLS }, () => new Vector4());
  /** Each hull's heel and pitch, and its speed through the water, m/s. */
  readonly #tilts: Vector4[] = Array.from({ length: HULLS }, () => new Vector4());
  /** The stations: z, half-beam, depth. */
  readonly #stations: Vector4[] = Array.from({ length: STATIONS }, () => new Vector4());
  /** The bilge's exponent, the centre of gravity's height above the waterline, and the hull's reach from it. */
  readonly #shape = uniform(new Vector4(2, 0, 0, 0));
  /** The waterline as the foam sees it: its middle's place aft of the origin, its half-length, its half-beam, and how far the foam reaches from the origin. */
  readonly #plan = uniform(new Vector4(0, 1, 0.5, 0));
  readonly #placesNode = uniformArray(this.#places, 'vec4');
  readonly #tiltsNode = uniformArray(this.#tilts, 'vec4');
  readonly #stationsNode = uniformArray(this.#stations, 'vec4');
  #n = 0;
  #ready = false;

  /** The kind's hull, and its centre of gravity's height above the waterline. */
  setShape(shape: HullShape, centreOfGravity: number): void {
    let reach = 0;
    shape.stations.forEach((s, i) => {
      (this.#stations[i] as Vector4).set(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, 0);
      reach = Math.max(reach, Math.hypot(s[0] ?? 0, s[1] ?? 0));
    });
    // A heeled or pitched hull reaches no further from its centre of gravity than this.
    this.#shape.value.set(shape.bilge, centreOfGravity, reach + centreOfGravity + 0.5, 0);
    const aft = shape.stations[0]?.[0] ?? 0;
    const fore = shape.stations[STATIONS - 1]?.[0] ?? 0;
    const half = (aft - fore) / 2;
    const beam = Math.max(...shape.stations.map((s) => s[1] ?? 0));
    const middle = (aft + fore) / 2;
    // The arms end WAKE_REACH half-lengths astern of the middle, where they are widest.
    const astern = middle + WAKE_REACH * half;
    const wide = beam + (1 + WAKE_REACH) * half * Math.tan(WAKE.kelvin) + 1;
    this.#plan.value.set(middle, half, beam, Math.hypot(astern, wide));
    this.#ready = true;
  }

  /** Starts a frame's hulls. */
  begin(): void {
    this.#n = 0;
    this.count.value = 0;
  }

  /**
   * Adds a hull: where its waterline's origin would be in flat water, in
   * the scene, lifted by its heave; its heading, heel and pitch; and its
   * speed through the water, m/s.
   */
  add(
    x: number,
    y: number,
    z: number,
    heading: number,
    heel: number,
    pitch: number,
    speed = 0,
  ): void {
    if (!this.#ready || this.#n >= HULLS) {
      return;
    }
    (this.#places[this.#n] as Vector4).set(x, y + this.#shape.value.y, z, heading);
    (this.#tilts[this.#n] as Vector4).set(heel, pitch, Math.max(speed, 0), 0);
    this.#n++;
    this.count.value = this.#n;
  }

  /**
   * Whether a hull or its foam is near the scene point p (x and z): 1
   * within margin metres of where either reaches, else 0. For the vertex
   * stage, so that the fragments of a tile or a triangle with no hull near
   * skip the walk.
   */
  near(p: Node<'vec2'>, margin: number): Node<'float'> {
    const shape = this.#shape as unknown as Node<'vec4'>;
    const plan = this.#plan as unknown as Node<'vec4'>;
    return Fn(() => {
      const found = float(0).toVar();
      const reach = max(shape.z, plan.w).add(margin);
      Loop(int(this.count), ({ i }: { i: Node<'int'> }) => {
        const place = this.#placesNode.element(i) as unknown as Node<'vec4'>;
        const d = p.sub(place.xz);
        If(dot(d, d).lessThan(reach.mul(reach)), () => {
          found.assign(1);
        });
      });
      return found;
    })() as unknown as Node<'float'>;
  }

  /**
   * Leaves the fragment at the scene point p out if it lies in a hull. Call
   * it inside a fragment's function. near is what near() gave the
   * fragment's vertices: where it is 0 nothing is tested.
   */
  cut(p: Node<'vec3'>, near?: Node<'float'>): void {
    this.wet(p, near, false);
  }

  /**
   * Leaves the fragment at p out if it lies in a hull, as cut does, and
   * returns the foam the hulls make there, 0 and up. Call it inside a
   * fragment's function.
   */
  wet(p: Node<'vec3'>, near?: Node<'float'>, foam = true): Node<'float'> {
    const amount = float(0).toVar();
    if (near !== undefined) {
      If(near.greaterThan(0), () => {
        this.#walk(p, foam ? amount : null);
      });
    } else {
      this.#walk(p, foam ? amount : null);
    }
    return amount as unknown as Node<'float'>;
  }

  /** The foam a hull makes at a point of its own frame, on the water's plane: x to starboard, z aft. */
  #foam(m: Node<'vec3'>, speed: Node<'float'>): Node<'float'> {
    const plan = this.#plan as unknown as Node<'vec4'>;
    // Forward of the hull's middle, and off its centreline.
    const along = plan.x.sub(m.z);
    const off = abs(m.x);
    const half = plan.y;
    const beam = plan.z;
    // The ring: just outside the waterline, taken as an ellipse; more at the bow.
    const e = length(vec2(along.div(half), off.div(beam)));
    const ring = smoothstep(1.45, 1.0, e)
      .mul(smoothstep(0.85, 1.0, e))
      .mul(speed.mul(0.18).add(0.35))
      .mul(along.greaterThan(0).select(1.3, 0.8));
    // The arms: from the bow aft, each tan(arcsin ⅓) further out a metre.
    const back = max(half.sub(along), 0);
    const arm = beam.mul(0.9).add(back.mul(Math.tan(WAKE.kelvin)));
    const width = back.mul(0.04).add(0.25);
    const d = off.sub(arm).div(width);
    const arms = exp(d.mul(d).negate())
      .mul(along.lessThan(half.mul(1.02)).select(1, 0))
      .mul(smoothstep(half.mul(-WAKE_REACH), half.mul(0.2), along))
      .mul(clamp(speed.mul(0.22), 0, 1));
    return ring.add(arms) as unknown as Node<'float'>;
  }

  #walk(p: Node<'vec3'>, amount: Node<'float'> | null): void {
    const shape = this.#shape as unknown as Node<'vec4'>;
    const plan = this.#plan as unknown as Node<'vec4'>;
    const inside = float(0).toVar();
    // The hulls and the sea drop away from the boat alike: the test is
    // made with both where they would be on a flat world.
    const fromBoat = p.xz.sub(domeCentre);
    const level = vec3(p.x, p.y.add(dot(fromBoat, fromBoat).mul(1 / (2 * DOME_RADIUS))), p.z);
    Loop(int(this.count), ({ i }: { i: Node<'int'> }) => {
      const place = this.#placesNode.element(i) as unknown as Node<'vec4'>;
      const d = level.sub(place.xyz).toVar();
      if (amount !== null) {
        If(dot(d.xz, d.xz).lessThan(plan.w.mul(plan.w)), () => {
          const tilt = this.#tiltsNode.element(i) as unknown as Node<'vec4'>;
          // On the water the hull's heel and pitch are let be: its heading alone.
          const flat = inHull(vec3(d.x, 0, d.z), place.w, float(0), float(0));
          (amount as unknown as { addAssign(v: Node): void }).addAssign(this.#foam(flat, tilt.z));
        });
      }
      If(dot(d, d).lessThan(shape.z.mul(shape.z)), () => {
        const tilt = this.#tiltsNode.element(i) as unknown as Node<'vec4'>;
        // Into the hull's frame: the heading undone, then the pitch, then the heel.
        const m = inHull(d, place.w, tilt.y, tilt.x).toVar();
        const aft = (this.#stationsNode.element(int(0)) as unknown as Node<'vec4'>).x;
        const fore = (this.#stationsNode.element(int(STATIONS - 1)) as unknown as Node<'vec4'>).x;
        const y = m.y.add(shape.y);
        If(m.z.lessThan(aft).and(m.z.greaterThan(fore)), () => {
          const t = aft
            .sub(m.z)
            .div(aft.sub(fore))
            .mul(STATIONS - 1);
          const k = min(floor(t), STATIONS - 2);
          const f = t.sub(k);
          const a = this.#stationsNode.element(int(k)) as unknown as Node<'vec4'>;
          const b = this.#stationsNode.element(int(k).add(1)) as unknown as Node<'vec4'>;
          const beam = mix(a.y, b.y, f);
          const depth = mix(a.z, b.z, f);
          const below = min(max(y.negate().div(max(depth, 1e-4)), 0), 1);
          const side = pow(float(1).sub(pow(below, shape.x)), float(1).div(shape.x));
          If(
            y.greaterThan(depth.negate()).and(abs(m.x).lessThan(beam.mul(side).mul(HULL_FILL))),
            () => {
              inside.assign(1);
            },
          );
        });
      });
    });
    Discard(inside.greaterThan(0.5));
  }
}

/**
 * A scene vector from a boat's centre of gravity, in the boat's own frame:
 * the turns that place a boat (its heel, then its pitch, then its heading)
 * undone in reverse.
 */
const inHull = /* @__PURE__ */ Fn(
  ([d, heading, pitch, heel]: [Node<'vec3'>, Node<'float'>, Node<'float'>, Node<'float'>]) => {
    // The boat is turned by −heading about the vertical: undo it.
    const ch = heading.cos();
    const sh = heading.sin();
    const a = vec3(d.x.mul(ch).add(d.z.mul(sh)), d.y, d.z.mul(ch).sub(d.x.mul(sh)));
    // Pitched by +pitch about the axis to starboard: undo it.
    const cp = pitch.cos();
    const sp = pitch.sin();
    const b = vec3(a.x, a.y.mul(cp).add(a.z.mul(sp)), a.z.mul(cp).sub(a.y.mul(sp)));
    // Heeled by −heel about the axis aft: undo it.
    const cr = heel.cos();
    const sr = heel.sin();
    return vec3(b.x.mul(cr).sub(b.y.mul(sr)), b.x.mul(sr).add(b.y.mul(cr)), b.z);
  },
);

/** The sea's hulls: one set for the whole scene. */
export const hulls = new HullVolumes();
