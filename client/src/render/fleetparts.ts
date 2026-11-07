// SPDX-License-Identifier: AGPL-3.0-only

// The other boats' parts, for drawing many at once: a model's solid
// primitives merged into one, each vertex carrying its material's colour,
// roughness and metalness and tagged with the joint it turns on (the
// hull's frame, the boom about the gooseneck, the rudder about its stock),
// so a kind's solids are one draw a level whatever its materials; and the
// vertex nodes that place each instance. An instanced part cannot
// take its boat's transform from the instance matrix: the sail's own vertex
// node builds the sail from positionGeometry, which discards it (three.js
// r186, NodeMaterial.setupPosition applies the instance matrix to
// positionLocal before the material's positionNode). So every part's node
// applies its boat's pose itself, normals too, from per-instance values,
// exactly as the own boat's nodes are nested (boat.ts): the boom and rudder
// turned about their joints, the heel about the centre of gravity's height,
// then the heading and position; then the material factory's bend. A
// headsail is shaped about its stay as the sail is about the mast, and a
// reefed main drawn short, from each instance's values.

import {
  type BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
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
  vec4,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { artUrl, FULL_CAMBER } from './boat';
import type { SailorColours } from './sailors/material';
import { loadSailor } from './sailors/model';
import { type JibInputs, jibPoint, LUFF_OFFSET, type SailInputs, sailPoint } from './sailshape';

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

/** A model's parts, its solids merged. */
export interface BoatParts {
  /**
   * The solid parts: one geometry for each side drawn (front, or both),
   * its vertices' colours their materials' (linear, times their own), and
   * its 'part' the joint, the roughness and the metalness; with one of its
   * source materials.
   */
  solids: { geometry: BufferGeometry; material: MeshStandardMaterial }[];
  /** The sail, in its node's frame, and its source material. */
  sail: { geometry: BufferGeometry; material: MeshStandardMaterial } | null;
  /** The headsail, in its node's frame at the tack, its source material, and how far aft of the tack its head is; null for none. */
  jib: { geometry: BufferGeometry; material: MeshStandardMaterial; rake: number } | null;
  jibAt: Vector3;
  /** Every named node's place in the model's frame: the lanterns', among others. */
  nodes: Map<string, Vector3>;
  /** Every named node, as loaded: what the sailor's seating reads. */
  objects: Map<string, Object3D>;
  /** The gooseneck, the rudder's stock and the sail's node, in the model's frame. */
  gooseneck: Vector3;
  stock: Vector3;
  sailAt: Vector3;
  /** The seat's station along the boat, metres aft. */
  seatZ: number;
  /** The starboard gunwale at the seat's station, and the side deck's inner edge out from the centreline. */
  gunwale: Vector3;
  seatIn: number;
  /** The tiller extension's hinge and its grip (at rest), the daggerboard's root, and the hull's data (its solid). */
  hinge: Vector3 | null;
  grip: Vector3 | null;
  boardRoot: Vector3 | null;
  hullData: unknown;
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

/** A solid primitive's colours: its material's, times its own where it has them, three floats a vertex. */
function coloursOf(g: BufferGeometry, material: MeshStandardMaterial): Float32BufferAttribute {
  const n = g.getAttribute('position').count;
  const own = g.getAttribute('color');
  const c = material.color;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = c.r * (own === undefined ? 1 : own.getX(i));
    out[i * 3 + 1] = c.g * (own === undefined ? 1 : own.getY(i));
    out[i * 3 + 2] = c.b * (own === undefined ? 1 : own.getZ(i));
  }
  return new Float32BufferAttribute(out, 3);
}

/** Loads a boat's model and merges its solid parts. */
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
    jib: null,
    jibAt: new Vector3(),
    nodes: new Map(),
    objects: new Map(),
    gooseneck: new Vector3(),
    stock: new Vector3(),
    sailAt: new Vector3(),
    seatZ: 0,
    gunwale: new Vector3(0.7, 0.3, 0),
    seatIn: 0.3,
    hinge: null,
    grip: null,
    boardRoot: null,
    hullData: undefined,
  };
  scene.traverse((o) => {
    if (o.name !== '' && !parts.nodes.has(o.name)) {
      parts.nodes.set(o.name, o.getWorldPosition(new Vector3()));
      parts.objects.set(o.name, o);
    }
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
      case 'gunwale':
        o.getWorldPosition(parts.gunwale);
        break;
      case 'hull': {
        const c = (o.userData as { solid?: { cockpit?: { halfWidth?: number } } }).solid?.cockpit;
        parts.seatIn = c?.halfWidth ?? parts.seatIn;
        parts.hullData = o.userData;
        break;
      }
      case 'extension':
        parts.hinge = o.getWorldPosition(new Vector3());
        break;
      case 'grip':
        parts.grip = o.getWorldPosition(new Vector3());
        break;
      case 'board-root':
        parts.boardRoot = o.getWorldPosition(new Vector3());
        break;
    }
    if (!(o instanceof Mesh)) {
      return;
    }
    const material = o.material as MeshStandardMaterial;
    if (within(o, { jib: true }) !== null) {
      // The headsail is shaped in its node's frame, at the tack.
      let node: Object3D = o;
      while (node.name !== 'jib' && node.parent !== null) {
        node = node.parent;
      }
      node.getWorldPosition(parts.jibAt);
      const rake = (node.userData as { rake?: unknown }).rake;
      // Its normals are the shape's: the model's are not kept, so its
      // draw reads no more vertex buffers than a device must allow.
      parts.jib = {
        geometry: keep(o.geometry.clone(), ['position', 'uv', 'uv1']),
        material,
        rake: typeof rake === 'number' && Number.isFinite(rake) ? rake : 0,
      };
      return;
    }
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
    g.setAttribute('color', coloursOf(g, material));
    keep(g, ['position', 'normal', 'color']);
    const n = g.getAttribute('position').count;
    const part = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      part[i * 3] = JOINTS[joint] ?? 0;
      part[i * 3 + 1] = material.roughness;
      part[i * 3 + 2] = material.metalness;
    }
    g.setAttribute('part', new Float32BufferAttribute(part, 3));
    const key = material.side === DoubleSide ? 'double' : 'front';
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

