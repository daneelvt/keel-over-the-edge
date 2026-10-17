// SPDX-License-Identifier: AGPL-3.0-only

// The wrecks: ships lost on the reefs, rocks and bars, each built from her
// rig and how long she has lain. A fresh wreck is whole, her masts
// standing; an old one has lost her upper works and her masts are stumps;
// of the oldest a few ribs are left along her keel. A wreck stranded lies
// on the reef or the rock heeled over, her keel on the bottom; one sunk
// lies on the bottom a few metres down, seen through the water as the
// shallows' bed is, dimmed by exp(−2 K h) there and back (Beer–Lambert),
// with a fresh one's masts standing out of the sea. Wrecks are not solid:
// a stranded hull lies where boats ground anyway, a sunk one below their
// keels. Every wreck known is merged into one mesh, and every sunk one's
// shadow into another: two draws.

import {
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, uniform, varying, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { PlaceAge, PlaceRig } from '../catalog/types.gen';
import type { PlaceSeen } from '../net/messages';
import type { FloatingOrigin } from './coords';
import { basicMaterial, litMaterial } from './materials';

/** The wood's colours, linear values: the hull's planking, and the inside and the ribs. */
const PLANKING = [0.09, 0.06, 0.035];
const INSIDE = [0.05, 0.035, 0.022];
const SPAR = [0.07, 0.05, 0.03];

/** A hull's depth below her sheer, as a share of her beam. */
const DEPTH = 0.42;

/** A wreck as the page keeps it, with the depth of the water she lies in. */
interface Held extends PlaceSeen {
  depth: number;
}

/** Colours a geometry's vertices. */
function paint(g: BufferGeometry, c: readonly number[]): BufferGeometry {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col.set(c, i * 3);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  if (g.getAttribute('uv') !== undefined) {
    g.deleteAttribute('uv');
  }
  if (g.getIndex() !== null) {
    return g.toNonIndexed();
  }
  return g;
}

/** A hull's half-breadth at x along her length, 0 at either end, as a share of her beam's half. */
function breadth(u: number): number {
  // Fuller aft than forward, as ships of the period were built.
  const v = u < 0 ? u * 0.85 : u;
  return Math.sqrt(Math.max(1 - v * v, 0));
}

/**
 * A hull, bow toward −z, her keel at y = 0: her sides from the sheer down
 * to the keel at stations along her length, kept from her stern to share
 * of her length, her sheer lowered to share of her depth.
 */
export function hullGeometry(length: number, beam: number, share: number): BufferGeometry {
  const stations = 14;
  const depth = beam * DEPTH;
  const height = depth * (0.4 + 0.6 * share);
  const pos: number[] = [];
  const kept = Math.max(Math.ceil(stations * share), 2);
  const at = (k: number): [number, number] => {
    const u = (k / stations) * 2 - 1; // −1 the stern, 1 the bow
    return [u, (-u * length) / 2];
  };
  for (let k = 0; k < kept; k++) {
    const [u0, z0] = at(k);
    const [u1, z1] = at(k + 1);
    const b0 = (beam / 2) * breadth(u0);
    const b1 = (beam / 2) * breadth(u1);
    // Each side: the sheer to the bilge to the keel.
    for (const side of [-1, 1]) {
      const rows = [
        [side * b0, height, z0, side * b1, height, z1],
        [side * b0 * 0.85, depth * 0.3, z0, side * b1 * 0.85, depth * 0.3, z1],
        [0, 0, z0, 0, 0, z1],
      ];
      for (let r = 0; r < rows.length - 1; r++) {
        const a = rows[r] as number[];
        const b = rows[r + 1] as number[];
        pos.push(
          a[0] ?? 0,
          a[1] ?? 0,
          a[2] ?? 0,
          b[0] ?? 0,
          b[1] ?? 0,
          b[2] ?? 0,
          a[3] ?? 0,
          a[4] ?? 0,
          a[5] ?? 0,
        );
        pos.push(
          a[3] ?? 0,
          a[4] ?? 0,
          a[5] ?? 0,
          b[0] ?? 0,
          b[1] ?? 0,
          b[2] ?? 0,
          b[3] ?? 0,
          b[4] ?? 0,
          b[5] ?? 0,
        );
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return paint(g, PLANKING);
}

/** A few ribs along a keel, of a hull's length and beam: what is left of the oldest wrecks. */
export function ribsGeometry(length: number, beam: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const keel = new CylinderGeometry(0.18, 0.18, length * 0.8, 5);
  keel.rotateX(Math.PI / 2);
  parts.push(paint(keel, INSIDE));
  const ribs = 9;
  const depth = beam * DEPTH;
  for (let k = 0; k < ribs; k++) {
    const u = (k / (ribs - 1)) * 1.4 - 0.7;
    const half = (beam / 2) * breadth(u) * 0.9;
    for (const side of [-1, 1]) {
      const rib = new CylinderGeometry(
        0.12,
        0.16,
        depth * (0.6 + 0.4 * Math.abs(Math.sin(k * 2.3))),
        4,
      );
      rib.translate(0, (depth * 0.5) / 2, 0);
      rib.rotateZ(-side * 0.5);
      rib.translate(side * half * 0.5, 0, (-u * length) / 2);
      parts.push(paint(rib, INSIDE));
    }
  }
  return mergeGeometries(parts) ?? new BufferGeometry();
}

/** A wreck's geometry in her own frame, bow toward −z, her keel at y = 0. */
export function wreckGeometry(rig: PlaceRig, age: PlaceAge): BufferGeometry {
  if (age.hull <= 0.4) {
    return ribsGeometry(rig.length, rig.beam);
  }
  const parts = [hullGeometry(rig.length, rig.beam, age.hull)];
  if (age.masts > 0) {
    for (let k = 0; k < rig.masts; k++) {
      const h = rig.mast * age.masts * (k === rig.masts - 1 ? 1 : 0.85);
      const mast = new CylinderGeometry(0.16, 0.24, h, 6);
      const z =
        rig.masts === 1 ? -rig.length * 0.1 : rig.length * (0.25 - (0.55 * k) / (rig.masts - 1));
      mast.translate(0, rig.beam * DEPTH * 0.6 + h / 2, z);
      parts.push(paint(mast, SPAR));
    }
  }
  return mergeGeometries(parts) ?? new BufferGeometry();
}

/** A mesh like the old one, of the geometries merged. */
function remade(parts: BufferGeometry[], old: Mesh): Mesh {
  const g =
    parts.length > 0 ? (mergeGeometries(parts) ?? new BufferGeometry()) : new BufferGeometry();
  const m = new Mesh(g, old.material);
  m.name = old.name;
  m.frustumCulled = false;
  m.renderOrder = old.renderOrder;
  return m;
}

export class Wrecks {
  /** What the scene holds: the wrecks' meshes, made again as wrecks become known. */
  readonly root = new Group();
  /** The wrecks stranded and sunk, and the sunk ones' shadows through the water. */
  mesh: Mesh;
  shadows: Mesh;
  /** The wrecks known, by place number. */
  readonly known = new Map<number, Held>();
  /** The water's attenuation, K per metre, as the shallows are drawn. */
  readonly attenuation = uniform(0.15);
  readonly #rigs: readonly PlaceRig[];
  readonly #ages: readonly PlaceAge[];
  readonly #wreck: number;
  /** The water's depth at a place, m, once the land there is had; null until then. */
  depthAt: (east: number, north: number) => number | null = () => null;
  #dirty = false;

  /** The catalog's rigs and ages, its index of the kind of place that is a wreck, and the water's attenuation. */
  constructor(
    rigs: readonly PlaceRig[],
    ages: readonly PlaceAge[],
    wreck: number,
    attenuation: number,
  ) {
    this.#rigs = rigs;
    this.#ages = ages;
    this.#wreck = wreck;
    this.attenuation.value = attenuation;
    const m = litMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: DoubleSide });
    m.name = 'wrecks';
    this.mesh = new Mesh(new BufferGeometry(), m);
    this.mesh.name = 'wrecks';
    this.mesh.frustumCulled = false;
    // A sunk wreck's shadow on the sea: dark, and as much of it as the
    // water lets through, there and back.
    const s = basicMaterial({ transparent: true, depthWrite: false });
    s.name = 'wreck shadows';
    const h = attribute('depth', 'float') as unknown as Node<'float'>;
    const seen = varying(h.mul(this.attenuation).mul(-2).exp().mul(0.75));
    s.fragmentNode = vec4(0.012, 0.018, 0.02, seen) as unknown as Node<'vec4'>;
    s.polygonOffset = true;
    s.polygonOffsetFactor = -2;
    this.shadows = new Mesh(new BufferGeometry(), s);
    this.shadows.name = 'wreck shadows';
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 2;
    this.root.name = 'wrecks';
  }

  /** Places handed with their chunks: the wrecks among them are kept. */
  setPlaces(places: readonly PlaceSeen[]): void {
    for (const p of places) {
      if (p.kind === this.#wreck && !this.known.has(p.number)) {
        this.known.set(p.number, { ...p, depth: Number.NaN });
        this.#dirty = true;
      }
    }
  }

  /** Forgets every wreck: a new world. */
  clear(): void {
    this.known.clear();
    this.#dirty = true;
  }

  /** Builds the wrecks again once one is new or the water under one is known, and follows the floating origin. */
  frame(origin: FloatingOrigin): void {
    for (const w of this.known.values()) {
      if (Number.isNaN(w.depth)) {
        const d = this.depthAt(w.east, w.north);
        if (d !== null) {
          w.depth = Math.max(d, 0);
          this.#dirty = true;
        }
      }
    }
    if (this.#dirty) {
      this.#build();
    }
    const o = origin.world;
    this.root.position.set(-o.x, 0, o.y);
  }

  #build(): void {
    this.#dirty = false;
    const solid: BufferGeometry[] = [];
    const shade: BufferGeometry[] = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const fore = new Vector3(0, 0, -1);
    for (const w of this.known.values()) {
      if (Number.isNaN(w.depth)) {
        continue;
      }
      const rig = this.#rigs[w.rig] ?? this.#rigs[0];
      const age = this.#ages[w.age] ?? this.#ages[0];
      if (rig === undefined || age === undefined) {
        continue;
      }
      const g = wreckGeometry(rig, age);
      // Her bow toward her heading, heeled about her keel, her keel on
      // the bottom.
      q.setFromAxisAngle(up, -w.heading);
      const heel = new Quaternion().setFromAxisAngle(fore, w.sunk ? w.heel * 0.3 : w.heel);
      q.multiply(heel);
      m.compose(new Vector3(w.east, -w.depth, -w.north), q, new Vector3(1, 1, 1));
      g.applyMatrix4(m);
      solid.push(g);
      if (w.sunk) {
        // Her shadow, her outline at the sea's surface.
        const s = hullGeometry(rig.length, rig.beam, Math.max(age.hull, 0.5));
        s.applyMatrix4(new Matrix4().makeScale(1, 0, 1));
        s.applyMatrix4(
          new Matrix4().compose(
            new Vector3(w.east, 0.05, -w.north),
            new Quaternion().setFromAxisAngle(up, -w.heading),
            new Vector3(1, 1, 1),
          ),
        );
        const n = s.getAttribute('position').count;
        s.setAttribute('depth', new Float32BufferAttribute(new Float32Array(n).fill(w.depth), 1));
        s.deleteAttribute('color');
        s.deleteAttribute('normal');
        shade.push(s);
      }
    }
    // New meshes, not new geometries in the old: a renderer keeps what it
    // made for a mesh's first geometry.
    this.root.remove(this.mesh, this.shadows);
    this.mesh.geometry.dispose();
    this.shadows.geometry.dispose();
    this.mesh = remade(solid, this.mesh);
    this.shadows = remade(shade, this.shadows);
    if (solid.length > 0) {
      this.root.add(this.mesh);
    }
    if (shade.length > 0) {
      this.root.add(this.shadows);
    }
  }
}
