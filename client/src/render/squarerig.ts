// SPDX-License-Identifier: AGPL-3.0-only

// A square rig as it is drawn, on the player's boat and on the fleet's: the
// yards turned by the braces, the square sails bellied by the wind, taken
// in as the boat reefs, and the wheel turned with the rudder. What a kind's
// model says, never which kind it is.
//
// The yards. A model with square sails carries a node for each mast's
// yards (YARDS_NODES), at the mast's axis, its yards square across the boat
// at rest. The physics gives the yards' angle off the centreline, signed by
// the side they are braced for: positive braced for the wind over port,
// the port yardarm forward; from braced up sharp to square at ±π/2, which
// are the same yards. The node turns about the vertical by π/2 less the
// angle, the port arm forward for a positive angle (yardsTurn): in
// three.js's frame, the bow at −z and starboard at +x, a turn about +y by a
// negative angle brings the port arm (−x) forward. So the turn runs
// smoothly through 0 as the yards swing through square, and the fleet
// blends its samples by their turns, never their angles.
//
// The square sails. Each is a flat grid in its yards' node's plane, across
// the boat and upright, its cloth's u from the port arm to the starboard
// and v from the head to the foot, with its extras {"square": {"group",
// "strip", "sail"}}. Each vertex is given, as the model is loaded, its
// sail's shape coordinates (u, and v measured down from the head over its
// sail's height) and a 'square' attribute: which strip's wind it fills
// with (slot) and which node it turns with, its sail's height, how it is
// taken in, and whether it carries the sail number. On the GPU the cloth
// bellies forward, ahead of its yard, deepest at the foot's middle and
// held at the yard and the clews; aback it lies flat back against the
// mast; lifting, a ripple runs across it. Reefed, a topgallant is furled
// up on its yard (one reef), a topsail's reef bands are taken in, its
// cloth above the band gathered at its yard lowered to the band (two), and
// a spritsail, a square sail under the bowsprit, is furled on its yard
// (two). Which sail a mesh is comes from its extras' "sail", or else from
// its place among its node's sails: of three or more the highest is the
// topgallant and the next the topsail, of fewer the highest is the
// topsail; the rest are courses, never taken in.
//
// The wheel. A node 'wheel' with its axle fore and aft (its local z): it
// turns WHEEL_TURNS each way from amidships to the rudder's stop, the
// top of the wheel to the side the bow is to go, as wheel ropes lead.