/** The fleet's sailor: one rigid figure, its atlas and mask, and where it sits. */
export interface FleetFigure {
  /**
   * In the frame figureNode places it in: about its seat on the port side
   * deck, facing starboard (+x), as its file seats it on the starboard
   * side, turned half round.
   */
  geometry: BufferGeometry;
  atlas: Texture;
  mask: Texture;
  /** Its seat: out from the centreline and up, in the boat model's frame. */
  seatOut: number;
  seatY: number;
}

/**
 * Loads a sailor's far level, posed seated at the helm, as the fleet draws
 * it: set in the boat model by its place, about its seat (out at the side
 * deck's middle, up at the deck), turned to face +x; with its atlas and mask
 * (the renderer decides how they are transcoded).
 */
export async function loadFigure(
  url: string,
  renderer: WebGPURenderer,
  seatOut: number,
  seatY: number,
  seatZ: number,
  colours: SailorColours,
): Promise<FleetFigure> {
  const model = await loadSailor(url, renderer, colours);
  const geometry = seatFigure(
    model.root,
    model.meshes,
    model.places.get('place') ?? null,
    seatOut,
    seatY,
    seatZ,
  );
  return { geometry, atlas: model.atlas, mask: model.mask, seatOut, seatY };
}

/**
 * A far level's meshes as one geometry in figureNode's frame: set in the
 * boat model by the file's place (on the starboard side deck, facing port),
 * then about the seat at (seatOut, seatY, seatZ) turned half round, to face
 * +x from the port side as figureNode's facing 0 has it.
 */
export function seatFigure(
  root: Object3D,
  meshes: Mesh[],
  place: Matrix4 | null,
  seatOut: number,
  seatY: number,
  seatZ: number,
): BufferGeometry {
  root.updateMatrixWorld(true);
  const toSeat = new Matrix4()
    .makeRotationY(Math.PI)
    .multiply(new Matrix4().makeTranslation(-seatOut, -seatY, -seatZ))
    .multiply(place ?? new Matrix4());
  const geometries: BufferGeometry[] = [];
  for (const o of meshes) {
    const g = keep((o.geometry as BufferGeometry).clone(), ['position', 'normal', 'uv']);
    geometries.push(g.applyMatrix4(new Matrix4().multiplyMatrices(toSeat, o.matrixWorld)));
  }
  const merged = mergeGeometries(geometries, false);
  if (merged === null) {
    throw new Error('the sailor does not merge');
  }
  return merged;
}

/**
 * Each instance's values, as vec4 attribute nodes:
 * pose: scene x, scene z, heading, heel;
 * rig: boom, rudder, opacity, the side the sail fills to (−1 … 1);
 * sail: the head's twist (signed), camber, the foot's and head's ripple;
 * seat: the sailor's place, x, y, z in the model's frame, and facing;
 * lean: the sailor's tilt; then the boat's heave and its pitch; and 1 for
 * a machine sailor's boat, whose sail carries the machine mark;
 * main: the sailor's main colour (linear), and its look's layer;
 * skin: its skin colour, and 1 for a machine;
 * hair: its hair colour, and 1 where its figure is drawn rigid (all far
 * boats; near ones whose look's skinned figure has not loaded);
 * jib, read by the headsail alone: the clew's angle, the head's twist
 * (signed), the side it fills to (−1 … 1), and its ripple.
 * lean's last carries the main's reef level too: 1 for a machine, plus 2
 * for each reef.
 */
