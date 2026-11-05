// SPDX-License-Identifier: AGPL-3.0-only

// The other boats, drawn many at once: for each kind, one InstancedMesh a
// material of its model, every boat of that kind an instance, with its pose,
// rig, sail and sailor in per-instance values that the parts' vertex nodes
// read (fleetparts.ts). Two levels of detail: the full model for the few
// nearest the camera, the far model, with few segments, for the rest.
// Boats fade in and out dithered (alphaHash), so they stay in the opaque
// pass, in the same draw, with no sorting. The telltales and pennant of
// other boats are too small to see, and not drawn; their sails carry the
// class insignia and no number. A machine sailor's sail carries the
// machine mark too (machinemark.ts): the fleet's cloth is drawn twice in
// one texture, plain above and marked below, and each instance's flag
// picks its half in the vertex stage, so the sail's fragments sample the
// cloth once, as without the mark.
//
// The sailors (sailors/fleetsailors.ts): on the near boats, skinned and
// moving, every look in one draw; on the far ones, and on near ones whose
// look's moving figure has not loaded yet, rigid figures posed seated,
// every look in one draw a level. Each boat's sailor is drawn in its own
// look and colours; a look is loaded when a boat with it first comes into
// view (sailors/fleetlooks.ts), and until then the boat carries the first
// look's figure in its own colours.
//
// Each frame the fleet's drawn boats are written into the instances'
// values, which, being dynamic, go to the GPU with each draw; nothing is
// allocated.

import {
  type BufferGeometry,
  type CanvasTexture,
  type Color,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  type Material,
  type Mesh,
  type Texture,
  type Vector3,
} from 'three';
import {
  float,
  instancedDynamicBufferAttribute,
  instanceIndex,
  int,
  sin,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind, SailorArt } from '../catalog';
