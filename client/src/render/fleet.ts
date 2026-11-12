// SPDX-License-Identifier: AGPL-3.0-only

// The other boats, drawn many at once: for each kind, one InstancedMesh for
// its solids (every material's, merged), one for its sail and one for its
// headsail, every boat of that kind an instance, with its pose,
// rig, sail and sailor in per-instance values that the parts' vertex nodes
// read (fleetparts.ts). Each kind has its own view, made when a boat of the
// kind first comes into view; its headsail is shaped about its stay and its
// main reefed as the wire says. A kind with a downwind sail has one more
// draw a level, its gennaker, shaped about its tack from each boat's clew
// and drawn as far as it is hoisted: nothing in its bag, and no draw at all
// while no boat of the level has it up. Two levels of detail: the full
// model for the few nearest the camera, the far model, with few segments,
// for the rest.
// Boats fade in and out dithered (alphaHash), so they stay in the opaque
// pass, in the same draw, with no sorting. The telltales and pennant of
// other boats are too small to see, and not drawn; their sails carry the
// class insignia. Each boat is drawn in its own look (boatlook.ts): its
// paint, cloth and sail number are instance values beside its lean, which
// the parts' fragments colour by, from the catalog's palette and one
// texture of masks a kind; so the draws are the same whatever the looks.
// A machine sailor's sail carries the machine mark too (machinemark.ts),
// a mask its flag inks, on its gennaker as on its main. The near boats
// carry their names, each lettered into a row of one small texture for the
// whole fleet, redrawn only when a row is given another name; the far ones
// carry none.
//
// The sailors (sailors/fleetsailors.ts): on the near boats, skinned and
// moving, every look in one draw; on the far ones, and on near ones whose
// look's moving figure has not loaded yet, rigid figures posed seated,
// every look in one draw a level. Each boat's sailor is drawn in its own
// look and colours; a look is loaded when a boat with it first comes into
// view (sailors/fleetlooks.ts), and until then the boat carries the first
// look's figure (the player's own) in its own colours.
//
// A kind with a square rig (squarerig.ts) has one more part, its square
// sails, bellied as drawing sails, turned with its yards and taken in as
// the wire's reef says; its yards and wheel are joints of its solids, its
// yards' turns packed in the instance's rig in place of the sail's side;
// its stern gallery glows by night.
//
// A kind with a trapeze has its wires drawn as lines, every boat's in one
// draw: from the hounds to the sailor's hook while the sailor hangs on it
// (near, the moving figure's hook; far, the hook of the figure on the
// wire), else down to its ring. The fleet's sailors wear no harness: it
// would be too small to see.
//
// The looks are the fleet's, one set for every kind: their figures are
// seated in the boat the clips were placed in, and each instance's seat is
// its own kind's.
//
// Each frame the fleet's drawn boats are written into the instances'
// values, which, being dynamic, go to the GPU with each draw; nothing is
// allocated.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  LineSegments,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
  Vector3,
} from 'three';
import {
  attribute,
  float,
  instancedDynamicBufferAttribute,
  instanceIndex,
  int,
  positionGeometry,
  select,
  sin,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind } from '../catalog';
import type { BoatLooks } from '../catalog/boatlooks';
import {
  artOf,
  coloursOf,
  isMachine,
  type Look,
  type Looks,
  lookOf,
  MACHINE_MARK,
} from '../catalog/looks';
import type { DrawnBoat } from '../game/fleet';
import {
  FULL_CAMBER,
  LAMPLIGHT,
  lampsLit,
  NUMBER_MIRRORED,
  reefRows,
  type SailorLook,
  squarePrint,
} from './boat';
import {
  clothColour,
  clothMasks,
  digits,
  type HullName,
  hullColour,
  type LookNodes,
  type LookPalette,
  lookPalette,
  MASK_HEIGHT,
  MASK_WIDTH,
  NameAtlas,
  numberPlace,
  type SailPrint,
  writeLook,
} from './boatlook';
import type { FloatingOrigin } from './coords';
import {
  type BoatParts,
  GALLERY_PART,
  HEADSAIL_UV,
  type Instances,
  jibNode,
  kiteNode,
  loadBoatParts,
  machineOf,
  sailNode,
  solidNode,
  squareNode,
} from './fleetparts';
import { chordAt, chordAtHalf, markPlace } from './machinemark';
import { lineMaterial, litMaterial, sailGlow } from './materials';
import { placeSailor, SAILING, type SailorFrame, type SailorPlace } from './sailor';
import { namesCatClips } from './sailors/cat';
import { type ArtFiles, type FleetLook, FleetLooks } from './sailors/fleetlooks';
import {
  type NearBoat,
  NearSailors,
  nearSailorNodes,
  ROW_HEAD,
  rigidSailorNodes,
  SailorRows,
  swayOf,
} from './sailors/fleetsailors';
import { type SailorColours, sailorColours, sailorMaterial } from './sailors/material';
import { catOf, NO_SOLID, wireColour } from './sailors/onboat';
import { seating } from './sailors/restage';
import { hullSolid } from './sailors/solid';
import { type Trapeze, trapezeOf, wireNode } from './sailors/trapeze';
import { wheelOf } from './sailors/wheel';
import { kiteRig, kiteRipple, kiteShown } from './sailshape';
import { Shadows } from './shadows';
import { packYards, squareVertex } from './squarerig';
import { FLOW_LUFFING } from './telltales';

/** The most boats drawn at once: a full view and as many fading out. */
export const FLEET_CAPACITY = 128;
/** The rows of the fleet's names' texture: one for each near boat, and a few kept for those that pass. */
export const NAME_ROWS = 16;
/** The full model is drawn for at most this many boats, the nearest the camera... */
export const NEAR_MODELS = 12;
/** ...within this distance of it, metres. */
export const NEAR_RANGE = 60;

const DEG = Math.PI / 180;
/** How hard a luffing strip of another boat ripples, 0 to 1. */
const RIPPLE = 0.7;
/** Seconds over which a ripple grows and dies away. */
const RIPPLE_EASE = 0.25;
/** The ripples eased for each view slot: the main's foot and head, the headsail's, the downwind sail's. */
const RIPPLES = 4;

