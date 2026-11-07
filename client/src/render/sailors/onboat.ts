// SPDX-License-Identifier: AGPL-3.0-only

// The sailor on the boat in view (the player's own, or the one watched),
// drawn in full: the deck level skinned, posed every frame by the sailor
// runtime from the physics; the close level in its place when the camera is
// near; the tiller extension swung on its hinge to the aft hand; and the
// mainsheet from its block under the boom down to the block on the floor
// and up to the forward hand.
//
// On a boat steered by a wheel (its model's `wheel` node), the sailor stands
// at it, its hands on the spokes as the wheel turns: no extension, no
// mainsheet.
//
// The figure is a child of the boat's model, placed by the runtime's root
// (the clips' places, from the build, moved to this boat's seat if it is
// not the boat they were placed in): what it sits on is the boat model's
// own deck. A machine lives by its own layers, and its lamps glow as they
// say.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  DoubleSide,
  type Group,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { dot, float, mix, saturate, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind } from '../../catalog';
import type { BoatPose } from '../../predict/blend';
import { RECORDS } from '../../predict/layout.gen';
import { fallToEdge, glowMaterial, litMaterial } from '../materials';
import { Clip } from './clips';
import { type SailorColours, sailorColours, sailorLight } from './material';
import { loadClips, loadSailor, type SailorModel } from './model';
import { seating } from './restage';
import { bonesFor, Rig } from './rig';
import { type SailorBoat, type SailorMoment, SailorRuntime } from './runtime';
import { type HullSolid, hullSolid } from './solid';
import { turnIn, wheelOf, wheelTurnOf } from './wheel';

/** Nearer than this to the camera the close level is drawn, metres; back to the deck level beyond the second. */
export const CLOSE_IN = 6;
const CLOSE_OUT = 6.5;

/** The mainsheet's radius, and the sides of its tube. */
const ROPE_RADIUS = 0.006;
const ROPE_SIDES = 5;

/** A sailor's art as the catalog names it, as URLs. */
export interface SailorUrls {
  model: string;
  /** The close level's URL, fetched when first wanted. */
  close: () => Promise<string>;
  clips: string;
  colours: { main: string; skin: string; hair: string };
}

const v = new Vector3();
const w = new Vector3();
const m = new Matrix4();
const m2 = new Matrix4();
const FORWARD = new Vector3(0, 0, -1);

/** The skeleton's bones in a level's scene: the Root node and all under it. */
export function boneNames(root: Object3D): string[] {
  const top = root.getObjectByName('Root');
  const out: string[] = [];
  top?.traverse((o) => out.push(o.name));
  return out;
}

export class BoatSailor {
  readonly rig: Rig;
  readonly runtime: SailorRuntime;
  readonly #model: Group;
  readonly #parts: Map<string, Object3D>;
  readonly #deck: SailorModel;
  readonly #deckBones: (Object3D | null)[];
  #close: SailorModel | null = null;
  #closeBones: (Object3D | null)[] = [];
  #closeLoading = false;
  #near = false;
  #shown = true;
  readonly #urls: SailorUrls;
  readonly #renderer: WebGPURenderer;
  readonly #boat: SailorBoat;
  readonly #moment: SailorMoment;
  readonly #rope: Mesh;
  readonly #ropePoints = [new Vector3(), new Vector3(), new Vector3()];
  readonly #still: boolean;
  readonly #machine: boolean;
  /** A machine's lantern's glow, where its file puts the lantern; and the lantern at rest against its bone. */
  readonly #glow: Mesh | null = null;
  readonly #glowStrength = uniform(1);
  readonly #lanternBone: number = -1;
  readonly #lanternRest = new Matrix4();
  /** The wheel's node and its turn at rest, on a boat steered by one. */
  readonly #wheelNode: Object3D | null;
  readonly #wheelRest = new Quaternion();
  #time = 0;