import type { DrawnBoat } from '../game/fleet';
import { CLOTH, CLOTH_HEIGHT, CLOTH_WIDTH, clothTexture, FULL_CAMBER, paintCloth } from './boat';
import type { FloatingOrigin } from './coords';
import { type BoatParts, type Instances, loadBoatParts, sailNode, solidNode } from './fleetparts';
import { chordAtHalf, type MarkPlace, markInk, markPlace, paintMark } from './machinemark';
import { litMaterial, sailGlow } from './materials';
import { placeSailor, SAILING, type SailorFrame, type SailorPlace } from './sailor';
import { type ArtFiles, type FleetLook, FleetLooks } from './sailors/fleetlooks';
import {
  NearSailors,
  nearSailorNodes,
  ROW_HEAD,
  rigidSailorNodes,
  SailorRows,
  swayOf,
} from './sailors/fleetsailors';
import { sailorMaterial } from './sailors/material';
import { hullSolid } from './sailors/solid';
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
  /** Each instance's sailor's row (fleetsailors.ts's first eight texels), which the rigid figures read. */
  readonly rows: SailorRows;
  count = 0;
  /** Of the boats drawn, how many are machine sailors'. */
  machines = 0;
  /** Of the boats drawn, how many carry a rigid figure (the rest are skinned). */
  rigid = 0;
  /** The sailors' triangles drawn, each boat's own look's. */
  sailorTriangles = 0;
  /** The rigid figures, every look's, one mesh; null until built. */
  figures: InstancedMesh | null = null;

  readonly nodes: Instances;

  constructor(
    readonly name: string,
    capacity: number,
  ) {
    this.group.name = name;
    this.rows = new SailorRows(ROW_HEAD, capacity, `fleet ${name} sailors`);
    this.nodes = {
      pose: node(this.pose),
      rig: node(this.rig),
      sail: node(this.sail),
      seat: node(this.seat),
      lean: node(this.lean),
      // The boats' meshes read none of the sailors' values.
      main: vec4(0),
      skin: vec4(0),
      hair: vec4(0),
    };
  }

  build(parts: BoatParts, kind: BoatKind, cloth: CanvasTexture, time: Node<'float'>): void {
    const { hull, rig } = kind.physics;
    const cog = hull.centreOfGravity;
    const i = this.nodes;
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
      this.add(s.geometry, m, src.name);
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
      this.add(parts.sail.geometry, m, 'sail');
    }
  }

  /**
   * The rigid figures: every look's far figure in one geometry, each
   * instance keeping its own look's where it carries a rigid figure, the
   * rest folded to a point.
   */
  buildFigures(
    looks: FleetLooks,
    geometry: BufferGeometry,
    cog: number,
    time: Node<'float'>,
  ): void {
    const n = rigidSailorNodes(this.rows.texture, int(instanceIndex), cog);
    const m = sailorMaterial(looks.atlas.texture as Texture, looks.mask.texture as Texture, {
      vertex: n.vertex,
      glow: lampPulse(time),
      instance: { ...n, users: { atlas: looks.atlas.users, mask: looks.mask.users } },
    });
    this.figures = this.add(geometry, m, 'sailor', n.opacity);
  }

  add(geometry: BufferGeometry, m: Material, name: string, opacity?: Node<'float'>): InstancedMesh {
    // Faded boats are dithered: each fragment kept or dropped by a hash
    // against its instance's opacity, in the opaque pass.
    m.alphaHash = true;
    (m as unknown as { opacityNode: Node<'float'> }).opacityNode = opacity ?? this.nodes.rig.z;
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
    return mesh;
  }

  commit(): void {
    for (const m of this.meshes) {
      m.count = this.count;
    }
    // A figure no boat in the level carries is not drawn at all.
    if (this.figures !== null && this.rigid === 0) {
      this.figures.count = 0;
    }
    for (const b of [this.pose, this.rig, this.sail, this.seat, this.lean]) {
      b.needsUpdate = true;
    }
    this.rows.texture.needsUpdate = true;
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

/** The machines' lamps pulse slowly, each boat's in its own phase. */
function lampPulse(time: Node<'float'>): Node<'float'> {
  return float(0.86).add(
    sin(time.add(instanceIndex.toFloat().mul(2.3))).mul(0.14),
  ) as unknown as Node<'float'>;
}

export class FleetView {
  readonly root = new Group();
  readonly near = new Level('near', NEAR_MODELS);
  readonly far = new Level('far', FLEET_CAPACITY);
  /** World time, seconds, modulo 2π, for the luffing ripple. */
  readonly time = uniform(0);
  loaded = false;
  /** The near boats' sailors, skinned; null until loaded. */
  nearSailors: NearSailors | null = null;
  /** The skinned sailors' mesh, in the near level. */
  skinned: InstancedMesh | null = null;
  looks: FleetLooks | null = null;
  /** The wind the sailors' cloth streams in: from (radians) and speed (m/s). */
  windFrom = 0;
  windSpeed = 0;
  /** The looks every boat is drawn with until boats carry their own: a person's, a machine sailor's. */
  #person: FleetLook | null = null;
  #machine: FleetLook | null = null;

  readonly #kind: BoatKind;
  readonly #frame: SailorFrame;
  readonly #place: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  /** Each view slot's ripple, foot and head, eased. */
  readonly #ripple = new Float32Array(64 * 2);
  /** Each view slot's sailor's side, kept while the sailor crosses. */
  readonly #side = new Float32Array(64);
  readonly #nearest = new Int32Array(NEAR_MODELS);
  readonly #nearestD = new Float64Array(NEAR_MODELS);
  readonly #sway = { x: 0, z: 0 };
  #version = -1;
  readonly #cog: number;
  #frames = 0;
  #ms = 0;

  constructor(kind: BoatKind) {
    this.#kind = kind;
    const { hull, foils } = kind.physics;
    this.root.name = 'fleet';
    this.root.add(this.near.group, this.far.group);
    this.#cog = hull.centreOfGravity;
    this.#frame = {
      seatOut: 0,
      seatY: 0,
      seatZ: 0,
      centreOfGravity: hull.centreOfGravity,
      boardZ: -foils.boardPosition,
      boardDepth: hull.hullDraught + 0.45 * foils.boardSpan,
    };
  }

  /**
   * Loads both levels' boats and the sailor every boat is drawn with (its
   * deck and far levels and clips: the first frame's), and knows the
   * machine sailors' machine, loaded when one is first in view. files
   * gives the URL of a sailor's file; the renderer decides how textures
   * are transcoded.
   */
  async load(
    sailor: SailorArt,
    machine: SailorArt,
    renderer: WebGPURenderer,
    files: ArtFiles,
  ): Promise<void> {
    const kind = this.#kind;
    const [nearParts, farParts] = await Promise.all([
      loadBoatParts(kind.art.model),
      loadBoatParts(kind.art.far),
    ]);
    const g = nearParts.gunwale;
    // Seated about the gunwale, where a hiking sailor leans out from.
    const looks = new FleetLooks(renderer, { out: g.x, y: g.y, z: nearParts.seatZ }, files);
    this.looks = looks;
    this.#person = looks.add(sailor, false);
    this.#machine = looks.add(machine, true);
    await looks.ready(this.#person, true);
    const { foot, luff } = kind.physics.rig;
    const mark = markPlace(foot, luff, chordAtHalf(nearParts.sail?.geometry));
    const cloth = fleetCloth(kind.name.slice(0, 1), mark);
    this.#frame.seatZ = nearParts.seatZ;
    this.#frame.seatOut = g.x;
    this.#frame.seatY = g.y;
    this.near.build(nearParts, kind, cloth, this.time);
    this.far.build(farParts, kind, cloth, this.time);
    if (looks.far === null) {
      throw new Error('the fleet’s sailor did not load');
    }
    this.near.buildFigures(looks, looks.far, this.#cog, this.time);
    this.far.buildFigures(looks, looks.far, this.#cog, this.time);
    // The near sailors, skinned, where the boat model has what they hold.
    const solid = hullSolid(nearParts.hullData, nearParts.boardRoot, {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    if (
      looks.near !== null &&
      solid !== null &&
      nearParts.hinge !== null &&
      nearParts.grip !== null
    ) {
      const near = new NearSailors(looks.bones, NEAR_MODELS, {
        stock: nearParts.stock,
        hinge: nearParts.hinge,
        extension: nearParts.hinge.distanceTo(nearParts.grip),
        seatY: g.y,
        seatIn: nearParts.seatIn,
        seatOut: g.x,
        seatZ: nearParts.seatZ,
        cog: this.#cog,
        solid,
        climbTime: kind.physics.sailor.climbTime,
      });
      this.nearSailors = near;
      const seat = { y: g.y, in: nearParts.seatIn, out: g.x };
      const n = nearSailorNodes(near.texture, int(instanceIndex), this.#cog, seat, this.time);
      const m = sailorMaterial(looks.atlas.texture as Texture, looks.mask.texture as Texture, {
        vertex: n.vertex,
        glow: lampPulse(this.time),
        instance: { ...n, users: { atlas: looks.atlas.users, mask: looks.mask.users } },
      });
      this.skinned = this.near.add(looks.near, m, 'skinned', n.opacity);
    }
    this.#version = looks.version;
    this.loaded = true;
  }

  /** The look a boat's sailor is drawn in; null before the fleet is loaded. */
  lookOf(b: DrawnBoat): FleetLook | null {
    return b.machine === 1 ? this.#machine : this.#person;
  }

  /** Takes the looks' figures anew, when a look has loaded. */
  #pools(): void {
    const looks = this.looks;
    if (looks === null || looks.version === this.#version) {
      return;
    }
    this.#version = looks.version;
    const old = new Set<BufferGeometry>();
    const take = (mesh: InstancedMesh | null, g: BufferGeometry | null): void => {
      if (mesh !== null && g !== null && mesh.geometry !== g) {
        old.add(mesh.geometry);
        mesh.geometry = g;
      }
    };
    take(this.near.figures, looks.far);
    take(this.far.figures, looks.far);
    take(this.skinned, looks.near);
    for (const g of old) {
      g.dispose();
    }
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
    const start = performance.now();
    this.time.value = time % (2 * Math.PI);
    this.#pools();
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
    for (const level of [this.near, this.far]) {
      level.count = 0;
      level.machines = 0;
      level.rigid = 0;
      level.sailorTriangles = 0;
    }
    this.nearSailors?.frame(time);
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
        this.#write(level, level.count++, b, origin, ease, near, dt);
        if (b.machine === 1) {
          level.machines++;
        }
      }
    }
    this.near.commit();
    this.far.commit();
    if (this.skinned !== null) {
      this.skinned.count = this.near.count > this.near.rigid ? this.near.count : 0;
    }
    this.nearSailors?.commit();
    this.#frames++;
    this.#ms += performance.now() - start;
  }

  #write(
    level: Level,
    n: number,
    b: DrawnBoat,
    origin: FloatingOrigin,
    ease: number,
    near: boolean,
    dt: number,
  ): void {
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
    // Its sailor, in its look: loaded when first seen; until then the
    // first look's figure, in its own colours. Skinned near, once its
    // look's moving figure has loaded; else rigid.
    const look = this.lookOf(b);
    if (look === null || this.#person === null) {
      return;
    }
    this.looks?.want(look, near);
    const drawn = look.layer >= 0 ? look : this.#person;
    const ns = near ? this.nearSailors : null;
    const skinned = ns?.write(n, b, look, dt) === true;
    const rows = level.rows;
    this.#head(rows.data, rows.width * n, n, level, look, drawn, !skinned, false, b);
    if (ns !== null) {
      this.#head(ns.data, ns.width * n, n, level, look, drawn, false, skinned, b);
    }
    if (skinned) {
      level.sailorTriangles += trianglesOf(look.deck?.geometry ?? null);
    } else {
      level.rigid++;
      level.sailorTriangles += trianglesOf(drawn.far);
    }
  }

  /**
   * A sailor's row's first texels (fleetsailors.ts), at texel at of d: its
   * boat's values from instance n of level, its look's colours, the layer
   * drawn, and whether it is drawn rigid or skinned (with its sway).
   */
  #head(
    d: Float32Array,
    at: number,
    n: number,
    level: Level,
    look: FleetLook,
    drawn: FleetLook,
    rigid: boolean,
    skinned: boolean,
    b: DrawnBoat,
  ): void {
    const r = 4 * at;
    const o = 4 * n;
    const c = look.colours;
    for (let k = 0; k < 4; k++) {
      d[r + k] = level.pose.array[o + k] as number;
      d[r + 4 + k] = level.lean.array[o + k] as number;
      d[r + 8 + k] = level.rig.array[o + k] as number;
      d[r + 28 + k] = level.seat.array[o + k] as number;
    }
    d[r + 12] = c.main.r;
    d[r + 13] = c.main.g;
    d[r + 14] = c.main.b;
    d[r + 15] = drawn.layer;
    d[r + 16] = c.skin.r;
    d[r + 17] = c.skin.g;
    d[r + 18] = c.skin.b;
    d[r + 19] = drawn.machine ? 1 : 0;
    d[r + 20] = c.hair.r;
    d[r + 21] = c.hair.g;
    d[r + 22] = c.hair.b;
    d[r + 23] = rigid ? 1 : 0;
    if (skinned && this.nearSailors !== null) {
      swayOf(this.windFrom, this.windSpeed, b, this.#sway);
      d[r + 24] = this.#sway.x;
      d[r + 25] = this.#sway.z;
      d[r + 26] = this.nearSailors.seated(b.slot);
    }
    d[r + 27] = skinned ? 1 : 0;
  }

  /** How many boats drawn this frame carry a person, and how many a machine. */
  figures(): { people: number; machines: number } {
    const machines = this.near.machines + this.far.machines;
    return { people: this.near.count + this.far.count - machines, machines };
  }

  /** The fleet's sailors' meshes: the rigid figures of each level and the skinned ones. */
  sailorMeshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const level of [this.near, this.far]) {
      if (level.figures !== null) {
        out.push(level.figures);
      }
    }
    if (this.skinned !== null) {
      out.push(this.skinned);
    }
    return out;
  }

  /** The draw calls the fleet's sailors make this frame. */
  sailorDraws(): number {
    return this.sailorMeshes().filter((m) => (m as InstancedMesh).count > 0).length;
  }

  /** The draw calls and triangles the fleet's meshes make this frame. */
  budget(): { drawCalls: number; triangles: number } {
    let drawCalls = 0;
    let triangles = 0;
    const sailors = this.sailorMeshes();
    for (const level of [this.near, this.far]) {
      if (level.count === 0) {
        continue;
      }
      for (const m of level.meshes) {
        if (m.count === 0) {
          continue;
        }
        drawCalls++;
        if (sailors.includes(m)) {
          continue;
        }
        const index = m.geometry.index;
        const n = index !== null ? index.count : m.geometry.getAttribute('position').count;
        triangles += (n / 3) * level.count;
      }
      triangles += level.sailorTriangles;
    }
    return { drawCalls, triangles };
  }

  /**
   * Since last asked: the frames drawn, the milliseconds the fleet's update
   * took (its sailors' runs, the rows and the boats' values), and how many
   * times a near sailor ran.
   */
  work(): { frames: number; ms: number; runs: number } {
    const r = { frames: this.#frames, ms: this.#ms, runs: this.nearSailors?.runs ?? 0 };
    this.#frames = 0;
    this.#ms = 0;
    if (this.nearSailors !== null) {
      this.nearSailors.runs = 0;
    }
    return r;
  }
}

function trianglesOf(g: BufferGeometry | null): number {
  if (g === null) {
    return 0;
  }
  const index = g.index;
  return (index !== null ? index.count : g.getAttribute('position').count) / 3;
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