/** One level of detail: its meshes and their instances' values. */
class Level {
  readonly group = new Group();
  readonly meshes: InstancedMesh[] = [];
  readonly pose = attr();
  readonly rig = attr();
  readonly sail = attr();
  readonly seat = attr();
  /** Each instance's lean (four values) and its look (four more), one buffer, which the parts read as one. */
  readonly lean = attr(LEAN_STRIDE);
  readonly jib = attr();
  /** Each instance's downwind sail: its clew's angle, signed twist, ripple and hoist. */
  readonly kite = attr();
  /** The downwind sail's meshes, none for a kind without one; and how many boats drawn have it up. */
  readonly kiteMeshes: InstancedMesh[] = [];
  kites = 0;
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
      lean: node(this.lean, LEAN_STRIDE),
      look: node(this.lean, LEAN_STRIDE, 4),
      // The boats' meshes read none of the sailors' values.
      main: vec4(0),
      skin: vec4(0),
      hair: vec4(0),
      jib: node(this.jib),
      kite: node(this.kite),
    };
  }

  build(
    parts: BoatParts,
    kind: BoatKind,
    cloth: SailPrint,
    jibCloth: SailPrint | null,
    squareCloth: SailPrint | null,
    time: Node<'float'>,
    palette: LookPalette,
    name: HullName | null,
    kiteCloth: SailPrint | null = null,
  ): void {
    const { hull, rig, headsails, foils } = kind.physics;
    const cog = hull.centreOfGravity;
    const i = this.nodes;
    const squareRig = parts.square !== null;
    const joints = squareRig
      ? {
          yardsAt: parts.yardsAt,
          yardDrops: parts.yardDrops,
          wheelAt: parts.wheelAt,
          rudderAngle: foils.rudderAngle,
        }
      : null;
    const l = varying(i.look ?? vec4(0, 0, 0, -1)) as unknown as Node<'vec4'>;
    const look: LookNodes = {
      paint: l.x,
      cloth: l.y,
      number: l.z,
      row: l.w,
      machine: varying(machineOf(i)),
    } as unknown as LookNodes;
    for (const s of parts.solids) {
      const src = s.material;
      // Each vertex its own material's colour, roughness and metalness;
      // the topsides' tones in the boat's paint, with its name on them.
      const m = litMaterial(
        { vertexColors: true, side: src.side === DoubleSide ? DoubleSide : FrontSide },
        solidNode(i, parts, cog, joints),
      );
      const own = attribute('part', 'vec4') as unknown as Node<'vec4'>;
      m.roughnessNode = own.y;
      m.metalnessNode = own.z;
      const topsides = varying(own.w);
      const painted = parts.gallery
        ? topsides.greaterThan(0.5).and(topsides.lessThan(GALLERY_PART - 0.5))
        : topsides.greaterThan(0.5);
      m.colorNode = vec4(
        select(painted, hullColour(palette, look, varying(positionGeometry), name), vec3(1)),
        1,
      );
      if (parts.gallery) {
        // The gallery's panes, lamplit by night.
        m.emissiveNode = select(
          topsides.greaterThan(GALLERY_PART - 0.5),
          vec3(...LAMPLIGHT).mul(lampsLit),
          vec3(0),
        );
      }
      this.add(s.geometry, m, src.side === DoubleSide ? 'solids, both sides' : 'solids');
    }
    if (parts.sail !== null) {
      const rows = reefRows(parts.sail.geometry, rig.reefs);
      const m = litMaterial(
        { roughness: parts.sail.material.roughness, metalness: 0, side: DoubleSide },
        sailNode(
          i,
          parts,
          cog,
          rig.footStrip,
          rig.headStrip,
          time,
          { shares: rig.reefs, gather: rows !== null, luff: rig.luff },
          squareRig ? rig.twistTurn : null,
        ),
      );
      const c = vec4(clothColour(palette, look, uv(), cloth), 1) as unknown as Node<'vec4'>;
      m.colorNode = c;
      m.emissiveNode = sailGlow(c);
      this.add(parts.sail.geometry, m, 'sail');
    }
    // Each headsail its own draw: each is shaped in its own frame.
    parts.jibs.forEach((jib, n) => {
      if (jibCloth === null) {
        return;
      }
      const m = litMaterial(
        { roughness: jib.material.roughness, metalness: 0, side: DoubleSide },
        jibNode(i, jib, cog, headsails.headsailFootStrip, headsails.headsailHeadStrip, time),
      );
      const cloth = attribute(HEADSAIL_UV, 'vec4').xy as unknown as Node<'vec2'>;
      const c = vec4(clothColour(palette, look, cloth, jibCloth), 1) as unknown as Node<'vec4'>;
      m.colorNode = c;
      m.emissiveNode = sailGlow(c);
      this.add(jib.geometry, m, n === 0 ? 'jib' : `jib ${n + 1}`);
    });
    // The downwind sail: a draw for each of its meshes (the models have one).
    const kite = kiteRig(kind.physics);
    parts.kites.forEach((sail, n) => {
      if (kite === null || kiteCloth === null) {
        return;
      }
      const m = litMaterial(
        { roughness: sail.material.roughness, metalness: 0, side: DoubleSide },
        kiteNode(i, sail, cog, kite, time),
      );
      const cloth = attribute(HEADSAIL_UV, 'vec4').xy as unknown as Node<'vec2'>;
      const c = vec4(clothColour(palette, look, cloth, kiteCloth), 1) as unknown as Node<'vec4'>;
      m.colorNode = c;
      m.emissiveNode = sailGlow(c);
      this.kiteMeshes.push(this.add(sail.geometry, m, n === 0 ? 'kite' : `kite ${n + 1}`));
    });
    if (parts.square !== null && squareCloth !== null) {
      const m = litMaterial(
        { roughness: parts.square.material.roughness, metalness: 0, side: DoubleSide },
        squareNode(i, parts, cog, time),
      );
      // The number only on the sail that carries it; the cloth's v runs down from the head.
      const sv = squareVertex();
      const numbered = { ...look, number: look.number.mul(varying(sv.numbered)) } as LookNodes;
      const at = vec2(uv().x, float(1).sub(uv().y)) as unknown as Node<'vec2'>;
      const c = vec4(clothColour(palette, numbered, at, squareCloth), 1) as unknown as Node<'vec4'>;
      m.colorNode = c;
      m.emissiveNode = sailGlow(c);
      this.add(parts.square.geometry, m, 'square sails');
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
    // Nor a gennaker no boat has up.
    if (this.kites === 0) {
      for (const m of this.kiteMeshes) {
        m.count = 0;
      }
    }
    for (const b of [this.pose, this.rig, this.sail, this.seat, this.lean, this.jib, this.kite]) {
      b.needsUpdate = true;
    }
    this.rows.texture.needsUpdate = true;
  }
}