import {
  type BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  type Mesh,
  type Object3D,
  Vector3,
} from 'three';
import {
  attribute,
  clamp,
  cos,
  float,
  floor,
  max,
  mix,
  normalize,
  select,
  sin,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { yardsTurn } from '../predict/blend';

/** The nodes of a model's yards, and which of the physics's yards each follows. */
export const YARDS_NODES = {
  'fore-yards': 'fore',
  'main-yards': 'after',
  'mizzen-yards': 'after',
} as const;
export type YardsNode = keyof typeof YARDS_NODES;
/** The nodes' order, as the fleet's vertices name them; the spritsail's yard is fixed, after them. */
export const YARDS_ORDER: readonly YardsNode[] = ['fore-yards', 'main-yards', 'mizzen-yards'];
/** The node of a spritsail, under the bowsprit: its yard is fixed across the boat. */
export const SPRITSAIL = 'spritsail';
/** The fleet's vertices' node index of a spritsail, after the yards'. */
export const SPRITSAIL_INDEX = 3;

export { yardsTurn };

/** How many turns the wheel makes each way, amidships to the rudder's stop. */
export const WHEEL_TURNS = 1.25;

/**
 * The wheel's turn about its axle, radians, as Object3D.rotation.z takes it,
 * for the rudder's angle (radians, positive turning the bow to starboard)
 * and its stop (degrees): the top of the wheel goes to starboard (seen
 * from aft, clockwise: a negative turn about +z) for a positive rudder.
 */
export function wheelTurn(rudder: number, rudderAngle: number): number {
  const stop = (rudderAngle * Math.PI) / 180;
  if (!(stop > 0)) {
    return 0;
  }
  const share = Math.max(-1, Math.min(1, rudder / stop));
  return -share * WHEEL_TURNS * 2 * Math.PI;
}

// --- The square sails' wind ----------------------------------------------------

/** A drawing square sail's belly at its foot's middle, as a share of its height. */
export const BELLY = 0.17;
/** Aback, the cloth lies back against the mast and stays: this share of its height, aft. */
export const ABACK = 0.04;
/** Lifting, the belly keeps this share, and the cloth ripples this hard (0 … 1). */
const LIFTING_BELLY = 0.55;
const LIFTING_RIPPLE = 0.8;
/** The flows' codes, as the physics gives them. */
const FLOW_LUFFING = 0;
const FLOW_ABACK = 3;

/** A strip of square sails' belly (a share of the sails' height, forward; negative aback) and ripple. */
export interface Belly {
  depth: number;
  ripple: number;
}

/**
 * How a strip of square sails fills, from its angle of attack (negative
 * aback) and its flow: drawing, bellied forward ahead of the yard; lifting
 * (luffing), less full and rippling; aback, back against the mast.
 */
export function squareBelly(attack: number, flow: number, out: Belly): Belly {
  if (flow === FLOW_ABACK || attack < 0) {
    out.depth = -ABACK;
    out.ripple = 0;
  } else if (flow === FLOW_LUFFING) {
    out.depth = BELLY * LIFTING_BELLY;
    out.ripple = LIFTING_RIPPLE;
  } else {
    out.depth = BELLY;
    out.ripple = 0;
  }
  return out;
}

// --- The square sails in a model ------------------------------------------------

/** How a sail is taken in: furled whole from one reef level, or its band taken in at another. */
export interface SailReef {
  /** The reef level from which it is furled up on its yard; 0 never. */
  furl: number;
  /** The reef level at which its reef band is taken in, and the band's height down from its head (a share of its height); 0 never. */
  reef: number;
  band: number;
}

/** A square sail of a model, as found in it. */
export interface SquareSail {
  meshes: Mesh[];
  /** The node it turns with: one of YARDS_NODES, or SPRITSAIL. */
  node: string;
  /** Which strip's wind fills it: 0 the fore group's foot, 1 its head, 2 the after group's foot, 3 its head. */
  slot: number;
  /** What sail it is: course, topsail, topgallant, spritsail. */
  sail: string;
  reef: SailReef;
  /** Whether it carries the sail number. */
  numbered: boolean;
  /** Its head's and foot's heights in its node's frame, and its greatest width, metres. */
  head: number;
  foot: number;
  width: number;
  /** Its yard, where the model has it as a node of its own ({"yard": sail}): lowered as its band is taken in. */
  yard: Object3D | null;
  /**
   * Where it changes from the lower strip to the upper, as its cloth's v,
   * for a sail that spans both (a topsail): below it its vertices fill
   * with the group's foot strip, above with its head; null for one strip.
   */
  split: number | null;
}

/** How far a sail's yard comes down with its band taken in all the way, metres. */
export function yardDrop(sail: SquareSail): number {
  return sail.reef.reef > 0 ? sail.reef.band * (sail.head - sail.foot) : 0;
}

/** How far a reef at a level (0 … 2, and between) has taken a sail's band in, 0 … 1. */
export function bandTaken(reef: SailReef, level: number): number {
  return reef.reef > 0 ? Math.min(Math.max(level - (reef.reef - 1), 0), 1) : 0;
}

/** The reef bands of a topsail with none told: double-reefed, the second band at this share of its height. */
const DEFAULT_BAND = 0.28;

interface SquareExtras {
  group?: unknown;
  strip?: unknown;
  sail?: unknown;
  /** Its reef bands' heights down from its head, as shares of it (either word). */
  reefBands?: unknown;
  reefs?: unknown;
  /** Where a sail that spans both strips changes from the lower to the upper: its cloth's v. */
  split?: unknown;
}

/** The node of a mesh's that carries an extra, nearest first, up to (not past) stop. */
function carrier(o: Object3D, key: string, stop: Object3D | null): Object3D | null {
  for (let p: Object3D | null = o; p !== null && p !== stop; p = p.parent) {
    if ((p.userData as Record<string, unknown>)[key] !== undefined) {
      return p;
    }
  }
  return null;
}

/** The meshes under a node. */
function meshesUnder(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((o) => {
    if ((o as Mesh).isMesh === true) {
      out.push(o as Mesh);
    }
  });
  return out;
}

/** A mesh's heights' range in a node's frame, and its width across. */
function heights(mesh: Mesh, node: Object3D): { lo: number; hi: number; width: number } {
  node.updateMatrixWorld(true);
  const toNode = node.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
  const p = mesh.geometry.getAttribute('position');
  const v = new Vector3();
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(toNode);
    lo = Math.min(lo, v.y);
    hi = Math.max(hi, v.y);
    left = Math.min(left, v.x);
    right = Math.max(right, v.x);
  }
  return { lo, hi, width: right - left };
}