  private constructor(
    model: Group,
    parts: Map<string, Object3D>,
    deck: SailorModel,
    rig: Rig,
    clips: Map<string, Clip>,
    boat: SailorBoat,
    urls: SailorUrls,
    renderer: WebGPURenderer,
    seed: number,
    machine: boolean,
  ) {
    this.#model = model;
    this.#machine = machine;
    this.#parts = parts;
    this.#deck = deck;
    this.rig = rig;
    this.#boat = boat;
    this.#urls = urls;
    this.#renderer = renderer;
    this.runtime = new SailorRuntime(rig, clips, boat, seed, machine);
    this.#wheelNode = boat.wheel ? (parts.get('wheel') ?? null) : null;
    if (this.#wheelNode !== null) {
      turnIn(this.#wheelNode, model, this.#wheelRest);
    }
    this.#deckBones = bonesFor(rig, deck.root);
    deck.root.name = 'sailor figure';
    deck.root.matrixAutoUpdate = false;
    model.add(deck.root);
    this.#rope = rope();
    model.add(this.#rope);
    const lantern = deck.places.get('place-lantern');
    if (machine && lantern !== undefined) {
      // The lantern's place against its bone (the back's) at rest: it
      // moves with the bone.
      this.#lanternBone = rig.bone(LANTERN_BONE);
      rig.reset();
      rig.fk();
      this.#lanternRest
        .fromArray(rig.world, 16 * this.#lanternBone)
        .invert()
        .multiply(lantern);
      this.#glow = lanternGlow(deck.meshes[0]?.userData.hair as Color, this.#glowStrength);
      model.add(this.#glow);
    }
    this.#still =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#moment = {
      dt: 0,
      time: 0,
      offset: 0,
      mode: 0,
      timer: 0,
      heel: 0,
      pitch: 0,
      heave: 0,
      windSpeed: 0,
      windAngle: 0,
      rollRate: 0,
      still: this.#still,
    };
  }

  /**
   * Loads the sailor's deck level and clips and seats it in a boat whose
   * model is loaded (its parts by name); a machine, if it is one.
   */
  static async load(
    urls: SailorUrls,
    renderer: WebGPURenderer,
    model: Group,
    parts: Map<string, Object3D>,
    kind: BoatKind,
    seed: number,
    machine = false,
  ): Promise<BoatSailor> {
    const c = urls.colours;
    const colours = sailorColours(c.main, c.skin, c.hair);
    const [deck, clipFile] = await Promise.all([
      loadSailor(urls.model, renderer, colours, machine),
      loadClips(urls.clips, renderer),
    ]);
    const rig = Rig.from(deck.root, boneNames(deck.root));
    const clips = new Map<string, Clip>();
    const identity = new Matrix4();
    for (const a of clipFile.clips) {
      const place = clipFile.places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(identity) ? place : null),
      );
    }
    const at = (name: string): Vector3 | null => {
      const o = parts.get(name);
      return o === undefined ? null : modelPosition(o, model, new Vector3());
    };
    const { foils, sailor } = kind.physics;
    const solid = hullSolid(parts.get('hull')?.userData, at('board-root'), {
      span: foils.boardSpan,
      chord: foils.boardChord,
    });
    const wheel = wheelOf(parts, model);
    const seat = at('sailor');
    if (wheel !== null && seat !== null) {
      // At the wheel: what the seat and the tiller would be is the
      // helmsman's place; the hull's solid only if the model has it.
      const boat: SailorBoat = {
        hinge: seat.clone(),
        hingeRest: seat,
        extension: 0,
        seatY: seat.y,
        seatIn: 0,
        seatOut: 0,
        seatZ: seat.z,
        cog: kind.physics.hull.centreOfGravity,
        solid: solid ?? NO_SOLID,
        climbTime: sailor.climbTime,
        wheel,
      };
      return new BoatSailor(model, parts, deck, rig, clips, boat, urls, renderer, seed, machine);
    }
    const hinge = at('extension');
    const grip = at('grip');
    const gunwale = at('gunwale');
    if (solid === null || hinge === null || grip === null || gunwale === null || seat === null) {
      throw new Error('the boat model has no solid, extension, gunwale or seat for its sailor');
    }
    const boat: SailorBoat = {
      hinge: hinge.clone(),
      hingeRest: hinge,
      extension: hinge.distanceTo(grip),
      seatY: gunwale.y,
      seatIn: solid.cockpit.halfWidth,
      seatOut: gunwale.x,
      seatZ: seat.z,
      cog: kind.physics.hull.centreOfGravity,
      solid,
      climbTime: sailor.climbTime,
      ...seating(parts, sailor.hikeReach),
    };
    return new BoatSailor(model, parts, deck, rig, clips, boat, urls, renderer, seed, machine);
  }

  /** Takes new colours, #RRGGBB: its main colour, skin or metal, and hair or lamps' light. */
  colour(c: { main: string; skin: string; hair: string }): void {
    const shared = (this.#deck.meshes[0]?.userData ?? {}) as Partial<SailorColours>;
    shared.main?.set(c.main);
    shared.skin?.set(c.skin);
    shared.hair?.set(c.hair);
  }

  /** The figure's root, under the boat's model. */
  get figure(): Object3D {
    return this.#deck.root;
  }

  /** The level drawn: the close one when the camera is within CLOSE_IN of the sailor. */
  near(distance: number): void {
    const near = this.#near ? distance < CLOSE_OUT : distance < CLOSE_IN;
    this.#near = near;
    if (near && this.#close === null && !this.#closeLoading) {
      this.#closeLoading = true;
      void this.#loadClose();
    }
    this.#levels();
  }

  /** Whether the sailor is drawn: a boat keeps a person and a machine, and draws the one aboard. */
  get shown(): boolean {
    return this.#shown;
  }

  set shown(on: boolean) {
    this.#shown = on;
    this.#rope.visible = on;
    if (this.#glow !== null) {
      this.#glow.visible = on;
    }
    this.#levels();
  }

  #levels(): void {
    const close = this.#near && this.#close !== null;
    this.#deck.root.visible = this.#shown && !close;
    if (this.#close !== null) {
      this.#close.root.visible = this.#shown && close;
    }
  }

  async #loadClose(): Promise<void> {
    const deckMesh = this.#deck.meshes[0];
    const shared = (deckMesh?.userData ?? {}) as { main: Color; skin: Color; hair: Color };
    const close = await loadSailor(await this.#urls.close(), this.#renderer, shared, this.#machine);
    close.root.matrixAutoUpdate = false;
    for (const mesh of close.meshes) {
      mesh.castShadow = deckMesh?.castShadow ?? false;
      mesh.receiveShadow = deckMesh?.receiveShadow ?? false;
    }
    close.root.visible = false;
    this.#closeBones = bonesFor(this.rig, close.root);
    this.#model.add(close.root);
    this.#close = close;
    this.#levels();
  }

  /** Poses the sailor for the boat's pose and the step's Out; dt in seconds. */
  draw(pose: BoatPose, out: Float64Array, dt: number): void {
    this.#time += dt;
    // The extension's hinge, where the rudder has swung it.
    const parts = this.#parts;
    const ext = parts.get('extension');
    if (ext !== undefined) {
      ext.quaternion.identity();
      modelPosition(ext, this.#model, this.#boat.hinge);
    }
    const wheel = this.#boat.wheel;
    if (wheel && this.#wheelNode !== null) {
      // The wheel as the rudder has turned it.
      wheel.turn = wheelTurnOf(this.#wheelNode, this.#model, this.#wheelRest);
    }
    const mo = this.#moment;
    mo.dt = dt;
    mo.time = this.#time;
    mo.offset = pose.sailor;
    mo.mode = pose.sailorMode;
    mo.timer = pose.sailorTimer;
    mo.heel = pose.heel;
    mo.pitch = pose.pitch;
    mo.heave = pose.heave;
    mo.rollRate = pose.rollRate;
    mo.windSpeed = out[RECORDS.out.apparentWindSpeed] ?? 0;
    mo.windAngle = out[RECORDS.out.apparentWindAngle] ?? 0;
    const rt = this.runtime;
    rt.update(mo);
    if (this.#machine) {
      this.#glowStrength.value = rt.glow;
      if (this.#glow !== null) {
        // The bone now, times the lantern against it, into the model.
        m.fromArray(this.rig.world, 16 * this.#lanternBone).multiply(this.#lanternRest);
        this.#glow.position.setFromMatrixPosition(m).applyMatrix4(rt.root);
      }
      for (const m of this.#deck.meshes) {
        m.userData.glow = rt.glow;
      }
      if (this.#close !== null) {
        for (const m of this.#close.meshes) {
          m.userData.glow = rt.glow;
        }
      }
    }
    this.rig.write(this.#deckBones);
    this.#deck.root.matrix.copy(rt.root);
    this.#deck.root.matrixWorldNeedsUpdate = true;
    if (this.#close !== null) {
      this.rig.write(this.#closeBones);
      this.#close.root.matrix.copy(rt.root);
      this.#close.root.matrixWorldNeedsUpdate = true;
    }
    // The extension swung on its hinge to the aft hand.
    if (ext !== undefined && rt.hands.tiller && ext.parent !== null) {
      // The hand in the tiller's frame.
      parentToModel(ext.parent, this.#model, m);
      v.copy(rt.hands.tillerAt).applyMatrix4(m2.copy(m).invert()).sub(ext.position);
      if (v.lengthSq() > 1e-8) {
        ext.quaternion.setFromUnitVectors(FORWARD, v.normalize());
      }
    }
    this.#drawRope(rt.hands.sheet ? rt.hands.sheetAt : null);
  }

  /** The mainsheet: boom block, floor block, and the hand (or lying on the floor). */
  #drawRope(hand: Vector3 | null): void {
    const boomBlock = this.#parts.get('sheet-boom');
    const floorBlock = this.#parts.get('sheet');
    if (boomBlock === undefined || floorBlock === undefined) {
      this.#rope.visible = false;
      return;
    }
    const pts = this.#ropePoints;
    const a = pts[0] as Vector3;
    const b = pts[1] as Vector3;
    const c = pts[2] as Vector3;
    modelPosition(boomBlock, this.#model, a);
    modelPosition(floorBlock, this.#model, b);
    if (hand !== null) {
      c.copy(hand);
    } else {
      // Let go: its tail lies on the floor, aft of the block.
      c.copy(b).add(w.set(0, -0.04, 0.35));
    }
    tube(this.#rope.geometry, this.#ropePoints, ROPE_RADIUS);
  }
}

/** A hull with nothing in it: a boat at whose wheel the sailor stands needs none. */
export const NO_SOLID: HullSolid = {
  stations: [],
  exponent: 2,
  cockpit: { fore: 0, aft: 0, halfWidth: 0, floor: 0 },
  board: { y: 0, z: 0, span: 0, chord: 0, thickness: 0 },
};

/** The bone a machine's lantern rides on. */
const LANTERN_BONE = 'spine_03';
/** The lantern's glow: its size, metres, and its strength by day and by night. */
const GLOW_SIZE = 0.3;
const GLOW_DAY = 0.12;
const GLOW_NIGHT = 0.9;
/** The main light's brightness at and above which it is full day. */
const DAYLIGHT = 1.5;

/**
 * A lantern's glow: three squares crossed at its middle, so it shows from
 * every side, each a soft disc added to the picture (the factory's glow:
 * no fog), in the lamps' light, as strong as strength (their pulse), and
 * stronger by night.
 */
function lanternGlow(colour: Color, strength: Node<'float'>): Mesh {
  const g = new BufferGeometry();
  const h = GLOW_SIZE / 2;
  const pos: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  for (let k = 0; k < 3; k++) {
    const base = pos.length / 3;
    for (const [a, b] of corners) {
      const [u, v] = [a * h, b * h];
      // The squares across x, y and z.
      pos.push(...(k === 0 ? [0, u, v] : k === 1 ? [u, 0, v] : [u, v, 0]));
      uvs.push((a + 1) / 2, (b + 1) / 2);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(index);
  const m = glowMaterial();
  m.name = 'machine lantern';
  m.side = DoubleSide;
  const at = uv().sub(0.5).mul(2);
  const main = sailorLight.main as unknown as Node<'vec3'>;
  const day = saturate(dot(main, vec3(0.2126, 0.7152, 0.0722)).div(DAYLIGHT));
  const k = strength
    .mul(mix(float(GLOW_NIGHT), float(GLOW_DAY), day))
    .mul(fallToEdge(dot(at, at), 4));
  m.fragmentNode = vec4(vec3(colour.r, colour.g, colour.b).mul(k), 1) as unknown as Node<'vec4'>;
  const mesh = new Mesh(g, m);
  mesh.name = 'machine lantern';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return mesh;
}

/** Where a node is in the model's frame, from the local transforms between them. */
function modelPosition(o: Object3D, model: Object3D, out: Vector3): Vector3 {
  out.copy(o.position);
  for (let p = o.parent; p !== null && p !== model; p = p.parent) {
    p.updateMatrix();
    out.applyMatrix4(p.matrix);
  }
  return out;
}

/** A node's frame in the model's, from the local transforms between them. */
function parentToModel(o: Object3D, model: Object3D, out: Matrix4): Matrix4 {
  out.identity();
  for (let p: Object3D | null = o; p !== null && p !== model; p = p.parent) {
    p.updateMatrix();
    out.premultiply(p.matrix);
  }
  return out;
}

/** The mainsheet's mesh: a tube along three points, its vertices set each frame. */
function rope(): Mesh {
  const g = new BufferGeometry();
  const rings = 3;
  const n = rings * ROPE_SIDES;
  g.setAttribute('position', new BufferAttribute(new Float32Array(3 * n), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(3 * n), 3));
  const index: number[] = [];
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < ROPE_SIDES; s++) {
      const a = r * ROPE_SIDES + s;
      const b = r * ROPE_SIDES + ((s + 1) % ROPE_SIDES);
      const c = a + ROPE_SIDES;
      const d = b + ROPE_SIDES;
      index.push(a, c, b, b, c, d);
    }
  }
  g.setIndex(index);
  const mesh = new Mesh(
    g,
    litMaterial({
      color: 0x4d3b2a,
      roughness: 0.9,
      metalness: 0,
    }) as unknown as MeshStandardMaterial,
  );
  mesh.name = 'mainsheet';
  mesh.frustumCulled = false;
  return mesh;
}

const t = new Vector3();
const n1 = new Vector3();
const n2 = new Vector3();

/** Sets a tube's rings round each point, square to the path there. */
function tube(g: BufferGeometry, points: Vector3[], r: number): void {
  const pos = g.getAttribute('position') as BufferAttribute;
  const nor = g.getAttribute('normal') as BufferAttribute;
  for (let k = 0; k < points.length; k++) {
    const p = points[k] as Vector3;
    const prev = points[Math.max(0, k - 1)] as Vector3;
    const next = points[Math.min(points.length - 1, k + 1)] as Vector3;
    t.subVectors(next, prev).normalize();
    n1.set(0, 1, 0);
    if (Math.abs(t.y) > 0.9) {
      n1.set(1, 0, 0);
    }
    n1.cross(t).normalize();
    n2.crossVectors(t, n1);
    for (let s = 0; s < ROPE_SIDES; s++) {
      const a = (s / ROPE_SIDES) * 2 * Math.PI;
      w.copy(n1).multiplyScalar(Math.cos(a)).addScaledVector(n2, Math.sin(a));
      const i = k * ROPE_SIDES + s;
      nor.setXYZ(i, w.x, w.y, w.z);
      pos.setXYZ(i, p.x + w.x * r, p.y + w.y * r, p.z + w.z * r);
    }
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
}
