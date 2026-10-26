// SPDX-License-Identifier: AGPL-3.0-only

// The other boats, drawn many at once: for each kind, one InstancedMesh a
// material of its model, every boat of that kind an instance, with its pose,
// rig, sail and sailor in per-instance attributes that the parts' vertex
// nodes read (fleetparts.ts). Two levels of detail: the full model for the
// few nearest the camera, the far model, with few segments, for the rest.
// Boats fade in and out dithered (alphaHash), so they stay in the opaque
// pass, in the same draw, with no sorting. The telltales and pennant of
// other boats are too small to see, and not drawn; their sails carry the
// class insignia and no number. A machine sailor's sail carries the
// machine mark too (machinemark.ts): the fleet's cloth is drawn twice in
// one texture, plain above and marked below, and each instance's flag
// picks its half in the vertex stage, so the sail's fragments sample the
// cloth once, as without the mark.
//
// Each frame the fleet's drawn boats are written into the attributes'
// arrays, which, being dynamic, go to the GPU with each draw; nothing is
// allocated.

import {
  type CanvasTexture,
  type Color,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  type Material,
  type Vector3,
} from 'three';
import {
  float,
  instancedDynamicBufferAttribute,
  texture,
  uniform,
  uv,
  varying,
  vec2,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { Boat as BoatKind } from '../catalog';
import type { DrawnBoat } from '../game/fleet';
import { CLOTH, CLOTH_HEIGHT, CLOTH_WIDTH, clothTexture, FULL_CAMBER, paintCloth } from './boat';
import type { FloatingOrigin } from './coords';
import {
  type BoatParts,
  figureNode,
  type Instances,
  loadBoatParts,
  loadFigure,
  sailNode,
  solidNode,
} from './fleetparts';
import { chordAtHalf, type MarkPlace, markInk, markPlace, paintMark } from './machinemark';
import { litMaterial, sailGlow } from './materials';
import { placeSailor, SAILING, type SailorFrame, type SailorPlace } from './sailor';
import { FLOW_LUFFING } from './telltales';

/** The most boats drawn at once: a full view and as many fading out. */
export const FLEET_CAPACITY = 128;
/** The full model is drawn for at most this many boats, the nearest the camera... */
export const NEAR_MODELS = 12;
/** ...within this distance of it, metres. */
export const NEAR_RANGE = 60;

const DEG = Math.PI / 180;
/** How hard a luffing strip of another boat ripples, 0 to 1. */
const RIPPLE = 0.7;
/** Seconds over which a ripple grows and dies away. */
const RIPPLE_EASE = 0.25;

/** One level of detail: its meshes and their instances' values. */
class Level {
  readonly group = new Group();
  readonly meshes: InstancedMesh[] = [];
  readonly pose = attr();
  readonly rig = attr();
  readonly sail = attr();
  readonly seat = attr();
  readonly lean = attr();
  count = 0;

  readonly #nodes: Instances = {
    pose: node(this.pose),
    rig: node(this.rig),
    sail: node(this.sail),
    seat: node(this.seat),
    lean: node(this.lean),
  };

  constructor(readonly name: string) {
    this.group.name = name;
  }

  build(
    parts: BoatParts,
    figure: Awaited<ReturnType<typeof loadFigure>>,
    kind: BoatKind,
    cloth: CanvasTexture,
    time: Node<'float'>,
  ): void {
    const { hull, rig } = kind.physics;
    const cog = hull.centreOfGravity;
    const i = this.#nodes;
    for (const s of parts.solids) {
      const src = s.material;
      const m = litMaterial(
        {
          color: (src.color as Color).clone(),
          roughness: src.roughness,
          metalness: src.metalness,
          vertexColors: s.geometry.hasAttribute('color'),
          side: src.side === DoubleSide ? DoubleSide : FrontSide,
        },
        solidNode(i, parts, cog),
      );
      this.#add(s.geometry, m, src.name);
    }
    if (parts.sail !== null) {
      const m = litMaterial(
        { roughness: parts.sail.material.roughness, metalness: 0, side: DoubleSide },
        sailNode(i, parts, cog, rig.footStrip, rig.headStrip, time),
      );
      // The cloth's half: the plain one above, or, for a machine
      // sailor's boat, the marked one below.
      const at = varying(vec2(uv().x, uv().y.add(float(1).sub(i.lean.w)).mul(0.5)));
      const c = texture(cloth, at) as unknown as Node<'vec4'>;
      m.colorNode = c;
      m.emissiveNode = sailGlow(c);
      this.#add(parts.sail.geometry, m, 'sail');
    }
    const fm = figure.material;
    const m = litMaterial(
      { color: (fm.color as Color).clone(), roughness: fm.roughness, metalness: 0 },
      figureNode(i, cog),
    );
    this.#add(figure.geometry, m, 'sailor');
  }

  #add(
    geometry: InstancedMesh['geometry'],
    m: Material & { opacityNode?: unknown },
    name: string,
  ): void {
    // Faded boats are dithered: each fragment kept or dropped by a hash
    // against its instance's opacity, in the opaque pass.
    m.alphaHash = true;
    (m as unknown as { opacityNode: Node<'float'> }).opacityNode = this.#nodes.rig.z;
    m.name = `fleet ${this.name} ${name}`;
    const mesh = new InstancedMesh(geometry, m, FLEET_CAPACITY);
    mesh.name = m.name;
    mesh.count = 0;
    // The parts place themselves from the instances' values: the
    // instance matrices stay at the identity, and say nothing of where
    // the boats are.
    mesh.frustumCulled = false;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  commit(): void {
    for (const m of this.meshes) {
      m.count = this.count;
    }
    for (const b of [this.pose, this.rig, this.sail, this.seat, this.lean]) {
      b.needsUpdate = true;
    }
  }
}