/** The extent of a sail's meshes in a node's frame. */
function extent(meshes: Mesh[], node: Object3D): { lo: number; hi: number; width: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let width = 0;
  for (const m of meshes) {
    const h = heights(m, node);
    lo = Math.min(lo, h.lo);
    hi = Math.max(hi, h.hi);
    width = Math.max(width, h.width);
  }
  return { lo, hi, width };
}

/**
 * A model's square sails, from its yards' nodes and its spritsail: each
 * sail's meshes, its node, the strip it fills with, what sail it is and how
 * it is taken in, by its extras or its place among its node's sails.
 */
export function squareSails(root: Object3D): SquareSail[] {
  const out: SquareSail[] = [];
  const byName = new Map<string, Object3D>();
  root.traverse((o) => {
    if (o.name !== '' && !byName.has(o.name)) {
      byName.set(o.name, o);
    }
  });
  for (const name of YARDS_ORDER) {
    const node = byName.get(name);
    if (node === undefined) {
      continue;
    }
    // Each sail's meshes, by the sail its extras name, or each mesh its own.
    const sails = new Map<string, { meshes: Mesh[]; extras: SquareExtras; numbered: boolean }>();
    let unnamed = 0;
    for (const mesh of meshesUnder(node)) {
      const c = carrier(mesh, 'square', node);
      if (c === null) {
        continue;
      }
      const extras = (c.userData as { square: SquareExtras }).square;
      const key = typeof extras.sail === 'string' ? extras.sail : `#${unnamed++}`;
      const s = sails.get(key) ?? { meshes: [], extras, numbered: false };
      s.meshes.push(mesh);
      s.numbered ||= carrier(mesh, 'number', node) !== null;
      sails.set(key, s);
    }
    const found = [...sails.values()].map((s) => ({ ...s, ...extent(s.meshes, node) }));
    // Highest first: the topgallant of three or more, else the topsail.
    found.sort((a, b) => b.hi - a.hi);
    found.forEach((s, rank) => {
      const word = typeof s.extras.sail === 'string' ? s.extras.sail : null;
      const sail =
        word ??
        (found.length >= 3
          ? rank === 0
            ? 'topgallant'
            : rank === 1
              ? 'topsail'
              : 'course'
          : rank === 0
            ? 'topsail'
            : 'course');
      const group = s.extras.group === 'fore' ? 0 : s.extras.group === 'after' ? 1 : null;
      const g = group ?? (YARDS_NODES[name] === 'fore' ? 0 : 1);
      const strip = s.extras.strip === 1 ? 1 : 0;
      const told = s.extras.reefBands ?? s.extras.reefs;
      const bands = Array.isArray(told) ? (told as unknown[]) : [];
      const band = bands.filter((b): b is number => typeof b === 'number' && b > 0 && b < 1);
      out.push({
        meshes: s.meshes,
        node: name,
        slot: g * 2 + strip,
        sail,
        reef:
          sail === 'topgallant'
            ? { furl: 1, reef: 0, band: 0 }
            : sail === 'topsail'
              ? { furl: 0, reef: 2, band: band[band.length - 1] ?? DEFAULT_BAND }
              : { furl: 0, reef: 0, band: 0 },
        numbered: s.numbered,
        head: s.hi,
        foot: s.lo,
        width: s.width,
        yard: yardOf(node, sail),
        split:
          typeof s.extras.split === 'number' && s.extras.split > 0 && s.extras.split < 1
            ? s.extras.split
            : null,
      });
    });
  }
  const sprit = byName.get(SPRITSAIL);
  if (sprit !== undefined) {
    const meshes = meshesUnder(sprit);
    if (meshes.length > 0) {
      const { lo, hi, width } = extent(meshes, sprit);
      const furl = (sprit.userData as { furl?: unknown }).furl;
      out.push({
        meshes,
        node: SPRITSAIL,
        slot: 0,
        sail: 'spritsail',
        reef: { furl: typeof furl === 'number' ? furl : 2, reef: 0, band: 0 },
        numbered: false,
        head: hi,
        foot: lo,
        width,
        yard: null,
        split: null,
      });
    }
  }
  return out;
}

