// SPDX-License-Identifier: AGPL-3.0-only

// The other boats' parts, for drawing many at once: a model's solid
// primitives merged into one, each vertex carrying its material's colour,
// roughness and metalness, whether it is of the painted topsides (which
// take each boat's paint), and tagged with the joint it turns on (the
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
// reefed main drawn short, from each instance's values. A downwind sail
// (the model's `kite`) is shaped about its tack as a headsail, from its
// instance's clew, twist, ripple and hoist, drawn at nothing in its bag.
//
// A square rig (squarerig.ts): its yards' nodes are joints too, turned
// about their masts by the instance's yards, the wheel about its axle with
// the rudder; its square sails are one more part, each vertex carrying its
// sail's node, strip, height and reefs, bellied and turned with its yards.
// On a model with yards every mesh is drawn, under a joint or with the
// hull; the stern gallery's panes are marked, to be lit by night.

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
import { artUrl, FULL_CAMBER, GALLERY } from './boat';
import { type NamePlace, namePlace, numberedSail, TOPSIDES } from './boatlook';
import { chordAtHalf } from './machinemark';
import type { SailorColours } from './sailors/material';
import { loadSailor } from './sailors/model';
import {
  headsailFrame,
  type JibInputs,
  jibPoint,
  type KiteRig,
  kiteInputs,
  kitePoint,
  LUFF_OFFSET,
  type SailInputs,
  sailPoint,
} from './sailshape';
import {
  BELLY,
  SPRITSAIL,
  type SquareSail,
  shapeSquare,
  squarePoint,
  squareSails,
  squareVertex,
  toNode,
  unpackYards,
  WHEEL_TURNS,
  YARDS_ORDER,
  type YardsNode,
  yardDrop,
} from './squarerig';

/** The joints a vertex turns on, in its 'part' attribute. */
export const JOINT = {
  hull: 0,
  boom: 1,
  rudder: 2,
  wheel: 3,
  foreYards: 4,
  mainYards: 5,
  mizzenYards: 6,
  /** A yard of each yards' node that comes down as its sail's band is taken in. */
  foreYard: 7,
  mainYard: 8,
  mizzenYard: 9,
} as const;

/** The nodes under which each joint's parts are; the telltales and pennant are not drawn. */
const JOINTS: Record<string, number> = {
  hull: JOINT.hull,
  mast: JOINT.hull,
  daggerboard: JOINT.hull,
  boom: JOINT.boom,
  vang: JOINT.boom,
  rudder: JOINT.rudder,
  tiller: JOINT.rudder,
  wheel: JOINT.wheel,
  'fore-yards': JOINT.foreYards,
  'main-yards': JOINT.mainYards,
  'mizzen-yards': JOINT.mizzenYards,
};

/** The nodes never drawn in the fleet: too small to see. */
const UNDRAWN_NODES: Record<string, true> = { telltales: true, pennant: true };

/** A 'part' attribute's last value: 1 for the painted topsides, GALLERY_PART for the gallery's panes. */
export const GALLERY_PART = 2;

/** A headsail's cloth's coordinates (TEXCOORD_0) and its shape's (TEXCOORD_1), as one attribute of the fleet's. */
export const HEADSAIL_UV = 'headsailUv';

/** A geometry's two texture coordinates, as one vec4 a vertex: the cloth's, then the shape's. */
export function headsailUv(g: BufferGeometry): Float32BufferAttribute {
  const a = g.getAttribute('uv');
  const b = g.getAttribute('uv1') ?? a;
  const n = g.getAttribute('position').count;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = a?.getX(i) ?? 0;
    out[i * 4 + 1] = a?.getY(i) ?? 0;
    out[i * 4 + 2] = b?.getX(i) ?? 0;
    out[i * 4 + 3] = b?.getY(i) ?? 0;
  }
  return new Float32BufferAttribute(out, 4);
}

/** A headsail, in its frame at its tack: its geometry, its source material, its head's rake aft of its tack, its tack's place in the model, and its chord at half height. */
export interface Headsail {
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  rake: number;
  at: Vector3;
  /** Its chord at half its luff, as a fraction of its foot (machinemark.ts's chordAtHalf), read before its cloth's coordinates were packed. */
  chordHalf: number;
}