/**
 * A kind's trapeze wires, both of every boat drawn, as line segments in
 * the scene, written each frame: one draw. A faded boat's are dithered as
 * its other parts are.
 */
class WireLines {
  readonly mesh: LineSegments;
  readonly #position: BufferAttribute;
  readonly #opacity: BufferAttribute;
  count = 0;

  constructor(
    colour: Color | null,
    name: string,
    /** Wires a boat: a side's helm's, and a crew's if it has theirs. */
    readonly each = 2,
  ) {
    const g = new BufferGeometry();
    this.#position = new BufferAttribute(new Float32Array(FLEET_CAPACITY * each * 2 * 3), 3);
    this.#opacity = new BufferAttribute(new Float32Array(FLEET_CAPACITY * each * 2), 1);
    this.#position.setUsage(DynamicDrawUsage);
    this.#opacity.setUsage(DynamicDrawUsage);
    g.setAttribute('position', this.#position);
    g.setAttribute('opacity', this.#opacity);
    const m = lineMaterial({ color: colour ?? 0x000000 });
    m.alphaHash = true;
    (m as unknown as { opacityNode: Node<'float'> }).opacityNode = attribute(
      'opacity',
      'float',
    ) as unknown as Node<'float'>;
    m.name = `fleet ${name} trapeze wires`;
    this.mesh = new LineSegments(g, m);
    this.mesh.name = m.name;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** A wire from a to b (the scene's), as faded as its boat. */
  add(a: Vector3, b: Vector3, opacity: number): void {
    if (this.count >= FLEET_CAPACITY * this.each) {
      return;
    }
    const k = 2 * this.count++;
    this.#position.setXYZ(k, a.x, a.y, a.z);
    this.#position.setXYZ(k + 1, b.x, b.y, b.z);
    this.#opacity.setX(k, opacity);
    this.#opacity.setX(k + 1, opacity);
  }

  commit(): void {
    this.mesh.geometry.setDrawRange(0, 2 * this.count);
    this.#position.needsUpdate = true;
    this.#opacity.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }
}

/** The lean's buffer's values an instance: its lean, then its look. */
export const LEAN_STRIDE = 8;

function attr(stride = 4): InstancedInterleavedBuffer {
  const b = new InstancedInterleavedBuffer(new Float32Array(FLEET_CAPACITY * stride), stride, 1);
  b.setUsage(DynamicDrawUsage);
  return b;
}

/**
 * An instance-stepped vec4 attribute of b, as three.js's own instance
 * matrices are made (nodes/accessors/Instance.js): on an
 * InstancedInterleavedBuffer, which both back ends step per instance. Two
 * of one buffer are one vertex buffer to the device.
 */
function node(b: InstancedInterleavedBuffer, stride = 4, offset = 0): Node<'vec4'> {
  return instancedDynamicBufferAttribute(b, 'vec4', stride, offset) as unknown as Node<'vec4'>;
}

/**
 * The looks a boat with none given is drawn in: a person's, the first look
 * in the colours the pictures were taken with, and a machine's, the first
 * version in the first finish and colour.
 */
export const PERSON_DEFAULT = 0x22100;
export const MACHINE_DEFAULT = MACHINE_MARK;

/** A look code's look as the fleet draws it, and its colours. */
interface DrawnLook {
  look: FleetLook;
  colours: SailorColours;
}

/** The machines' lamps pulse slowly, each boat's in its own phase. */
function lampPulse(time: Node<'float'>): Node<'float'> {
  return float(0.86).add(
    sin(time.add(instanceIndex.toFloat().mul(2.3))).mul(0.14),
  ) as unknown as Node<'float'>;
}

/** What every kind's view shares: the looks, their figures, the boats' own looks and names, and the time. */
class Shared {
  /** World time, seconds, modulo 2π, for the luffing ripple. */
  readonly time = uniform(0);
  /** The catalog's boats' looks, and their palette. */
  readonly boatLooks: BoatLooks;
  readonly palette: LookPalette;
  /** The near boats' names, lettered; made with the first view loaded. */
  names: NameAtlas | null = null;
  /** The frames drawn: which names are wanted when. */
  frame = 0;

  constructor(boatLooks: BoatLooks) {
    this.boatLooks = boatLooks;
    this.palette = lookPalette(boatLooks);
  }

  /** The names' texture, made the first time it is asked for. */
  nameAtlas(): NameAtlas {
    this.names ??= new NameAtlas(NAME_ROWS, this.boatLooks.boatLooks.lettering);
    return this.names;
  }
  looks: FleetLooks | null = null;
  /** The catalog's looks; the look every boat is drawn with until its own has loaded. */
  cat: Looks | null = null;
  first: FleetLook | null = null;
  /** Each look code met: its look and its colours. */
  readonly byCode = new Map<number, DrawnLook>();
  /** The wind the sailors' cloth streams in: from (radians) and speed (m/s). */
  windFrom = 0;
  windSpeed = 0;
  /**
   * Aboard a beach cat in a view slot, where her crew hanging on her
   * trapeze's wire has it hooked (her model's frame), into out, and the
   * side; 0 if none (the crews' drawing tells it).
   */
  crewHook: (slot: number, out: Vector3) => number = () => 0;

  /**
   * The look a boat's sailor is drawn in, and its colours: its look code's,
   * or for a boat with none given, the default person's or machine's; null
   * before the fleet's sailors are loaded.
   */
  lookOf(b: DrawnBoat): DrawnLook | null {
    const cat = this.cat;
    const looks = this.looks;
    if (cat === null || looks === null) {
      return null;
    }
    const code = b.look >= 0 ? b.look : b.machine === 1 ? MACHINE_DEFAULT : PERSON_DEFAULT;
    let d = this.byCode.get(code);
    if (d === undefined) {
      const l = lookOf(cat, code) ?? (lookOf(cat, PERSON_DEFAULT) as Look);
      const c = coloursOf(cat, l);
      d = {
        look: looks.add(artOf(cat, l), isMachine(l)),
        colours: sailorColours(c.main, c.skin, c.hair),
      };
      this.byCode.set(code, d);
    }
    return d;
  }
}

/** One kind's boats: its two levels, its near sailors, and how each is seated. */
export class FleetView {
  readonly root = new Group();
  readonly near = new Level('near', NEAR_MODELS);
  readonly far = new Level('far', FLEET_CAPACITY);
  loaded = false;
  /** The near boats' sailors, skinned; null until loaded. */
  nearSailors: NearSailors | null = null;
  /** The skinned sailors' mesh, in the near level. */
  skinned: InstancedMesh | null = null;
  /** The near boat's parts, which the sailors are seated by; null until loaded. */
  parts: BoatParts | null = null;

  readonly kind: BoatKind;
  /** The kind's index among the catalog's boats. */
  readonly index: number;
  readonly #shared: Shared;
  readonly #frame: SailorFrame;
  readonly #place: SailorPlace = { x: 0, y: 0, z: 0, facing: 0, tilt: 0 };
  /** Each view slot's ripple, foot and head, eased, its headsail's and its downwind sail's. */
  readonly #ripple = new Float32Array(64 * RIPPLES);
  /** Each view slot's sailor's side, kept while the sailor crosses. */
  readonly #side = new Float32Array(64);
  readonly #sway = { x: 0, z: 0 };
  readonly #cog: number;
  /** Whether its kind has square sails: its instances' rig.w carries their yards. */
  #squareRig = false;
  /** Its kind's downwind sail's numbers; null for a kind without one. */
  readonly #kite: ReturnType<typeof kiteRig>;
  /** Its kind's trapeze, null for a kind without one; and its wires, drawn. */
  #trapeze: Trapeze | null = null;
  /** Whether the kind's people are drawn with a beach cat's clips: their looks' are loaded, near. */
  readonly #catted: boolean;
  wires: WireLines | null = null;
  /** The boat being written's sailor's hook (the model's frame) and the side it hangs on, 0 if not. */
  readonly #hook = new Vector3();
  #hookSide = 0;

  constructor(kind: BoatKind, index: number, shared: Shared) {
    this.kind = kind;
    this.index = index;
    this.#shared = shared;
    this.#catted = namesCatClips(kind.art);
    const { hull, foils } = kind.physics;
    this.root.name = `fleet ${kind.name}`;
    this.root.add(this.near.group, this.far.group);
    this.#cog = hull.centreOfGravity;
    this.#kite = kiteRig(kind.physics);
    this.#frame = {
      seatOut: 0,
      seatY: 0,
      seatZ: 0,
      centreOfGravity: hull.centreOfGravity,
      boardZ: -foils.boardPosition,
      boardDepth: hull.hullDraught + 0.45 * foils.boardSpan,
    };
  }

  /** Loads both levels' boats; their sailors come with useLooks. */
  async load(): Promise<void> {
    const kind = this.kind;
    const [nearParts, farParts] = await Promise.all([
      loadBoatParts(kind.art.model),
      loadBoatParts(kind.art.far),
    ]);
    const g = nearParts.gunwale;
    const { foot, luff, reefs } = kind.physics.rig;
    const sail = nearParts.sail?.geometry;
    const number = {
      place: numberPlace(foot, luff, (v) => chordAt(sail, v)),
      digits: digits(),
      mirrored: NUMBER_MIRRORED,
    };
    const cloth: SailPrint = {
      masks: clothMasks({
        insignia: kind.name.slice(0, 1),
        reefRows: reefRows(sail, reefs) ?? [],
        mark: markPlace(foot, luff, chordAtHalf(sail)),
      }),
      number: nearParts.numbered === 'sail' ? number : null,
    };
    const jibCloth: SailPrint | null =
      nearParts.jib === null
        ? null
        : {
            masks: clothMasks(
              { insignia: '', reefRows: [], mark: null },
              MASK_WIDTH / 2,
              MASK_HEIGHT / 2,
            ),
            number: nearParts.numbered === 'jib' ? number : null,
          };
    // The downwind sail: the cloth's band, and the machine mark at its own half-luff.
    const { downwind } = kind.physics;
    const kiteCloth: SailPrint | null =
      nearParts.kites.length === 0
        ? null
        : {
            masks: clothMasks(
              {
                insignia: '',
                reefRows: [],
                mark: markPlace(
                  downwind.downwindFoot,
                  downwind.downwindLuff,
                  nearParts.kites[0]?.chordHalf ?? 0.5,
                ),
              },
              MASK_WIDTH / 2,
              MASK_HEIGHT / 2,
            ),
            number: null,
          };
    this.#frame.seatZ = nearParts.seatZ;
    this.#frame.seatOut = g.x;
    this.#frame.seatY = g.y;
    // A boat with a trapeze: its sailor goes out on the wire, and its wires are drawn.
    const { hikeReach } = kind.physics.sailor;
    this.#trapeze = trapezeOf(nearParts.objects, hikeReach);
    if (this.#trapeze !== null) {
      const t = this.#trapeze;
      this.#frame.trapeze = {
        x: t.rackEdge.x,
        y: t.rackEdge.y,
        z: t.rackEdge.z,
        rail: seating(nearParts.objects, hikeReach).hike.full,
        reach: t.reach,
      };
      this.wires = new WireLines(
        wireColour(wireNode(nearParts.objects, 1)),
        kind.name,
        t.crewRings === null ? 2 : 4,
      );
      this.root.add(this.wires.mesh);
    }
    // A boat steered by a wheel has its sailor standing at it.
    const stand = nearParts.nodes.get('sailor');
    this.#frame.wheel =
      wheelOf(nearParts.objects, null) !== null && stand !== undefined
        ? { y: stand.y, z: stand.z }
        : null;
    const shared = this.#shared;
    const time = shared.time;
    const names = shared.nameAtlas();
    const name: HullName | null =
      nearParts.name === null
        ? null
        : { texture: names.texture, rows: names.rows.rows, place: nearParts.name };
    // The square sails' print by the near model's sails, for both levels.
    const squareCloth = nearParts.square === null ? null : squarePrint(nearParts.square.sails);
    this.near.build(
      nearParts,
      kind,
      cloth,
      jibCloth,
      squareCloth,
      time,
      shared.palette,
      name,
      kiteCloth,
    );
    this.far.build(
      farParts,
      kind,
      cloth,
      jibCloth,
      squareCloth,
      time,
      shared.palette,
      null,
      kiteCloth,
    );
    this.#squareRig = nearParts.square !== null;
    this.parts = nearParts;
    this.loaded = true;
  }

  /**
   * The sailors, in the fleet's looks: rigid figures on both levels, and
   * skinned ones on the near boats where the model has what they hold,
   * seated and hiking as this kind's sailor is.
   */
  useLooks(looks: FleetLooks): void {
    const kind = this.kind;
    const nearParts = this.parts;
    if (nearParts === null || looks.far === null || this.near.figures !== null) {
      return;
    }
    const time = this.#shared.time;
    this.near.buildFigures(looks, looks.far, this.#cog, time);
    this.far.buildFigures(looks, looks.far, this.#cog, time);
    const g = nearParts.gunwale;
    const solid = hullSolid(nearParts.hullData, nearParts.boardRoot, {
      span: kind.physics.foils.boardSpan,
      chord: kind.physics.foils.boardChord,
    });
    const wheel = wheelOf(nearParts.objects, null);
    const stand = nearParts.nodes.get('sailor');
    // Its sailors' clips at the wheel, with their other clips.
    looks.wheel ||= wheel !== null;
    // Standing at a wheel: no tiller, no seat, no hull to keep out of.
    const boat: NearBoat | null =
      wheel !== null && stand !== undefined
        ? {
            stock: stand,
            hinge: stand,
            extension: 0,
            seatY: stand.y,
            seatIn: 0,
            seatOut: 0,
            seatZ: stand.z,
            cog: this.#cog,
            solid: solid ?? NO_SOLID,
            climbTime: kind.physics.sailor.climbTime,
            wheel,
            rudderMax: kind.physics.foils.rudderAngle * DEG,
          }
        : solid !== null && nearParts.hinge !== null && nearParts.grip !== null
          ? {
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
              ...seating(nearParts.objects, kind.physics.sailor.hikeReach),
              trapeze: this.#trapeze,
              cat: this.#catted
                ? catOf(rootOf(nearParts.objects), nearParts.objects, kind.physics.rig.foot)
                : null,
            }
          : null;
    if (looks.near !== null && boat !== null) {
      const near = new NearSailors(looks.bones, NEAR_MODELS, boat);
      this.nearSailors = near;
      const seat = { y: g.y, in: nearParts.seatIn, out: g.x };
      const n = nearSailorNodes(near.texture, int(instanceIndex), this.#cog, seat, time);
      const m = sailorMaterial(looks.atlas.texture as Texture, looks.mask.texture as Texture, {
        vertex: n.vertex,
        glow: lampPulse(time),
        instance: { ...n, users: { atlas: looks.atlas.users, mask: looks.mask.users } },
      });
      this.skinned = this.near.add(looks.near, m, 'skinned', n.opacity);
    }
  }

  /** Takes the looks' figures anew, when a look has loaded; adds the geometries let go to old. */
  takePools(looks: FleetLooks, old: Set<BufferGeometry>): void {
    const take = (mesh: InstancedMesh | null, g: BufferGeometry | null): void => {
      if (mesh !== null && g !== null && mesh.geometry !== g) {
        old.add(mesh.geometry);
        mesh.geometry = g;
      }
    };
    take(this.near.figures, looks.far);
    take(this.far.figures, looks.far);
    take(this.skinned, looks.near);
  }

  /** Starts a frame. */
  begin(time: number): void {
    for (const level of [this.near, this.far]) {
      level.count = 0;
      level.machines = 0;
      level.rigid = 0;
      level.sailorTriangles = 0;
      level.kites = 0;
    }
    if (this.wires !== null) {
      this.wires.count = 0;
    }
    this.nearSailors?.frame(time);
  }

  /** Writes boat b, of this kind, into the level it is drawn at. */
  write(b: DrawnBoat, near: boolean, origin: FloatingOrigin, ease: number, dt: number): void {
    const level = near ? this.near : this.far;
    if (level.count < FLEET_CAPACITY) {
      const n = level.count++;
      this.#hookSide = 0;
      this.#write(level, n, b, origin, ease, near, dt);
      if (b.machine === 1) {
        level.machines++;
      }
      this.#wires(level, n, b);
    }
  }

  /**
   * A boat's trapeze wires: from the hounds to its sailor's hook on the
   * side it hangs on, else to the ring; each placed as the boat is (the
   * parts' placePoint, on the CPU).
   */
  #wires(level: Level, n: number, b: DrawnBoat): void {
    const t = this.#trapeze;
    const wires = this.wires;
    if (t === null || wires === null) {
      return;
    }
    const o = n * 4;
    const ol = n * LEAN_STRIDE;
    const pose = level.pose.array as Float32Array;
    const lean = level.lean.array as Float32Array;
    const at = (p: Vector3, out: Vector3): Vector3 =>
      placeOnCpu(
        p,
        this.#cog,
        pose[o] as number,
        pose[o + 1] as number,
        pose[o + 2] as number,
        pose[o + 3] as number,
        lean[ol + 1] as number,
        lean[ol + 2] as number,
        out,
      );
    at(t.hounds, wireA);
    for (const side of [1, -1]) {
      const end = side === this.#hookSide ? this.#hook : side > 0 ? t.rings[0] : t.rings[1];
      wires.add(wireA, at(end, wireB), b.opacity);
    }
    // A crew's wires: to whoever of the crew hangs on one, else to its ring.
    const crew = t.crewRings;
    if (crew !== null) {
      const hung = b.slot >= 0 ? this.#shared.crewHook(b.slot, this.#crewHook) : 0;
      for (const side of [1, -1]) {
        const end = side === hung ? this.#crewHook : side > 0 ? crew[0] : crew[1];
        wires.add(wireA, at(end, wireB), b.opacity);
      }
    }
  }

  readonly #crewHook = new Vector3();

  /** Ends a frame: the counts and values to the GPU. */
  commit(): void {
    this.near.commit();
    this.far.commit();
    if (this.skinned !== null) {
      this.skinned.count = this.near.count > this.near.rigid ? this.near.count : 0;
    }
    this.nearSailors?.commit();
    this.wires?.commit();
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
    const { rig, sailor } = this.kind.physics;
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
    r[o + 3] = this.#squareRig ? packYards(b.foreYardsTurn, b.yardsTurn) : turn;
    const flat = (b.sail & 15) / 15;
    const perFlat = ((rig.twistDepowered - rig.twistPowered) * DEG) / (1 - sailor.flattenMin);
    const twist =
      rig.twistPowered * DEG +
      perFlat * (1 - flat) +
      (rig.twistEased / rig.boomOut) * Math.abs(b.boom);
    let footRipple = 0;
    let headRipple = 0;
    let jibRipple = 0;
    let kiteRippled = 0;
    if (b.slot >= 0) {
      const k = b.slot * RIPPLES;
      const foot = ((b.sail >> 4) & 3) === FLOW_LUFFING ? RIPPLE : 0;
      const head = ((b.sail >> 6) & 3) === FLOW_LUFFING ? RIPPLE : 0;
      footRipple = (this.#ripple[k] ?? 0) + (foot - (this.#ripple[k] ?? 0)) * ease;
      headRipple = (this.#ripple[k + 1] ?? 0) + (head - (this.#ripple[k + 1] ?? 0)) * ease;
      // The headsail luffs with the main's luff: the wire says nothing of its own flow.
      const luffs = Math.max(foot, head);
      jibRipple = (this.#ripple[k + 2] ?? 0) + (luffs - (this.#ripple[k + 2] ?? 0)) * ease;
      // The downwind sail too, and flogging as it goes up or comes down.
      const kite = kiteRipple(luffs, b.hoist);
      kiteRippled = (this.#ripple[k + 3] ?? 0) + (kite - (this.#ripple[k + 3] ?? 0)) * ease;
      this.#ripple[k] = footRipple;
      this.#ripple[k + 1] = headRipple;
      this.#ripple[k + 2] = jibRipple;
      this.#ripple[k + 3] = kiteRippled;
    }
    const s = level.sail.array as Float32Array;
    s[o] = twist * turn;
    s[o + 1] = FULL_CAMBER * (flat > 0 ? flat : 1);
    s[o + 2] = footRipple;
    s[o + 3] = headRipple;
    // The headsail: its clew's angle, its twist by its angle as the
    // physics has it, to the side it is out on.
    const { headsails } = this.kind.physics;
    const jibTurn = Math.max(-1, Math.min(1, b.jib / (rig.twistTurn * DEG)));
    const jibTwist =
      headsails.headsailTwist * DEG +
      (headsails.headsailOut > 0
        ? ((headsails.headsailTwistEased - headsails.headsailTwist) / headsails.headsailOut) *
          Math.abs(b.jib)
        : 0);
    const j = level.jib.array as Float32Array;
    j[o] = b.jib;
    j[o + 1] = jibTwist * jibTurn;
    j[o + 2] = jibTurn;
    j[o + 3] = jibRipple;
    // The downwind sail: its clew's angle, its twist by its angle as the
    // physics has it, to the side it is out on; its ripple and its hoist.
    const kite = this.#kite;
    if (kite !== null) {
      const { downwind } = this.kind.physics;
      const kiteTurn = Math.max(-1, Math.min(1, b.kite / kite.twistTurn));
      const kiteTwist =
        downwind.downwindTwist * DEG +
        (downwind.downwindOut > 0
          ? (downwind.downwindTwistEased / downwind.downwindOut) * Math.abs(b.kite)
          : 0);
      const kv = level.kite.array as Float32Array;
      const hoist = Math.max(0, Math.min(1, b.hoist));
      kv[o] = b.kite;
      kv[o + 1] = kiteTwist * kiteTurn;
      kv[o + 2] = kiteRippled;
      kv[o + 3] = hoist;
      if (kiteShown(hoist)) {
        level.kites++;
      }
    }
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
    const ol = n * LEAN_STRIDE;
    lean[ol] = p.tilt;
    lean[ol + 1] = b.heave;
    lean[ol + 2] = b.pitch;
    // A machine's mark, and the main's reef level above it.
    lean[ol + 3] = (b.machine === 1 ? 1 : 0) + 2 * Math.min(Math.max(Math.round(b.reef), 0), 2);
    // Its own look: paint, cloth, sail number, and its name's row (near only).
    const shared = this.#shared;
    writeLook(shared.boatLooks, b.boatLook, lean, ol + 4);
    lean[ol + 7] =
      near && b.name !== '' && shared.names !== null
        ? shared.names.rowOf(b.name, shared.frame)
        : -1;
    // Its sailor, in its look: loaded when first seen; until then the
    // first look's figure, in its own colours. Skinned near, once its
    // look's moving figure has loaded; else rigid.
    const d = shared.lookOf(b);
    if (d === null || shared.first === null || level.figures === null) {
      return;
    }
    if (b.helmAway) {
      // Its helm walking with its crew as the controls change hands: drawn by them, not here.
      const rows = level.rows;
      this.#head(rows.data, rows.width * n, n, level, d.colours, shared.first, false, false, b);
      const ns = near ? this.nearSailors : null;
      if (ns !== null) {
        this.#head(ns.data, ns.width * n, n, level, d.colours, shared.first, false, false, b);
      }
      return;
    }
    const look = d.look;
    shared.looks?.want(look, near, this.#trapeze !== null, false, false, false, this.#catted);
    const drawn = look.layer >= 0 ? look : shared.first;
    const ns = near ? this.nearSailors : null;
    const skinned = ns?.write(n, b, look, dt) === true;
    b.helmNet = skinned && ns !== null ? ns.netAt(b.slot) : null;
    // Out on a wire: the figure on the wire, if its look's is made; else on the rail.
    let wire = skinned ? 0 : (p.wire ?? 0);
    if (wire !== 0 && (drawn.wire === null || drawn.wireHooks === null)) {
      placeSailor(b.sailor, b.mode, b.heel, this.#frame, side, p, false);
      seat[o] = p.x;
      seat[o + 1] = p.y;
      seat[o + 2] = p.z;
      seat[o + 3] = p.facing;
      lean[ol] = p.tilt;
      wire = 0;
    }
    if (skinned && ns !== null) {
      this.#hookSide = ns.hook(b.slot, this.#hook);
    } else if (wire !== 0 && drawn.wireHooks !== null) {
      this.#hook.copy(drawn.wireHooks[wire > 0 ? 0 : 1]).add(wireB.set(p.x, p.y, p.z));
      this.#hookSide = wire;
    }
    const rows = level.rows;
    const figure = wire > 0 ? 1 : wire < 0 ? 2 : 0;
    this.#head(rows.data, rows.width * n, n, level, d.colours, drawn, !skinned, false, b, figure);
    if (ns !== null) {
      this.#head(ns.data, ns.width * n, n, level, d.colours, drawn, false, skinned, b);
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
   * boat's values from instance n of level, its sailor's colours, the
   * layer drawn, and whether it is drawn rigid or skinned (with its sway).
   */
  #head(
    d: Float32Array,
    at: number,
    n: number,
    level: Level,
    c: SailorColours,
    drawn: FleetLook,
    rigid: boolean,
    skinned: boolean,
    b: DrawnBoat,
    /** The rigid figure's pose: seated (0), or out on a wire to starboard (1) or port (2). */
    pose = 0,
  ): void {
    const r = 4 * at;
    const o = 4 * n;
    for (let k = 0; k < 4; k++) {
      d[r + k] = level.pose.array[o + k] as number;
      d[r + 4 + k] = level.lean.array[n * LEAN_STRIDE + k] as number;
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
    d[r + 23] = rigid ? 1 + pose : 0;
    if (skinned && this.nearSailors !== null) {
      swayOf(this.#shared.windFrom, this.#shared.windSpeed, b, this.#sway);
      d[r + 24] = this.#sway.x;
      d[r + 25] = this.#sway.z;
      d[r + 26] = this.nearSailors.seated(b.slot);
    }
    d[r + 27] = skinned ? 1 : 0;
  }

  /** The fleet's sailors' meshes in this view: the rigid figures of each level and the skinned ones. */
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
}

/**
 * The other boats, every kind's: a view for each kind made when a boat of
 * it first comes into view (the first kind's at once: its model seats the
 * fleet's sailors), the nearest few of all drawn with the full model.
 */
export class FleetViews {
  readonly root = new Group();
  /** Each kind's view, by its index among the catalog's boats; undefined until a boat of it is seen. */
  readonly views: (FleetView | undefined)[] = [];
  loaded = false;
  readonly #kinds: readonly BoatKind[];
  readonly #shared: Shared;
  /** The looks are ready for each view as it loads. */
  #sailorsReady = false;

  /** Where a beach cat's crew in a view slot hangs on her wire, as the crews' drawing tells it (Shared's crewHook). */
  set crewHook(f: (slot: number, out: Vector3) => number) {
    this.#shared.crewHook = f;
  }
  /** The near level's shadows, for each view as it is made. */
  #shadows = { cast: false, receive: false };
  readonly #nearest = new Int32Array(NEAR_MODELS);
  readonly #nearestD = new Float64Array(NEAR_MODELS);
  #version = -1;
  #frames = 0;
  #ms = 0;
  /** Called when a kind's view has loaded and is ready to draw (its shaders to compile). */
  onView: ((view: FleetView) => void) | null = null;

  /** The catalog's boats, and their looks. */
  constructor(kinds: readonly BoatKind[], boatLooks: BoatLooks) {
    this.#kinds = kinds;
    this.#shared = new Shared(boatLooks);
    this.root.name = 'fleet';
  }

  /** The names' texture, once a view has loaded: the tests' count of its redraws. */
  get names(): NameAtlas | null {
    return this.#shared.names;
  }

  /** The first kind's view: what seats the fleet's sailors. */
  get first(): FleetView {
    return this.#view(0) as FleetView;
  }

  /** The wind the sailors' cloth streams in: from (radians) and speed (m/s). */
  set windFrom(v: number) {
    this.#shared.windFrom = v;
  }

  set windSpeed(v: number) {
    this.#shared.windSpeed = v;
  }

  /** The fleet's looks, once its sailors are loaded. */
  get looks(): FleetLooks | null {
    return this.#shared.looks;
  }

  /** Loads the first kind's boats; their sailors come with loadSailors. */
  async load(): Promise<void> {
    await this.#loadView(this.#view(0) as FleetView);
    this.loaded = true;
  }

  /** A kind's view, made the first time it is asked for; undefined for a kind the catalog has not. */
  #view(kind: number): FleetView | undefined {
    const had = this.views[kind];
    if (had !== undefined) {
      return had;
    }
    const k = this.#kinds[kind];
    if (k === undefined) {
      return undefined;
    }
    const v = new FleetView(k, kind, this.#shared);
    this.views[kind] = v;
    return v;
  }

  async #loadView(v: FleetView): Promise<void> {
    await v.load();
    const looks = this.#shared.looks;
    if (this.#sailorsReady && looks !== null) {
      v.useLooks(looks);
    }
    Shadows.cast(v.near.group, this.#shadows.cast, this.#shadows.receive);
    this.root.add(v.root);
    this.onView?.(v);
  }

  /**
   * Loads the boats' sailors: the look every boat is drawn with until its
   * own has loaded (its deck and far levels and clips: the player's own),
   * now; every other look when a boat with it is first in view. files
   * gives the URL of a sailor's file; the renderer decides how textures
   * are transcoded.
   */
  async loadSailors(
    cat: Looks,
    first: SailorLook,
    renderer: WebGPURenderer,
    files: ArtFiles,
  ): Promise<void> {
    const stage = this.views[0]?.parts ?? null;
    if (stage === null) {
      throw new Error('the fleet’s boats are not loaded');
    }
    const g = stage.gunwale;
    // Seated about the gunwale of the boat the clips were placed in, where
    // a hiking sailor leans out from; each kind's instances seat them in
    // its own.
    const looks = new FleetLooks(renderer, { out: g.x, y: g.y, z: stage.seatZ }, files);
    const firstLook = looks.add(first.art, first.machine);
    await looks.ready(firstLook, true);
    if (looks.far === null) {
      throw new Error('the fleet’s sailor did not load');
    }
    const shared = this.#shared;
    shared.cat = cat;
    shared.first = firstLook;
    shared.looks = looks;
    this.#version = looks.version;
    this.#sailorsReady = true;
    for (const v of this.views) {
      if (v?.loaded === true) {
        v.useLooks(looks);
      }
    }
  }

  /** The look a boat's sailor is drawn in, and its colours; null before the sailors are loaded. */
  lookOf(b: DrawnBoat): DrawnLook | null {
    return this.#shared.lookOf(b);
  }

  /** Makes the near boats cast the sun's shadow or not, and receive it or not; the far never cast. */
  castShadows(cast: boolean, receive: boolean): void {
    this.#shadows = { cast, receive };
    for (const v of this.views) {
      if (v !== undefined) {
        Shadows.cast(v.near.group, cast, receive);
      }
    }
  }

  /** Takes the looks' figures anew, when a look has loaded. */
  #pools(): void {
    const looks = this.#shared.looks;
    if (looks === null || looks.version === this.#version) {
      return;
    }
    this.#version = looks.version;
    const old = new Set<BufferGeometry>();
    for (const v of this.views) {
      v?.takePools(looks, old);
    }
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
    this.#shared.time.value = time % (2 * Math.PI);
    this.#shared.frame++;
    this.#pools();
    // The nearest few within range get the full model, whatever their kind.
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
    for (const v of this.views) {
      v?.begin(time);
    }
    const ease = dt > 0 ? 1 - Math.exp(-dt / RIPPLE_EASE) : 0;
    for (let i = 0; i < count; i++) {
      const b = boats[i] as DrawnBoat;
      if (b.opacity <= 0) {
        continue;
      }
      const v = this.#view(b.kind);
      if (v === undefined) {
        continue;
      }
      if (!v.loaded) {
        // Its kind's first boat in view: its models are loaded, and it is
        // drawn once they are.
        if (v.parts === null && !this.#loading.has(v)) {
          this.#loading.add(v);
          this.#loadView(v)
            .catch((e: unknown) => {
              console.error(`the fleet’s ${v.kind.name} did not load`, e);
            })
            .finally(() => this.#loading.delete(v));
        }
        continue;
      }
      let near = false;
      for (let k = 0; k < nearN; k++) {
        if (this.#nearest[k] === i) {
          near = true;
        }
      }
      v.write(b, near, origin, ease, dt);
    }
    for (const v of this.views) {
      v?.commit();
    }
    this.#shared.names?.commit();
    this.#frames++;
    this.#ms += performance.now() - start;
  }

  readonly #loading = new Set<FleetView>();

  /** Whether a kind's view is loading: one first seen not yet drawn. */
  get loading(): boolean {
    return this.#loading.size > 0;
  }

  /** Every loaded view's levels: near and far, for the tests. */
  levels(): Level[] {
    return this.#loaded().flatMap((v) => [v.near, v.far]);
  }

  #loaded(): FleetView[] {
    return this.views.filter((v): v is FleetView => v?.loaded === true);
  }

  /** How many boats drawn this frame carry a person, and how many a machine. */
  figures(): { people: number; machines: number } {
    let all = 0;
    let machines = 0;
    for (const l of this.levels()) {
      all += l.count;
      machines += l.machines;
    }
    return { people: all - machines, machines };
  }

  /** The fleet's sailors' meshes: every view's. */
  sailorMeshes(): Mesh[] {
    return this.#loaded().flatMap((v) => v.sailorMeshes());
  }

  /** The draw calls the fleet's sailors make this frame. */
  sailorDraws(): number {
    return this.sailorMeshes().filter((m) => (m as InstancedMesh).count > 0).length;
  }

  /** The boats drawn at each level, every kind's, and those near drawn skinned. */
  counts(): { near: number; far: number; skinned: number; nearMeshes: number; farMeshes: number } {
    const c = { near: 0, far: 0, skinned: 0, nearMeshes: 0, farMeshes: 0 };
    for (const v of this.#loaded()) {
      c.near += v.near.count;
      c.far += v.far.count;
      c.skinned += v.near.count - v.near.rigid;
      c.nearMeshes += v.near.meshes.length;
      c.farMeshes += v.far.meshes.length;
    }
    return c;
  }

  /** Every near sailor forgotten: the next frame meets each afresh. */
  forgetSailors(): void {
    for (const v of this.views) {
      v?.nearSailors?.forget();
    }
  }

  /** The draw calls and triangles the fleet's meshes make this frame. */
  budget(): { drawCalls: number; triangles: number } {
    let drawCalls = 0;
    let triangles = 0;
    const sailors = this.sailorMeshes();
    for (const level of this.levels()) {
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
    // The trapeze wires: a draw of lines a kind.
    for (const v of this.#loaded()) {
      if (v.wires?.mesh.visible === true) {
        drawCalls++;
      }
    }
    return { drawCalls, triangles };
  }

  /**
   * Since last asked: the frames drawn, the milliseconds the fleet's update
   * took (its sailors' runs, the rows and the boats' values), and how many
   * times a near sailor ran.
   */
  work(): { frames: number; ms: number; runs: number } {
    let runs = 0;
    for (const v of this.views) {
      if (v?.nearSailors != null) {
        runs += v.nearSailors.runs;
        v.nearSailors.runs = 0;
      }
    }
    const r = { frames: this.#frames, ms: this.#ms, runs };
    this.#frames = 0;
    this.#ms = 0;
    return r;
  }
}

const wireA = new Vector3();
const wireB = new Vector3();

/**
 * A point of a boat's model placed as the parts' placePoint places it:
 * heeled and pitched about the centre of gravity's height, turned to the
 * heading, and set at the scene's x and z, lifted by the heave.
 */
function placeOnCpu(
  p: Vector3,
  cog: number,
  x: number,
  z: number,
  heading: number,
  heel: number,
  heave: number,
  pitch: number,
  out: Vector3,
): Vector3 {
  // About the pivot: a turn of −heel about z, then pitch about x.
  let px = p.x;
  let py = p.y - cog;
  let pz = p.z;
  let c = Math.cos(-heel);
  let s = Math.sin(-heel);
  [px, py] = [px * c - py * s, px * s + py * c];
  c = Math.cos(pitch);
  s = Math.sin(pitch);
  [py, pz] = [py * c - pz * s, py * s + pz * c];
  py += cog;
  // The heading: a turn of −heading about y.
  c = Math.cos(-heading);
  s = Math.sin(-heading);
  return out.set(px * c + pz * s + x, py + heave, pz * c - px * s + z);
}

function trianglesOf(g: BufferGeometry | null): number {
  if (g === null) {
    return 0;
  }
  const index = g.index;
  return (index !== null ? index.count : g.getAttribute('position').count) / 3;
}

/** The root of a model's nodes, by name: the parent of them all. */
function rootOf(objects: Map<string, Object3D>): Object3D {
  let root: Object3D | null = objects.get('hull') ?? objects.values().next().value ?? null;
  while (root?.parent != null) {
    root = root.parent;
  }
  return root as Object3D;
}
