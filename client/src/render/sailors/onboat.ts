// SPDX-License-Identifier: AGPL-3.0-only

// The sailor on the boat in view (the player's own, or the one watched),
// drawn in full: the deck level skinned, posed every frame by the sailor
// runtime from the physics; the close level in its place when the camera is
// near; the tiller extension swung on its hinge to the aft hand; and the
// mainsheet from its block under the boom down to the block on the floor
// and up to the forward hand.
//
// The figure is a child of the boat's model, placed by the runtime's root
// (the clips' places, from the build): what it sits on is the boat model's
// own deck.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  type Group,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Vector3,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { Boat as BoatKind } from '../../catalog';
import type { BoatPose } from '../../predict/blend';
import { RECORDS } from '../../predict/layout.gen';
import { litMaterial } from '../materials';
import { Clip } from './clips';
import { sailorColours } from './material';
import { loadClips, loadSailor, type SailorModel } from './model';
import { bonesFor, Rig } from './rig';
import { type SailorBoat, type SailorMoment, SailorRuntime } from './runtime';
import { hullSolid } from './solid';

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
  readonly #urls: SailorUrls;
  readonly #renderer: WebGPURenderer;
  readonly #boat: SailorBoat;
  readonly #moment: SailorMoment;
  readonly #rope: Mesh;
  readonly #ropePoints = [new Vector3(), new Vector3(), new Vector3()];
  readonly #still: boolean;
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
  ) {
    this.#model = model;
    this.#parts = parts;
    this.#deck = deck;
    this.rig = rig;
    this.#boat = boat;
    this.#urls = urls;
    this.#renderer = renderer;
    this.runtime = new SailorRuntime(rig, clips, boat, seed);
    this.#deckBones = bonesFor(rig, deck.root);
    deck.root.name = 'sailor figure';
    deck.root.matrixAutoUpdate = false;
    model.add(deck.root);
    this.#rope = rope();
    model.add(this.#rope);
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
   * model is loaded (its parts by name).
   */
  static async load(
    urls: SailorUrls,
    renderer: WebGPURenderer,
    model: Group,
    parts: Map<string, Object3D>,
    kind: BoatKind,
    seed: number,
  ): Promise<BoatSailor> {
    const c = urls.colours;
    const colours = sailorColours(c.main, c.skin, c.hair);
    const [deck, clipFile] = await Promise.all([
      loadSailor(urls.model, renderer, colours),
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
    const hinge = at('extension');
    const grip = at('grip');
    const gunwale = at('gunwale');
    const seat = at('sailor');
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
    };
    return new BoatSailor(model, parts, deck, rig, clips, boat, urls, renderer, seed);
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
    const close = near && this.#close !== null;
    this.#deck.root.visible = !close;
    if (this.#close !== null) {
      this.#close.root.visible = close;
    }
  }

  async #loadClose(): Promise<void> {
    const deckMesh = this.#deck.meshes[0];
    const shared = (deckMesh?.userData ?? {}) as { main: Color; skin: Color; hair: Color };
    const close = await loadSailor(await this.#urls.close(), this.#renderer, shared);
    close.root.matrixAutoUpdate = false;
    for (const mesh of close.meshes) {
      mesh.castShadow = deckMesh?.castShadow ?? false;
      mesh.receiveShadow = deckMesh?.receiveShadow ?? false;
    }
    close.root.visible = false;
    this.#closeBones = bonesFor(this.rig, close.root);
    this.#model.add(close.root);
    this.#close = close;
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