function attr(): InstancedInterleavedBuffer {
  const b = new InstancedInterleavedBuffer(new Float32Array(FLEET_CAPACITY * 4), 4, 1);
  b.setUsage(DynamicDrawUsage);
  return b;
}

/**
 * An instance-stepped vec4 attribute of b, as three.js's own instance
 * matrices are made (nodes/accessors/Instance.js): on an
 * InstancedInterleavedBuffer, which both back ends step per instance.
 */
function node(b: InstancedInterleavedBuffer): Node<'vec4'> {
  return instancedDynamicBufferAttribute(b, 'vec4', 4, 0) as unknown as Node<'vec4'>;
}

export class FleetView {
  readonly root = new Group();
  readonly near = new Level('near');
  readonly far = new Level('far');
  /** World time, seconds, modulo 2π, for the luffing ripple. */
  readonly time = uniform(0);
  loaded = false;

  readonly #kind: BoatKind;
  readonly #frame: SailorFrame;
  readonly #place: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  /** Each view slot's ripple, foot and head, eased. */
  readonly #ripple = new Float32Array(64 * 2);
  /** Each view slot's sailor's side, kept while the sailor crosses. */
  readonly #side = new Float32Array(64);
  readonly #nearest = new Int32Array(NEAR_MODELS);
  readonly #nearestD = new Float64Array(NEAR_MODELS);