/** A model's parts, its solids merged. */
export interface BoatParts {
  /**
   * The solid parts: one geometry for each side drawn (front, or both),
   * its vertices' colours their materials' (linear, times their own), and
   * its 'part' the joint, the roughness, the metalness, and 1 for the
   * painted topsides; with one of its source materials.
   */
  solids: { geometry: BufferGeometry; material: MeshStandardMaterial }[];
  /** Where the hull carries its name, from its topsides, in the model's frame; null for none. */
  name: NamePlace | null;
  /** The node name of the sail that carries the sail number (boatlook.ts's numberedSail). */
  numbered: string;
  /** The sail, in its node's frame, and its source material. */
  sail: { geometry: BufferGeometry; material: MeshStandardMaterial } | null;
  /** The first headsail, in its node's frame at the tack, its source material, and how far aft of the tack its head is; null for none. */
  jib: Headsail | null;
  jibAt: Vector3;
  /** Every headsail, each in its own frame at its tack, and where that is in the model's frame. */
  jibs: Headsail[];
  /** The downwind sail's meshes, each in its frame at its tack (none for a model without one). */
  kites: Headsail[];
  /** Every named node's place in the model's frame: the lanterns', among others. */
  nodes: Map<string, Vector3>;
  /** Every named node, as loaded: what the sailor's seating reads. */
  objects: Map<string, Object3D>;
  /** The gooseneck, the rudder's stock and the sail's node, in the model's frame. */
  gooseneck: Vector3;
  stock: Vector3;
  /** A boat of two hulls' rudders' stocks, out from the centreline either side; 0 for one rudder. */
  rudderSpread: number;
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
  /**
   * A square rig's: its square sails in the model's frame (shapeSquare's
   * attributes, the cloth's uv) and their source material, the print's
   * sails; each yards' node's place (fore, main, mizzen, the spritsail's),
   * the wheel's; whether it has a gallery. null without square sails.
   */
  square: {
    geometry: BufferGeometry;
    material: MeshStandardMaterial;
    sails: SquareSail[];
  } | null;
  yardsAt: Vector3[];
  /** How far each yards' node's lowered yard comes down at its reef (fore, main, mizzen), and at which level, metres. */
  yardDrops: { drop: number; level: number }[];
  wheelAt: Vector3 | null;
  /** Two wheels': how far out each is; 0 for one on the centreline. */
  wheelSpread: number;
  gallery: boolean;
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
  return boatParts(await load(path), path);
}

