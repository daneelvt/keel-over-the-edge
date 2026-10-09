// SPDX-License-Identifier: AGPL-3.0-only

// The other boats' parts, for drawing many at once: a model's primitives
// merged by material, each vertex tagged with the joint it turns on (the
// hull's frame, the boom about the gooseneck, the rudder about its stock),
// and the vertex nodes that place each instance. An instanced part cannot
// take its boat's transform from the instance matrix: the sail's own vertex
// node builds the sail from positionGeometry, which discards it (three.js
// r186, NodeMaterial.setupPosition applies the instance matrix to
// positionLocal before the material's positionNode). So every part's node
// applies its boat's pose itself, normals too, from per-instance values,
// exactly as the own boat's nodes are nested (boat.ts): the boom and rudder
// turned about their joints, the heel about the centre of gravity's height,
// then the heading and position; then the material factory's bend.

import {
  type BufferGeometry,
  Float32BufferAttribute,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute,
  cos,
  Fn,
  float,
  normalGeometry,
  normalLocal,
  positionGeometry,
  select,
  sin,
  uv,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { artUrl } from './boat';
import { LUFF_OFFSET, type SailInputs, sailPoint } from './sailshape';

/** The joints a vertex turns on, in its 'part' attribute. */
export const JOINT = { hull: 0, boom: 1, rudder: 2 } as const;

/** The nodes under which each joint's parts are; the telltales and pennant are not drawn. */
const JOINTS: Record<string, number> = {
  hull: JOINT.hull,
  mast: JOINT.hull,
  daggerboard: JOINT.hull,
  boom: JOINT.boom,
  vang: JOINT.boom,
  rudder: JOINT.rudder,
  tiller: JOINT.rudder,
};

/** A model's parts, merged by material. */
export interface BoatParts {
  /** The solid parts: one geometry a material, with its source material. */
  solids: { geometry: BufferGeometry; material: MeshStandardMaterial }[];
  /** The sail, in its node's frame, and its source material. */
  sail: { geometry: BufferGeometry; material: MeshStandardMaterial } | null;
  /** The gooseneck, the rudder's stock and the sail's node, in the model's frame. */
  gooseneck: Vector3;
  stock: Vector3;
  sailAt: Vector3;
  /** The seat's station along the boat, metres aft. */
  seatZ: number;
}

async function load(path: string): Promise<Object3D> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(artUrl(path));
  gltf.scene.updateMatrixWorld(true);
  return gltf.scene;
}

/** The named node a mesh is under, nearest first. */
function within(o: Object3D, names: Record<string, unknown>): string | null {
  for (let p: Object3D | null = o; p !== null; p = p.parent) {
    if (p.name in names) {
      return p.name;
    }
  }
  return null;
}

/** Keeps a geometry's named attributes, dropping the rest. */
function keep(g: BufferGeometry, names: string[]): BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (!names.includes(name)) {
      g.deleteAttribute(name);
    }
  }
  return g;
}

/** Loads a boat's model and merges its parts by material. */
export async function loadBoatParts(path: string): Promise<BoatParts> {
  const scene = await load(path);
  const byMaterial = new Map<
    string,
    { geometries: BufferGeometry[]; material: MeshStandardMaterial }
  >();
  let sail: BoatParts['sail'] = null;
  const parts: BoatParts = {
    solids: [],
    sail: null,
    gooseneck: new Vector3(),
    stock: new Vector3(),
    sailAt: new Vector3(),
    seatZ: 0,
  };
  scene.traverse((o) => {
    switch (o.name) {
      case 'boom':
        o.getWorldPosition(parts.gooseneck);
        break;
      case 'rudder':
        o.getWorldPosition(parts.stock);
        break;
      case 'sailor':
        parts.seatZ = o.position.z;
        break;
    }
    if (!(o instanceof Mesh)) {
      return;
    }
    const material = o.material as MeshStandardMaterial;
    if (within(o, { sail: true }) !== null) {
      // The sail is shaped in its node's frame: its geometry stays there.
      o.getWorldPosition(parts.sailAt);
      sail = { geometry: keep(o.geometry.clone(), ['position', 'normal', 'uv', 'uv1']), material };
      return;
    }
    const joint = within(o, JOINTS);
    if (joint === null) {
      return;
    }
    const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const colours = g.hasAttribute('color');
    keep(g, colours ? ['position', 'normal', 'color'] : ['position', 'normal']);
    const n = g.getAttribute('position').count;
    g.setAttribute(
      'part',
      new Float32BufferAttribute(new Float32Array(n).fill(JOINTS[joint] ?? 0), 1),
    );
    const key = `${material.name}/${colours}`;
    const entry = byMaterial.get(key) ?? { geometries: [], material };
    entry.geometries.push(g);
    byMaterial.set(key, entry);
  });
  for (const { geometries, material } of byMaterial.values()) {
    const merged = mergeGeometries(geometries, false);
    if (merged === null) {
      throw new Error(`the parts of ${material.name} in ${path} do not merge`);
    }
    parts.solids.push({ geometry: merged, material });
  }
  parts.sail = sail;
  return parts;
}