  constructor(kind: BoatKind) {
    this.#kind = kind;
    const { hull, foils } = kind.physics;
    this.root.name = 'fleet';
    this.root.add(this.near.group, this.far.group);
    this.#frame = {
      seatZ: 0,
      centreOfGravity: hull.centreOfGravity,
      boardZ: -foils.boardPosition,
      boardDepth: hull.hullDraught + 0.45 * foils.boardSpan,
    };
  }

  /** Loads both levels' models: the boat's and its sailor's, near and far. */
  async load(sailor: { model: string; far: string }): Promise<void> {
    const kind = this.#kind;
    const [nearParts, farParts, nearFigure, farFigure] = await Promise.all([
      loadBoatParts(kind.art.model),
      loadBoatParts(kind.art.far),
      loadFigure(sailor.model),
      loadFigure(sailor.far),
    ]);
    const { foot, luff } = kind.physics.rig;
    const mark = markPlace(foot, luff, chordAtHalf(nearParts.sail?.geometry));
    const cloth = fleetCloth(kind.name.slice(0, 1), mark);
    this.#frame.seatZ = nearParts.seatZ;
    this.near.build(nearParts, nearFigure, kind, cloth, this.time);
    this.far.build(farParts, farFigure, kind, cloth, this.time);
    this.loaded = true;
  }

  /**
   * Draws boats[0 … count) relative to the floating origin, the camera at
   * camera (scene); time is world time and dt the world time since the
   * last frame, s.
   */
  draw(
    boats: readonly DrawnBoat[],
    count: number,
    origin: FloatingOrigin,
    camera: Vector3,
    time: number,
    dt: number,
  ): void {
    this.time.value = time % (2 * Math.PI);
    // The nearest few within range get the full model.
    let nearN = 0;
    for (let i = 0; i < count; i++) {
      const b = boats[i] as DrawnBoat;
      if (b.opacity <= 0) {
        continue;
      }
      const dx = b.east - origin.world.x - camera.x;
      const dz = -(b.north - origin.world.y) - camera.z;
      const d = dx * dx + dz * dz;
      if (
        d > NEAR_RANGE * NEAR_RANGE ||
        (nearN === NEAR_MODELS && d >= (this.#nearestD[nearN - 1] ?? 0))
      ) {
        continue;
      }
      let k = Math.min(nearN, NEAR_MODELS - 1);
      while (k > 0 && (this.#nearestD[k - 1] ?? 0) > d) {
        this.#nearest[k] = this.#nearest[k - 1] ?? 0;
        this.#nearestD[k] = this.#nearestD[k - 1] ?? 0;
        k--;
      }
      this.#nearest[k] = i;
      this.#nearestD[k] = d;
      nearN = Math.min(nearN + 1, NEAR_MODELS);
    }
    this.near.count = 0;
    this.far.count = 0;
    const ease = dt > 0 ? 1 - Math.exp(-dt / RIPPLE_EASE) : 0;
    for (let i = 0; i < count; i++) {
      const b = boats[i] as DrawnBoat;
      if (b.opacity <= 0) {
        continue;
      }
      let near = false;
      for (let k = 0; k < nearN; k++) {
        if (this.#nearest[k] === i) {
          near = true;
        }
      }
      const level = near ? this.near : this.far;
      if (level.count < FLEET_CAPACITY) {
        this.#write(level, level.count++, b, origin, ease);
      }
    }
    this.near.commit();
    this.far.commit();
  }

  #write(level: Level, n: number, b: DrawnBoat, origin: FloatingOrigin, ease: number): void {
    const { rig, sailor } = this.#kind.physics;
    const o = n * 4;
    const pose = level.pose.array as Float32Array;
    pose[o] = b.east - origin.world.x;
    pose[o + 1] = -(b.north - origin.world.y);
    pose[o + 2] = b.heading;
    pose[o + 3] = b.heel;
    // The twist and the camber fall to the side the boom is on, turning
    // over as it crosses the centreline, and the twist grows as the sail
    // is flattened and as the boom goes out, as the physics has it.
    const turn = Math.max(-1, Math.min(1, b.boom / (rig.twistTurn * DEG)));
    const r = level.rig.array as Float32Array;
    r[o] = b.boom;
    r[o + 1] = b.rudder;
    r[o + 2] = b.opacity;
    r[o + 3] = turn;
    const flat = (b.sail & 15) / 15;
    const perFlat = ((rig.twistDepowered - rig.twistPowered) * DEG) / (1 - sailor.flattenMin);
    const twist =
      rig.twistPowered * DEG +
      perFlat * (1 - flat) +
      (rig.twistEased / rig.boomOut) * Math.abs(b.boom);
    let footRipple = 0;
    let headRipple = 0;
    if (b.slot >= 0) {
      const k = b.slot * 2;
      const foot = ((b.sail >> 4) & 3) === FLOW_LUFFING ? RIPPLE : 0;
      const head = ((b.sail >> 6) & 3) === FLOW_LUFFING ? RIPPLE : 0;
      footRipple = (this.#ripple[k] ?? 0) + (foot - (this.#ripple[k] ?? 0)) * ease;
      headRipple = (this.#ripple[k + 1] ?? 0) + (head - (this.#ripple[k + 1] ?? 0)) * ease;
      this.#ripple[k] = footRipple;
      this.#ripple[k + 1] = headRipple;
    }
    const s = level.sail.array as Float32Array;
    s[o] = twist * turn;
    s[o + 1] = FULL_CAMBER * (flat > 0 ? flat : 1);
    s[o + 2] = footRipple;
    s[o + 3] = headRipple;
    // The sailor: on the side they sat on last while crossing; one who
    // has not sat yet sits to windward, away from the boom.
    let side = b.slot >= 0 ? (this.#side[b.slot] ?? 0) : 0;
    if (b.mode === SAILING && Math.abs(b.sailor) > 0.05) {
      side = Math.sign(b.sailor);
    }
    if (side === 0) {
      side = b.boom > 0 ? -1 : 1;
    }
    if (b.slot >= 0) {
      this.#side[b.slot] = side;
    }
    const p = placeSailor(b.sailor, b.mode, b.heel, this.#frame, side, this.#place);
    const seat = level.seat.array as Float32Array;
    seat[o] = p.x;
    seat[o + 1] = p.y;
    seat[o + 2] = p.z;
    seat[o + 3] = p.facing;
    const lean = level.lean.array as Float32Array;
    lean[o] = p.tilt;
    lean[o + 1] = b.heave;
    lean[o + 2] = b.pitch;
    lean[o + 3] = b.machine === 1 ? 1 : 0;
  }

  /** The draw calls and triangles the fleet's meshes make this frame. */
  budget(): { drawCalls: number; triangles: number } {
    let drawCalls = 0;
    let triangles = 0;
    for (const level of [this.near, this.far]) {
      if (level.count === 0) {
        continue;
      }
      for (const m of level.meshes) {
        drawCalls++;
        const index = m.geometry.index;
        const n = index !== null ? index.count : m.geometry.getAttribute('position').count;
        triangles += (n / 3) * level.count;
      }
    }
    return { drawCalls, triangles };
  }
}

/**
 * The fleet's cloth: the sail's, with the insignia and no number, drawn
 * twice, one above the other; the lower carries the machine mark at its
 * place.
 */
export function fleetCloth(insignia: string, mark: MarkPlace): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CLOTH_WIDTH;
  canvas.height = 2 * CLOTH_HEIGHT;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  paintCloth(g, '', insignia);
  // The lower half, its seams kept out of the upper one.
  g.translate(0, CLOTH_HEIGHT);
  g.beginPath();
  g.rect(0, 0, CLOTH_WIDTH, CLOTH_HEIGHT);
  g.clip();
  paintCloth(g, '', insignia);
  paintMark(g, mark, CLOTH_WIDTH, CLOTH_HEIGHT, markInk(CLOTH));
  return clothTexture(canvas);
}