export interface Instances {
  pose: Node<'vec4'>;
  rig: Node<'vec4'>;
  sail: Node<'vec4'>;
  seat: Node<'vec4'>;
  lean: Node<'vec4'>;
  main: Node<'vec4'>;
  skin: Node<'vec4'>;
  hair: Node<'vec4'>;
  jib?: Node<'vec4'>;
}

/** An instance's flag of a machine sailor's boat, from lean's last value. */
export function machineOf(i: Instances): Node<'float'> {
  return i.lean.w.sub(i.lean.w.mul(0.5).floor().mul(2)) as unknown as Node<'float'>;
}

/** An instance's main's reef level, 0, 1 or 2, from lean's last value. */
export function reefOf(i: Instances): Node<'float'> {
  return i.lean.w.mul(0.5).floor() as unknown as Node<'float'>;
}

/** A kind's main's reefs, as the fleet's sail reads them: its shares, and whether it gathers (sailshape.ts). */
export interface SailReef {
  shares: readonly number[];
  gather: boolean;
  luff: number;
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

/** v turned about the axis to starboard by angle a, as Object3D.rotation.x turns it. */
function rotX(v: Node<'vec3'>, a: Node<'float'>): Node<'vec3'> {
  const c = cos(a);
  const s = sin(a);
  return vec3(v.x, v.y.mul(c).sub(v.z.mul(s)), v.y.mul(s).add(v.z.mul(c)));
}

/**
 * The boat's pose on a point of its model: heeled about the centre of
 * gravity's height (positive heel puts the starboard side down: a turn of
 * −heel about the axis pointing aft), pitched about it (positive lifts the
 * bow), turned to the heading, and placed, lifted by the heave.
 */
export function placePoint(p: Node<'vec3'>, i: Instances, cog: number): Node<'vec3'> {
  const pivot = vec3(0, cog, 0);
  const heeled = rotX(rotZ(p.sub(pivot), i.pose.w.negate()), i.lean.z).add(pivot);
  return rotY(heeled, i.pose.z.negate()).add(vec3(i.pose.x, i.lean.y, i.pose.y));
}

export function placeNormal(n: Node<'vec3'>, i: Instances): Node<'vec3'> {
  return rotY(rotX(rotZ(n, i.pose.w.negate()), i.lean.z), i.pose.z.negate());
}

/** A solid part's vertex node: its joint turned, then the boat placed. */
export function solidNode(i: Instances, parts: BoatParts, cog: number): Node<'vec3'> {
  const g = parts.gooseneck;
  const k = parts.stock;
  return Fn(() => {
    const joint = attribute('part', 'vec3').x;
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
  reef: SailReef = { shares: [1, 1, 1], gather: false, luff: 1 },
): Node<'vec3'> {
  const at = parts.sailAt;
  const level = reefOf(i);
  const [r0, r1, r2] = [reef.shares[0] ?? 1, reef.shares[1] ?? 1, reef.shares[2] ?? 1];
  const share = select(
    level.lessThan(0.5),
    float(r0),
    select(level.lessThan(1.5), float(r1), float(r2)),
  );
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
    reefShare: share as unknown as Node<'float'>,
    reefGather: float(reef.gather ? 1 : 0),
    luff: float(reef.luff),
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

/** The headsail's vertex node: shaped about its stay from the instance's jib values, then placed. */
export function jibNode(
  i: Instances,
  parts: BoatParts,
  cog: number,
  footV: number,
  headV: number,
  time: Node<'float'>,
): Node<'vec3'> {
  const at = parts.jibAt;
  const j = i.jib ?? vec4(0);
  const rake = float(parts.jib?.rake ?? 0);
  // A full camber: the wire says nothing of the headsail's flattening, and
  // reading the main's would take one more vertex buffer.
  const inputs: JibInputs = {
    boom: j.x,
    twist: j.y,
    camber: float(FULL_CAMBER),
    side: j.z,
    rippleFoot: j.w,
    rippleHead: j.w,
    footV: float(footV),
    headV: float(headV),
    time,
  };
  return Fn(() => {
    const fv = uv(1).y;
    const shaped = jibPoint(
      inputs,
      positionGeometry.z.sub(rake.mul(fv)),
      uv(1).x,
      fv,
      positionGeometry.y,
      rake,
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
  parts.jib?.geometry.dispose();
}