/** The node under a yards' node that is a sail's yard, by its extras' word; null for none. */
function yardOf(node: Object3D, sail: string): Object3D | null {
  let found: Object3D | null = null;
  node.traverse((o) => {
    if (found === null && (o.userData as { yard?: unknown }).yard === sail) {
      found = o;
    }
  });
  return found;
}

/** A sail's node's index, as the fleet's vertices carry it. */
export function nodeIndex(node: string): number {
  const i = YARDS_ORDER.indexOf(node as YardsNode);
  return i >= 0 ? i : SPRITSAIL_INDEX;
}

/** A sail's reef and number packed in one value: furl + 3·reef + 9 if numbered. */
export function packRule(reef: SailReef, numbered: boolean): number {
  return reef.furl + 3 * reef.reef + (numbered ? 9 : 0);
}

/** The matrix that takes a mesh's own frame to its sail's node's. */
export function toNode(mesh: Mesh, sail: SquareSail, root: Object3D): Matrix4 {
  let node: Object3D | null = null;
  root.traverse((o) => {
    if (node === null && o.name === sail.node) {
      node = o;
    }
  });
  root.updateMatrixWorld(true);
  const m = new Matrix4();
  if (node === null) {
    return m;
  }
  return m
    .copy((node as Object3D).matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld);
}

/** A sail's band is packed beside its rule (packRule, a whole number) as this share of it. */
const BAND_PACK = 0.9;

/**
 * Gives a sail's mesh's geometry its 'square' attribute: node × 4 + slot,
 * the sail's height, its rule (packRule) with its band (BAND_PACK of it
 * beside), and each vertex's height down from the sail's head as a share
 * of its height (from the vertex's height in its node's frame, which
 * inNode takes the geometry's own frame to). Its cloth's u is its shape's
 * across. One attribute, so the fleet's draw keeps the model's normals
 * within the vertex buffers a device must allow.
 */
export function shapeSquare(g: BufferGeometry, sail: SquareSail, inNode: Matrix4): BufferGeometry {
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const height = Math.max(sail.head - sail.foot, 1e-3);
  const n = p.count;
  const square = new Float32Array(n * 4);
  const node = nodeIndex(sail.node);
  const rule = packRule(sail.reef, sail.numbered);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(inNode);
    // A sail spanning both strips: its cloth below the split the lower's.
    const slot =
      sail.split === null || uv === undefined
        ? sail.slot
        : sail.slot - (sail.slot % 2) + (uv.getY(i) > sail.split ? 0 : 1);
    square[i * 4] = node * 4 + slot;
    square[i * 4 + 1] = height;
    square[i * 4 + 2] = rule + BAND_PACK * Math.min(Math.max(sail.reef.band, 0), 1);
    square[i * 4 + 3] = Math.min(Math.max((sail.head - v.y) / height, 0), 1);
  }
  g.setAttribute('square', new Float32BufferAttribute(square, 4));
  return g;
}

/**
 * Whether a sail's front face (its triangles' winding's) reads its cloth's
 * u from right to left, seen from that face with the head up: then its
 * number's digits are laid out the other way on it (boatlook.ts).
 */