/** Loads a sailor's model and merges it into one geometry, in the figure's frame. */
export async function loadFigure(
  path: string,
): Promise<{ geometry: BufferGeometry; material: MeshStandardMaterial }> {
  const scene = await load(path);
  const geometries: BufferGeometry[] = [];
  let material: MeshStandardMaterial | null = null;
  scene.traverse((o) => {
    if (o instanceof Mesh) {
      geometries.push(
        keep((o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld), [
          'position',
          'normal',
        ]),
      );
      material = o.material as MeshStandardMaterial;
    }
  });
  const merged = mergeGeometries(geometries, false);
  if (merged === null || material === null) {
    throw new Error(`the sailor ${path} does not merge`);
  }
  return { geometry: merged, material };
}

/**
 * Each instance's values, as vec4 attribute nodes:
 * pose: scene x, scene z, heading, heel;
 * rig: boom, rudder, opacity, the side the sail fills to (−1 … 1);
 * sail: the head's twist (signed), camber, the foot's and head's ripple;
 * seat: the sailor's place, x, y, z in the model's frame, and facing;
 * lean: the sailor's tilt.
 */
export interface Instances {
  pose: Node<'vec4'>;
  rig: Node<'vec4'>;
  sail: Node<'vec4'>;
  seat: Node<'vec4'>;
  lean: Node<'vec4'>;
}

/** v turned about the vertical by angle a, as Object3D.rotation.y turns it. */
function rotY(v: Node<'vec3'>, a: Node<'float'>): Node<'vec3'> {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
}

/** v turned about the fore-and-aft axis by angle a, as Object3D.rotation.z turns it. */
function rotZ(v: Node<'vec3'>, a: Node<'float'>): Node<'vec3'> {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x.mul(c).sub(v.y.mul(s)), v.x.mul(s).add(v.y.mul(c)), v.z);
}

/**
 * The boat's pose on a point of its model: heeled about the centre of
 * gravity's height (positive heel puts the starboard side down: a turn of
 * −heel about the axis pointing aft), turned to the heading, and placed.
 */
function placePoint(p: Node<'vec3'>, i: Instances, cog: number): Node<'vec3'> {
  const pivot = vec3(0, cog, 0);
  const heeled = rotZ(p.sub(pivot), i.pose.w.negate()).add(pivot);
  return rotY(heeled, i.pose.z.negate()).add(vec3(i.pose.x, 0, i.pose.y));
}

function placeNormal(n: Node<'vec3'>, i: Instances): Node<'vec3'> {
  return rotY(rotZ(n, i.pose.w.negate()), i.pose.z.negate());
}

/** A solid part's vertex node: its joint turned, then the boat placed. */
export function solidNode(i: Instances, parts: BoatParts, cog: number): Node<'vec3'> {
  const g = parts.gooseneck;
  const k = parts.stock;
  return Fn(() => {
    const joint = attribute('part', 'float');
    const p = positionGeometry;
    const n = normalGeometry;
    const pivotBoom = vec3(g.x, g.y, g.z);
    const pivotRudder = vec3(k.x, k.y, k.z);
    const boomed = rotY(p.sub(pivotBoom), i.rig.x).add(pivotBoom);
    const ruddered = rotY(p.sub(pivotRudder), i.rig.y).add(pivotRudder);
    const isBoom = joint.greaterThan(JOINT.boom - 0.5).and(joint.lessThan(JOINT.boom + 0.5));
    const isRudder = joint.greaterThan(JOINT.rudder - 0.5);
    const local = select(isBoom, boomed, select(isRudder, ruddered, p));
    const turned = select(isBoom, rotY(n, i.rig.x), select(isRudder, rotY(n, i.rig.y), n));
    normalLocal.assign(placeNormal(turned, i));
    return placePoint(local, i, cog);
  })() as unknown as Node<'vec3'>;
}

/** The sail's vertex node: shaped as the own boat's is, from the instance's values, then placed. */
export function sailNode(
  i: Instances,
  parts: BoatParts,
  cog: number,
  footV: number,
  headV: number,
  time: Node<'float'>,
): Node<'vec3'> {
  const at = parts.sailAt;
  const inputs: SailInputs = {
    boom: i.rig.x,
    twist: i.sail.x,
    camber: i.sail.y,
    side: i.rig.w,
    rippleFoot: i.sail.z,
    rippleHead: i.sail.w,
    footV: float(footV),
    headV: float(headV),
    time,
  };
  return Fn(() => {
    const shaped = sailPoint(
      inputs,
      positionGeometry.z.sub(LUFF_OFFSET),
      uv(1).x,
      uv(1).y,
      positionGeometry.y,
    );
    normalLocal.assign(placeNormal(shaped.normal, i));
    return placePoint(shaped.position.add(vec3(at.x, at.y, at.z)), i, cog);
  })() as unknown as Node<'vec3'>;
}

/**
 * The sailor's vertex node: turned to face, tilted, put in its place in
 * the model's frame, then the boat placed (Euler order ZYX, as boat.ts
 * turns the figure).
 */
export function figureNode(i: Instances, cog: number): Node<'vec3'> {
  return Fn(() => {
    const p = rotZ(rotY(positionGeometry, i.seat.w), i.lean.x).add(i.seat.xyz);
    const n = rotZ(rotY(normalGeometry, i.seat.w), i.lean.x);
    normalLocal.assign(placeNormal(n, i));
    return placePoint(p, i, cog);
  })() as unknown as Node<'vec3'>;
}

/** Frees what a model's parts hold. */
export function disposeParts(parts: BoatParts): void {
  for (const s of parts.solids) {
    s.geometry.dispose();
    (s.material as Material).dispose();
  }
  parts.sail?.geometry.dispose();
}