/** A loaded model's parts, its solids merged. */
export function boatParts(scene: Object3D, path: string): BoatParts {
  scene.updateMatrixWorld(true);
  const sails = squareSails(scene);
  const squareMeshes = new Map<Object3D, SquareSail>();
  for (const s of sails) {
    for (const m of s.meshes) {
      squareMeshes.set(m, s);
    }
  }
  // The yards that come down with a reef: each its node's joint.
  const loweredYards = new Map<Object3D, number>();
  for (const s of sails) {
    const at = YARDS_ORDER.indexOf(s.node as YardsNode);
    if (s.yard !== null && at >= 0 && yardDrop(s) > 0) {
      loweredYards.set(s.yard, JOINT.foreYard + at);
    }
  }
  const squareGeometries: BufferGeometry[] = [];
  let squareMaterial: MeshStandardMaterial | null = null;
  // A model with yards draws every mesh; others leave out what no joint holds.
  const everything = sails.length > 0 || YARDS_ORDER.some((n) => scene.getObjectByName(n));
  const byMaterial = new Map<
    string,
    { geometries: BufferGeometry[]; material: MeshStandardMaterial }
  >();
  let sail: BoatParts['sail'] = null;
  const topsides: number[] = [];
  const parts: BoatParts = {
    solids: [],
    name: null,
    numbered: 'sail',
    sail: null,
    jib: null,
    jibAt: new Vector3(),
    jibs: [],
    kites: [],
    nodes: new Map(),
    objects: new Map(),
    gooseneck: new Vector3(),
    stock: new Vector3(),
    rudderSpread: 0,
    sailAt: new Vector3(),
    seatZ: 0,
    gunwale: new Vector3(0.7, 0.3, 0),
    seatIn: 0.3,
    hinge: null,
    grip: null,
    boardRoot: null,
    hullData: undefined,
    square: null,
    yardsAt: [...YARDS_ORDER, SPRITSAIL].map(() => new Vector3()),
    yardDrops: YARDS_ORDER.map(() => ({ drop: 0, level: 0 })),
    wheelAt: null,
    wheelSpread: 0,
    gallery: false,
  };
  scene.traverse((o) => {
    const yards = [...YARDS_ORDER, SPRITSAIL].indexOf(o.name as YardsNode);
    if (yards >= 0) {
      o.getWorldPosition(parts.yardsAt[yards] as Vector3);
    }
    if (o.name === 'wheel') {
      parts.wheelAt = o.getWorldPosition(new Vector3());
    }
    if (o.name === 'wheel-starboard') {
      parts.wheelSpread = o.getWorldPosition(new Vector3()).x - (parts.wheelAt?.x ?? 0);
    }
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
      case 'rudder-starboard':
        parts.rudderSpread = o.getWorldPosition(new Vector3()).x;
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
    const square = squareMeshes.get(o);
    if (square !== undefined) {
      // A square sail: shaped in its node's frame, kept in the model's.
      const g = shapeSquare(o.geometry.clone(), square, toNode(o, square, scene));
      g.applyMatrix4(o.matrixWorld);
      squareGeometries.push(keep(g, ['position', 'normal', 'uv', 'square']));
      squareMaterial ??= material;
      return;
    }
    const kite = within(o, { kite: true }) !== null;
    if (kite || within(o, { jib: true }) !== null) {
      // Each headsail is shaped in its own frame, at its tack: its
      // geometry taken there. Its two texture coordinates go in one
      // attribute (HEADSAIL_UV), so its draw keeps the model's normals,
      // which its lighting needs, within the vertex buffers a device must
      // allow. The downwind sail likewise, at its own tack.
      const frame = headsailFrame(o);
      scene.updateMatrixWorld(true);
      const inFrame = new Matrix4().copy(frame.node.matrixWorld).invert().multiply(o.matrixWorld);
      const g = o.geometry.clone().applyMatrix4(inFrame);
      g.setAttribute(HEADSAIL_UV, headsailUv(g));
      const chordHalf = chordAtHalf(g);
      keep(g, ['position', 'normal', HEADSAIL_UV]);
      const sail = {
        geometry: g,
        material,
        rake: frame.rake,
        at: frame.node.getWorldPosition(new Vector3()),
        chordHalf,
      };
      if (kite) {
        parts.kites.push(sail);
        return;
      }
      parts.jibs.push(sail);
      parts.jib ??= parts.jibs[0] ?? null;
      if (parts.jibs.length === 1) {
        frame.node.getWorldPosition(parts.jibAt);
      }
      return;
    }
    if (within(o, { sail: true }) !== null) {
      // The sail is shaped in its node's frame: its geometry stays there.
      o.getWorldPosition(parts.sailAt);
      sail = { geometry: keep(o.geometry.clone(), ['position', 'normal', 'uv', 'uv1']), material };
      return;
    }
    let joint = within(o, JOINTS);
    if (joint === 'tiller' && scene.getObjectByName('rudder-starboard') !== undefined) {
      // A boat of two hulls' crossbar and extension: carried across by the
      // rudders' arms, drawn still far off.
      joint = 'hull';
    }
    if ((joint === null && !everything) || within(o, UNDRAWN_NODES) !== null) {
      return;
    }
    let lowered: number | null = null;
    for (let p: Object3D | null = o; p !== null && lowered === null; p = p.parent) {
      lowered = loweredYards.get(p) ?? null;
    }
    const g = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    g.setAttribute('color', coloursOf(g, material));
    keep(g, ['position', 'normal', 'color']);
    const n = g.getAttribute('position').count;
    const painted = material.name === TOPSIDES;
    const gallery = within(o, { [GALLERY]: true }) !== null;
    parts.gallery ||= gallery;
    const part = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      part[i * 4] = lowered ?? (joint === null ? JOINT.hull : (JOINTS[joint] ?? 0));
      part[i * 4 + 1] = material.roughness;
      part[i * 4 + 2] = material.metalness;
      part[i * 4 + 3] = gallery ? GALLERY_PART : painted ? 1 : 0;
    }
    g.setAttribute('part', new Float32BufferAttribute(part, 4));
    if (painted) {
      const at = g.getAttribute('position');
      for (let i = 0; i < at.count; i++) {
        topsides.push(at.getX(i), at.getY(i), at.getZ(i));
      }
    }
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
  for (const s of sails) {
    const at = YARDS_ORDER.indexOf(s.node as YardsNode);
    if (s.yard !== null && at >= 0) {
      parts.yardDrops[at] = { drop: yardDrop(s), level: s.reef.reef };
    }
  }
  if (squareGeometries.length > 0 && squareMaterial !== null) {
    const merged = mergeGeometries(squareGeometries, false);
    if (merged === null) {
      throw new Error(`the square sails in ${path} do not merge`);
    }
    parts.square = { geometry: merged, material: squareMaterial, sails };
  }
  parts.name = namePlace(topsides, parts.objects.get('hull')?.userData);
  parts.numbered = numberedSail(parts.objects.values());
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
 * kite, read by the downwind sail alone: its clew's angle, its head's
 * twist (signed), its ripple, and how far it is hoisted (0 … 1).
 * lean's last carries the main's reef level too: 1 for a machine, plus 2
 * for each reef;
 * look, the boat's own (boatlook.ts): its paint's place, its cloth's, its
 * sail number (0 for none) and its name's row (−1 for none).
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
  kite?: Node<'vec4'>;
  look?: Node<'vec4'>;
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

/**
 * A kind's joints beyond its boom and rudder, for its solids: a square
 * rig's yards' places, its wheel's or wheels' (each turning on its own
 * hub, the spread out either side of the node's), and its rudder's stop,
 * degrees.
 */
export interface RigJoints {
  yardsAt: readonly Vector3[];
  yardDrops: readonly { drop: number; level: number }[];
  wheelAt: Vector3 | null;
  wheelSpread?: number;
  rudderAngle: number;
}

/**
 * A square rig's yards' turns on the GPU: the fore and after nodes' from
 * the instance's rig.w (squarerig.ts's packYards), which on a kind with
 * yards carries them in place of the sail's side (which its sail works out
 * from the boom).
 */
export function yardsOf(i: Instances): { fore: Node<'float'>; after: Node<'float'> } {
  return unpackYards(i.rig.w);
}

/** A solid part's vertex node: its joint turned, then the boat placed. */
export function solidNode(
  i: Instances,
  parts: BoatParts,
  cog: number,
  rig: RigJoints | null = null,
): Node<'vec3'> {
  const g = parts.gooseneck;
  const k = parts.stock;
  return Fn(() => {
    const joint = attribute('part', 'vec4').x;
    const p = positionGeometry;
    const n = normalGeometry;
    const pivotBoom = vec3(g.x, g.y, g.z);
    // A boat of two hulls' rudders each turn on their own hull's stock.
    const spread = parts.rudderSpread;
    const pivotRudder = spread > 0 ? vec3(p.x.sign().mul(spread), k.y, k.z) : vec3(k.x, k.y, k.z);
    const boomed = rotY(p.sub(pivotBoom), i.rig.x).add(pivotBoom);
    const ruddered = rotY(p.sub(pivotRudder), i.rig.y).add(pivotRudder);
    const isBoom = joint.greaterThan(JOINT.boom - 0.5).and(joint.lessThan(JOINT.boom + 0.5));
    const isRudder = joint.greaterThan(JOINT.rudder - 0.5);
    let local = select(isBoom, boomed, select(isRudder, ruddered, p));
    let turned = select(isBoom, rotY(n, i.rig.x), select(isRudder, rotY(n, i.rig.y), n));
    if (rig !== null) {
      // The wheel about its axle with the rudder, each yards' node about its mast.
      const yards = yardsOf(i);
      const stop = (rig.rudderAngle * Math.PI) / 180;
      const wheel = i.rig.y
        .div(stop > 0 ? stop : 1)
        .clamp(-1, 1)
        .mul(-WHEEL_TURNS * 2 * Math.PI);
      const w = rig.wheelAt ?? new Vector3();
      const ws = rig.wheelSpread ?? 0;
      const pivotWheel = ws > 0 ? vec3(p.x.sign().mul(ws), w.y, w.z) : vec3(w.x, w.y, w.z);
      const is = (j: number) => joint.greaterThan(j - 0.5).and(joint.lessThan(j + 0.5));
      local = select(is(JOINT.wheel), rotZ(p.sub(pivotWheel), wheel).add(pivotWheel), local);
      turned = select(is(JOINT.wheel), rotZ(n, wheel), turned);
      const nodes = [JOINT.foreYards, JOINT.mainYards, JOINT.mizzenYards];
      const level = reefOf(i);
      nodes.forEach((j, at) => {
        const y = rig.yardsAt[at] ?? new Vector3();
        const pivot = vec3(y.x, 0, y.z);
        const turn = at === 0 ? yards.fore : yards.after;
        local = select(is(j), rotY(p.sub(pivot), turn).add(pivot), local);
        turned = select(is(j), rotY(n, turn), turned);
        // Its lowered yard: turned with it, and down by its drop once reefed.
        const d = rig.yardDrops[at] ?? { drop: 0, level: 0 };
        if (d.drop > 0) {
          const down = select(level.greaterThan(d.level - 0.5), float(d.drop), float(0));
          const lowered = rotY(p.sub(pivot), turn)
            .add(pivot)
            .sub(vec3(0, down, 0));
          local = select(is(JOINT.foreYard + at), lowered, local);
          turned = select(is(JOINT.foreYard + at), rotY(n, turn), turned);
        }
      });
    }
    normalLocal.assign(placeNormal(turned, i));
    return placePoint(local, i, cog);
  })() as unknown as Node<'vec3'>;
}

/**
 * The square sails' vertex node: each vertex bellied as a drawing sail is
 * (the wire says nothing of their strips' wind), taken in by the
 * instance's reef, turned with its yards about its mast, then placed.
 */
export function squareNode(
  i: Instances,
  parts: BoatParts,
  cog: number,
  time: Node<'float'>,
): Node<'vec3'> {
  const yardsAt = parts.yardsAt;
  return Fn(() => {
    const sv = squareVertex();
    const node = sv.index.div(4).floor();
    const yards = yardsOf(i);
    const at = squarePoint(
      { depth: float(BELLY), ripple: float(0), reef: reefOf(i), time },
      sv,
      positionGeometry as unknown as Node<'vec3'>,
      uv().x,
      sv.down,
    );
    // Each node's mast, and its turn: the fore's, the after's, none for the spritsail's yard.
    const pick = (v: (k: number) => Node<'float'>): Node<'float'> =>
      select(
        node.lessThan(0.5),
        v(0),
        select(node.lessThan(1.5), v(1), select(node.lessThan(2.5), v(2), v(3))),
      ) as unknown as Node<'float'>;
    const px = pick((k) => float(yardsAt[k]?.x ?? 0));
    const pz = pick((k) => float(yardsAt[k]?.z ?? 0));
    const turn = pick((k) => (k === 0 ? yards.fore : k < 3 ? yards.after : float(0)));
    const pivot = vec3(px, 0, pz);
    normalLocal.assign(placeNormal(rotY(at.normal, turn), i));
    return placePoint(rotY(at.position.sub(pivot), turn).add(pivot), i, cog);
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
  twistTurn: number | null = null,
): Node<'vec3'> {
  const at = parts.sailAt;
  // On a kind with yards rig.w carries them: the side comes from the boom,
  // as the fleet's writer works it out for the others.
  const side =
    twistTurn === null
      ? i.rig.w
      : (i.rig.x.div((twistTurn * Math.PI) / 180).clamp(-1, 1) as unknown as Node<'float'>);
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
    side,
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

/** A headsail's vertex node: shaped about its stay from the instance's jib values, then placed. */
export function jibNode(
  i: Instances,
  headsail: Headsail,
  cog: number,
  footV: number,
  headV: number,
  time: Node<'float'>,
): Node<'vec3'> {
  const at = headsail.at;
  const j = i.jib ?? vec4(0);
  const rake = float(headsail.rake);
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
    const shape = attribute(HEADSAIL_UV, 'vec4');
    const fv = shape.w;
    const shaped = jibPoint(
      inputs,
      positionGeometry.z.sub(rake.mul(fv)),
      shape.z,
      fv,
      positionGeometry.y,
      rake,
    );
    normalLocal.assign(placeNormal(shaped.normal, i));
    return placePoint(shaped.position.add(vec3(at.x, at.y, at.z)), i, cog);
  })() as unknown as Node<'vec3'>;
}

/** The downwind sail's vertex node: shaped about its tack from the instance's kite values, as far as it is hoisted, then placed. */
export function kiteNode(
  i: Instances,
  kite: Headsail,
  cog: number,
  rig: KiteRig,
  time: Node<'float'>,
): Node<'vec3'> {
  const at = kite.at;
  const k = i.kite ?? vec4(0);
  const rake = float(kite.rake);
  const inputs = kiteInputs(k.x, k.y, k.z, k.z, k.w, rig, time);
  return Fn(() => {
    const shape = attribute(HEADSAIL_UV, 'vec4');
    const fv = shape.w;
    const shaped = kitePoint(
      inputs,
      positionGeometry.z.sub(rake.mul(fv)),
      shape.z,
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
  for (const j of [...parts.jibs, ...parts.kites]) {
    j.geometry.dispose();
  }
}