export function readsMirrored(g: BufferGeometry): boolean {
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const index = g.index;
  if (uv === undefined || p.count < 3) {
    return false;
  }
  const n = index === null ? p.count : index.count;
  const at = (k: number): number => (index === null ? k : index.getX(k));
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t + 2 < n; t += 3) {
    const [i, j, k] = [at(t), at(t + 1), at(t + 2)];
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, j).sub(a);
    c.fromBufferAttribute(p, k).sub(a);
    const normal = new Vector3().crossVectors(b, c);
    // The gradient of u across the triangle, in its plane.
    const du1 = uv.getX(j) - uv.getX(i);
    const du2 = uv.getX(k) - uv.getX(i);
    const dv1 = uv.getY(j) - uv.getY(i);
    const dv2 = uv.getY(k) - uv.getY(i);
    const det = du1 * dv2 - du2 * dv1;
    if (normal.lengthSq() < 1e-12 || Math.abs(det) < 1e-12) {
      continue;
    }
    // The direction u grows along: d(position)/du.
    const along = b
      .clone()
      .multiplyScalar(dv2)
      .sub(c.clone().multiplyScalar(dv1))
      .divideScalar(det);
    // Seen from the front face, looking along −normal with the head up
    // (+y), the viewer's right is (−normal) × up.
    const right = normal
      .clone()
      .negate()
      .cross(new Vector3(0, 1, 0));
    return along.dot(right) < 0;
  }
  return false;
}

// --- The square sails on the GPU ----------------------------------------------

/** The ripple's depth at most, metres; its waves across the sail, and how fast they run. */
const RIPPLE_DEPTH = 0.18;
/** A furled or reefed sail's gathered cloth stands this far forward of its yard, and this far down, metres. */
const BUNDLE_OUT = 0.35;
const BUNDLE_DOWN = 0.3;

/** What shapes a vertex of the square sails: the strip's belly and ripple, the reef level and the time. */
export interface SquareInputs {
  /** Its strip's belly (a share of the sail's height; negative aback) and ripple, 0 … 1. */
  depth: Node<'float'>;
  ripple: Node<'float'>;
  /** The reef level, 0 … 2, and between as it comes in. */
  reef: Node<'float'>;
  /** World time, seconds, modulo 2π. */
  time: Node<'float'>;
}

/** A vertex's packed 'square' values, decoded. */
export interface SquareVertex {
  /** node × 4 + slot. */
  index: Node<'float'>;
  height: Node<'float'>;
  furl: Node<'float'>;
  reef: Node<'float'>;
  band: Node<'float'>;
  numbered: Node<'float'>;
  /** The vertex's height down from its sail's head, a share of the sail's height. */
  down: Node<'float'>;
}

/** The 'square' attribute's values. */
export function squareVertex(): SquareVertex {
  const a = attribute('square', 'vec4') as unknown as Node<'vec4'>;
  // The rule's whole number, and the band beside it (under BAND_PACK).
  const r = floor(a.z.add(1e-3));
  const numbered = select(r.greaterThan(8.5), float(1), float(0));
  const k = r.sub(numbered.mul(9));
  const reef = floor(k.div(3).add(0.01));
  return {
    index: a.x,
    height: a.y,
    furl: k.sub(reef.mul(3)),
    reef,
    band: a.z.sub(r).div(BAND_PACK) as unknown as Node<'float'>,
    numbered: numbered as unknown as Node<'float'>,
    down: a.w,
  };
}

/**
 * A square sail's vertex shaped: from its place p on the flat sail, in its
 * node's frame (forward −z), its shape coordinates (u across, v down from
 * the head) and its values. Returns its position and the normal of its
 * face toward +z (aft) at rest.
 */
export function squarePoint(
  t: SquareInputs,
  s: SquareVertex,
  p: Node<'vec3'>,
  u: Node<'float'>,
  v: Node<'float'>,
): { position: Node<'vec3'>; normal: Node<'vec3'> } {
  const h = s.height;
  const head = p.y.add(v.mul(h));
  // How far each of its reefs has come in, 0 … 1: furled up on its yard
  // from its furl level; its band taken in at its reef level.
  const furled = select(s.furl.greaterThan(0.5), clamp(t.reef.sub(s.furl.sub(1)), 0, 1), float(0));
  const reefed = select(s.reef.greaterThan(0.5), clamp(t.reef.sub(s.reef.sub(1)), 0, 1), float(0));
  const cut = s.band.mul(reefed);
  // The yard comes down to the band; the cloth above it is gathered there.
  const yard = head.sub(cut.mul(h));
  const gathered = v.lessThan(cut);
  // Furled, every height comes up toward the yard.
  const y0 = select(gathered, yard, p.y);
  const y = mix(y0, yard, furled);
  // The live cloth: its share of the sail below the yard, 0 at the yard.
  const below = clamp(v.sub(cut).div(max(float(1).sub(cut), 1e-3)), 0, 1);
  const live = float(1)
    .sub(furled)
    .mul(select(gathered, float(0), float(1)));
  const across = sin(u.mul(Math.PI));
  // Deepest at the foot: held at the yard, the foot free between the clews.
  const down = float(1).sub(float(1).sub(below).mul(float(1).sub(below)));
  const sheet = live.mul(float(1).sub(cut));
  const belly = t.depth.mul(h).mul(across).mul(down).mul(sheet);
  const ripple = t.ripple
    .mul(RIPPLE_DEPTH)
    .mul(across)
    .mul(below)
    .mul(sin(u.mul(13).sub(t.time.mul(17)).add(below.mul(4))))
    .mul(sheet);
  // A furled or reefed sail's gathered cloth: a roll under and ahead of its yard.
  const rolled = max(furled, select(gathered, float(1), float(0))).mul(across.mul(0.5).add(0.5));
  const z = p.z.sub(belly).sub(ripple).sub(rolled.mul(BUNDLE_OUT));
  const dy = rolled.mul(BUNDLE_DOWN);
  // The slopes: across, d(belly)/dx with x spanning about twice the height;
  // down, d(belly)/dy.
  const dAcross = t.depth
    .mul(Math.PI / 2)
    .mul(cos(u.mul(Math.PI)))
    .mul(down)
    .mul(sheet);
  const dDown = t.depth
    .mul(across)
    .mul(float(2).mul(float(1).sub(below)))
    .mul(sheet);
  const normal = normalize(vec3(dAcross.negate(), dDown, 1));
  return {
    position: vec3(p.x, y.sub(dy), z) as unknown as Node<'vec3'>,
    normal: normal as unknown as Node<'vec3'>,
  };
}

/** The fleet's yards' turns packed in one value: each to 4,096 steps over a half turn. */
export const YARDS_STEPS = 4096;

/** Packs the fore and after yards' turns (radians, −π/2 … π/2) in one float32-exact value. */
export function packYards(fore: number, after: number): number {
  const q = (a: number): number =>
    Math.round((Math.max(-0.5, Math.min(0.5, a / Math.PI)) + 0.5) * (YARDS_STEPS - 1));
  return q(fore) * YARDS_STEPS + q(after);
}

/** The fore and after yards' turns from a packed value, on the GPU. */
export function unpackYards(packed: Node<'float'>): { fore: Node<'float'>; after: Node<'float'> } {
  const hi = floor(packed.div(YARDS_STEPS).add(0.5 / YARDS_STEPS));
  const lo = packed.sub(hi.mul(YARDS_STEPS));
  const turn = (q: Node<'float'>): Node<'float'> =>
    q
      .div(YARDS_STEPS - 1)
      .sub(0.5)
      .mul(Math.PI) as unknown as Node<'float'>;
  return { fore: turn(hi), after: turn(lo) };
}

/** The same, on the CPU: for the tests. */
export function unpackYardsCPU(packed: number): { fore: number; after: number } {
  const hi = Math.floor(packed / YARDS_STEPS + 0.5 / YARDS_STEPS);
  const lo = packed - hi * YARDS_STEPS;
  const turn = (q: number): number => (q / (YARDS_STEPS - 1) - 0.5) * Math.PI;
  return { fore: turn(hi), after: turn(lo) };
}
