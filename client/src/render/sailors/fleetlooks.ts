// SPDX-License-Identifier: AGPL-3.0-only

// The looks the fleet draws, each loaded when a boat with it is first in
// view: its deck level, skinned, for the boats near the camera, and its far
// level, one rigid figure posed seated at the helm, for the rest; its clips
// when a boat with it first comes near. Every look's atlas and mask are a
// layer of two array textures (layers2d.ts), and every look's figures one
// geometry a level (a pool), each vertex tagged with its look's layer: so
// the fleet draws all its sailors, whatever their looks, in one draw a
// level, each boat's instance keeping only its own look's triangles.
//
// The far level's atlas is the deck level's made smaller, its islands in
// the same places: the far figures read the deck atlas, at the size they
// are drawn.
//
// A look someone at a station on a keelboat's rail wears has its clips on
// the rail and its crouch loaded too (rail.ts), and its far figures sat on
// the rail, upright and leaning out, each side, made from its far level as
// those on the wire are; kept by the look for whoever draws them.
//
// A look sailed on a boat with a trapeze has its clips on the wire loaded
// too, and its far figure posed out on the wire on each side, made from its
// far level: each vertex carried by its nearest bone from the helm's first
// frame to the wire's, placed from the rack's edge. Those figures are in
// the far level's pool with the seated one, tagged by side, so the fleet
// draws them in the same draw.
//
// The deck geometry keeps each vertex's bones and weights (as floats, the
// bones in the skeleton's order as the runtime has it), and a sway: how much
// of it hangs on the cloth's and hair's chains, further down the chain more,
// which the wind moves in the vertex stage, the springs' place in the
// fleet.

import {
  BufferAttribute,
  type BufferGeometry,
  Float32BufferAttribute,
  BufferGeometry as Geometry,
  Matrix3,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  SkinnedMesh,
  type Texture,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WebGPURenderer } from 'three/webgpu';
import type { SailorArt } from '../../catalog';
import { seatFigure } from '../fleetparts';
import { bridgeClips } from './bridgedeck';
import { catClips } from './cat';
import { Clip, Pose } from './clips';
import { LayeredTexture } from './layers2d';
import { gltfLoader, placesOf } from './model';
import { boneNames } from './onboat';
import { RAIL_CLIPS, railClips } from './rail';
import { Rig } from './rig';
import { aloftClips, shipClips } from './ship';
import { CHAINS } from './springs';
import { harnessFile, TRAPEZE_CLIPS, trapezeClips } from './trapeze';
import { wheelClips } from './wheel';
import { yachtClips } from './yacht';

/** Where the fleet's figures are seated: the boat model's seat (fleetparts.ts's seatFigure). */
export interface FleetSeat {
  out: number;
  y: number;
  z: number;
}

/** A look's deck level, ready to skin in the fleet. */
export interface DeckLook {
  /** Its meshes as one: position, normal, uv (in the atlas), bones, weights, and tag (layer, sway). */
  geometry: BufferGeometry;
  /** The skeleton at rest, to make each sailor's own from. */
  rig: Rig;
  /** Each bone's inverse bind matrix, column-major, in the rig's order. */
  inverse: Float32Array;
}

/** What a look is loading, or has. */
export type LookState = 'none' | 'loading' | 'ready' | 'failed';

export class FleetLook {
  /** The look's atlas layer, once loaded; −1 until. */
  layer = -1;
  state: LookState = 'none';
  clipsState: LookState = 'none';
  /** Its clips at a wheel, added to its clips when a boat in the fleet is steered by one. */
  wheelState: LookState = 'none';
  /** Its clips on a trapeze's wire, added to its clips when a boat with a trapeze carries it; and its far figures on the wire made. */
  trapezeState: LookState = 'none';
  /** Whether a boat with a trapeze carries it: its clips are wanted, near or far. */
  wired = false;
  /** Its clips on a rail and its crouch, added to its clips when someone wearing it is at a station on a rail; and its far figures there made. */
  railState: LookState = 'none';
  /** Whether someone wearing it is at a station on a rail: its clips are wanted, near or far. */
  railed = false;
  /** Its clips about a ship's decks, and her work and aloft (ship.ts), added to its clips when someone wearing it is aboard a ship; whether wanted. */
  shipState: LookState = 'none';
  aloftState: LookState = 'none';
  shipped = false;
  aloft = false;
  /** Its clips aboard a beach cat (cat.ts), added to its clips when someone wearing it is aboard one; whether wanted. */
  catState: LookState = 'none';
  catted = false;
  /** Its clips aboard a cruising yacht (yacht.ts), added to its clips when someone wearing it is aboard one; whether wanted. */
  cruiserState: LookState = 'none';
  yachted = false;
  /** Its clips aboard a cruising catamaran (bridgedeck.ts), added to its clips when someone wearing it is aboard one; whether wanted. */
  bridgeState: LookState = 'none';
  bridged = false;
  /** Whether a boat with it has come near: its clips are wanted. */
  near = false;
  deck: DeckLook | null = null;
  /** The far figure, seated, in figureNode's frame; uv in the atlas, tag (layer, 0). */
  far: BufferGeometry | null = null;
  /**
   * The far figure out fully on a trapeze's wire, on the starboard side
   * (tag (layer, 1)) and the port (tag (layer, 2)), each from the rack's
   * edge on its side; null until its clips on the wire have loaded.
   */
  wire: BufferGeometry | null = null;
  /** The harness's hook's eye on each of the wire figures (starboard, port), from the rack's edge on its side; and on the clips' figure at rest. */
  wireHooks: [Vector3, Vector3] | null = null;
  hook: Vector3 | null = null;
  /** The far figures on a rail (upright and leaning out, each side; railFigures), by clip; null until its clips there have loaded. */
  rail: Map<string, BufferGeometry> | null = null;
  clips: Map<string, Clip> | null = null;

  constructor(
    /** The look's number among the fleet's. */
    readonly index: number,
    readonly art: SailorArt,
    readonly machine: boolean,
  ) {}
}

/** The URLs of a look's files, which load them when first wanted. */
export type ArtFiles = (path: string) => Promise<string>;

export class FleetLooks {
  readonly atlas = new LayeredTexture('fleet sailors atlas');
  readonly mask = new LayeredTexture('fleet sailors mask');
  readonly looks: FleetLook[] = [];
  /** Every loaded look's deck figure as one geometry, and far figure as one; null until one is. */
  near: BufferGeometry | null = null;
  far: BufferGeometry | null = null;
  /** Counts the pools made, so their users know to take the new ones. */
  version = 0;
  /** How many bones every look's skeleton has (the first loaded one's). */
  bones = 0;
  /** Called when a look has loaded. */
  onLoad: (look: FleetLook) => void = () => {};
  /** Whether a boat in the fleet is steered by a wheel: its looks' clips at a wheel are loaded too. */
  wheel = false;

  constructor(
    readonly renderer: WebGPURenderer,
    readonly seat: FleetSeat,
    readonly files: ArtFiles,
  ) {}

  /** The look for a sailor's art, made the first time it is asked for (not loaded). */
  add(art: SailorArt, machine: boolean): FleetLook {
    const found = this.looks.find((l) => l.art === art);
    if (found !== undefined) {
      return found;
    }
    const look = new FleetLook(this.looks.length, art, machine);
    this.looks.push(look);
    return look;
  }

  /**
   * Starts loading a look's deck and far levels, if not yet; and its
   * clips, if near; and those on the wire, if a boat with a trapeze carries
   * it (wired); and those on a rail and the crouch, if someone wearing it is
   * at a station on one (railed).
   */
  want(
    look: FleetLook,
    near: boolean,
    wired = false,
    railed = false,
    shipped = false,
    aloft = false,
    catted = false,
    yachted = false,
    bridged = false,
  ): void {
    look.near ||= near;
    look.catted ||= catted;
    look.yachted ||= yachted;
    look.bridged ||= bridged;
    look.wired ||= wired;
    look.railed ||= railed;
    look.shipped ||= shipped || aloft;
    look.aloft ||= aloft;
    if (look.state === 'none') {
      look.state = 'loading';
      this.#load(look).then(
        () => {
          look.state = 'ready';
          this.onLoad(look);
          // Its clips at once, if a boat with it came near meanwhile.
          this.want(look, look.near);
        },
        (e: unknown) => {
          look.state = 'failed';
          console.error(`the fleet's sailor ${look.art.model} did not load`, e);
        },
      );
    }
    if (
      (look.near || look.wired || look.railed || look.shipped) &&
      look.state === 'ready' &&
      look.clipsState === 'none' &&
      look.deck !== null
    ) {
      look.clipsState = 'loading';
      this.#loadClips(look, look.deck.rig).then(
        () => {
          look.clipsState = 'ready';
          this.onLoad(look);
          // Its clips at a wheel, on the wire or on a rail at once, if wanted.
          this.want(look, false);
        },
        (e: unknown) => {
          look.clipsState = 'failed';
          console.error(`the fleet's sailor's clips ${look.art.clips} did not load`, e);
        },
      );
    }
    if (
      this.wheel &&
      look.clipsState === 'ready' &&
      look.wheelState === 'none' &&
      look.deck !== null
    ) {
      look.wheelState = 'loading';
      const path = wheelClips(look.art.clips);
      this.#loadClips(look, look.deck.rig, path).then(
        () => {
          look.wheelState = 'ready';
          this.onLoad(look);
        },
        (e: unknown) => {
          look.wheelState = 'failed';
          console.error(`the fleet's sailor's clips ${path} did not load`, e);
        },
      );
    }
    if (
      look.wired &&
      look.clipsState === 'ready' &&
      look.trapezeState === 'none' &&
      look.deck !== null
    ) {
      look.trapezeState = 'loading';
      const rig = look.deck.rig;
      const path = trapezeClips(look.art.clips);
      Promise.all([this.#loadClips(look, rig, path), this.#loadHook(look)]).then(
        () => {
          this.#wireFigures(look, rig);
          look.trapezeState = 'ready';
          this.onLoad(look);
        },
        (e: unknown) => {
          look.trapezeState = 'failed';
          console.error(`the fleet's sailor's clips ${path} did not load`, e);
        },
      );
    }
    if (
      look.railed &&
      look.clipsState === 'ready' &&
      look.railState === 'none' &&
      look.deck !== null
    ) {
      look.railState = 'loading';
      const rig = look.deck.rig;
      const path = railClips(look.art.clips);
      this.#loadClips(look, rig, path).then(
        () => {
          look.rail =
            look.far === null || look.clips === null
              ? null
              : railFigures(look.far, this.seat, look.clips, rig);
          look.railState = 'ready';
          this.onLoad(look);
        },
        (e: unknown) => {
          look.railState = 'failed';
          console.error(`the fleet's sailor's clips ${path} did not load`, e);
        },
      );
    }
    for (const [wanted, state, file] of [
      [look.shipped, 'shipState', shipClips],
      [look.aloft, 'aloftState', aloftClips],
      [look.catted && look.near, 'catState', catClips],
      [look.yachted && look.near, 'cruiserState', yachtClips],
      [look.bridged && look.near, 'bridgeState', bridgeClips],
    ] as const) {
      if (wanted && look.clipsState === 'ready' && look[state] === 'none' && look.deck !== null) {
        look[state] = 'loading';
        const path = file(look.art.clips);
        this.#loadClips(look, look.deck.rig, path).then(
          () => {
            look[state] = 'ready';
            this.onLoad(look);
          },
          (e: unknown) => {
            look[state] = 'failed';
            console.error(`the fleet's sailor's clips ${path} did not load`, e);
          },
        );
      }
    }
  }

  /** Loads a look in full, at once: for a look the first frame needs. */
  async ready(look: FleetLook, clips: boolean): Promise<void> {
    this.want(look, false);
    while (look.state === 'loading') {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (clips) {
      this.want(look, true);
      while (
        look.clipsState === 'loading' ||
        look.wheelState === 'loading' ||
        look.trapezeState === 'loading' ||
        look.railState === 'loading' ||
        look.shipState === 'loading' ||
        look.aloftState === 'loading' ||
        look.catState === 'loading' ||
        look.cruiserState === 'loading' ||
        look.bridgeState === 'loading'
      ) {
        await new Promise((r) => setTimeout(r, 10));
        this.want(look, true);
      }
    }
  }

  async #load(look: FleetLook): Promise<void> {
    const loader = gltfLoader(this.renderer);
    const [deckUrl, farUrl] = await Promise.all([
      this.files(look.art.model),
      this.files(look.art.far),
    ]);
    const [deck, far] = await Promise.all([loader.loadAsync(deckUrl), loader.loadAsync(farUrl)]);
    const meshes = meshesOf(deck.scene);
    const first = meshes[0];
    if (first === undefined) {
      throw new Error('no meshes');
    }
    const material = first.material as MeshStandardMaterial;
    const atlas = material.map;
    const mask = material.aoMap;
    if (atlas === null || mask === null) {
      throw new Error('no atlas and mask');
    }
    const layer = this.atlas.add(atlas);
    if (layer < 0 || this.mask.add(mask) !== layer) {
      throw new Error('its atlas or mask is not the size or format of the others');
    }
    atlas.dispose();
    mask.dispose();
    const rig = Rig.from(deck.scene, boneNames(deck.scene));
    if (this.bones === 0) {
      this.bones = rig.names.length;
    }
    if (rig.names.length === this.bones) {
      look.deck = deckLook(meshes, rig, uvMatrix(atlas), layer);
    }
    const farMeshes = meshesOf(far.scene);
    const farMap = (farMeshes[0]?.material as MeshStandardMaterial | undefined)?.map ?? null;
    const place = placesOf(far.scene).get('place') ?? null;
    const s = this.seat;
    const figure = seatFigure(far.scene, farMeshes, place, s.out, s.y, s.z);
    look.far = withAtlas(figure, farMap === null ? new Matrix3() : uvMatrix(farMap), layer);
    for (const m of [...farMeshes, ...meshes]) {
      m.geometry.dispose();
      (m.material as MeshStandardMaterial).map?.dispose();
      (m.material as MeshStandardMaterial).aoMap?.dispose();
      (m.material as MeshStandardMaterial).dispose();
    }
    look.layer = layer;
    this.#pools();
  }

  /** Loads a clips' file of a look's (its clips, or those at a wheel) into its clips. */
  async #loadClips(look: FleetLook, rig: Rig, path = look.art.clips): Promise<void> {
    const url = await this.files(path);
    const gltf = await gltfLoader(this.renderer).loadAsync(url);
    const places = placesOf(gltf.scene);
    const identity = new Matrix4();
    const clips = look.clips ?? new Map<string, Clip>();
    for (const a of gltf.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(identity) ? place : null),
      );
    }
    look.clips = clips;
  }

  /** A look's harness's hook's eye, from its file (the fleet draws no harness: too small). */
  async #loadHook(look: FleetLook): Promise<void> {
    const url = await this.files(harnessFile(look.art.clips));
    const gltf = await gltfLoader(this.renderer).loadAsync(url);
    const at = placesOf(gltf.scene).get('place-hook');
    look.hook = at === undefined ? null : new Vector3().setFromMatrixPosition(at);
  }

  /** A look's far figures on the wire, made from its far figure and its clips, into the pools. */
  #wireFigures(look: FleetLook, rig: Rig): void {
    const clips = look.clips;
    if (look.far === null || clips === null) {
      return;
    }
    const made = wireFigures(look.far, this.seat, clips, rig, look.hook);
    if (made !== null) {
      look.wire = made.geometry;
      look.wireHooks = made.hooks;
      this.#pools();
    }
  }

  /**
   * The pools made again from every loaded look. Whoever draws the old ones
   * frees them once it has taken the new ones.
   */
  #pools(): void {
    const near = this.looks.map((l) => l.deck?.geometry).filter((g) => g !== undefined);
    const far = this.looks.flatMap((l) =>
      l.far === null ? [] : l.wire === null ? [l.far] : [l.far, l.wire],
    );
    this.near = near.length > 0 ? merge(near) : null;
    this.far = far.length > 0 ? merge(far) : null;
    this.version++;
  }
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o instanceof Mesh) {
      out.push(o);
    }
  });
  return out;
}

/** Where a texture's transform (the file's KHR_texture_transform) puts a uv. */
function uvMatrix(t: Texture): Matrix3 {
  t.updateMatrix();
  return t.matrix.clone();
}

/** Merges geometries of the same attributes, with a 32-bit index. */
function merge(geometries: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  if (merged === null) {
    throw new Error('the fleet’s sailors do not merge');
  }
  const index = merged.index;
  if (index !== null && !(index.array instanceof Uint32Array)) {
    merged.setIndex(new Uint32BufferAttribute(Uint32Array.from(index.array), 1));
  }
  return merged;
}

/** A rigid figure with its uv moved into the atlas and its look's tag. */
function withAtlas(g: BufferGeometry, uv: Matrix3, layer: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const src = g.getAttribute('uv');
  const out = new Float32Array(2 * n);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.set(src.getX(i), src.getY(i), 1).applyMatrix3(uv);
    out[2 * i] = v.x;
    out[2 * i + 1] = v.y;
  }
  const tag = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    tag[2 * i] = layer;
  }
  const r = new Geometry();
  r.setAttribute('position', plain(g.getAttribute('position') as BufferAttribute, 3));
  r.setAttribute('normal', plain(g.getAttribute('normal') as BufferAttribute, 3));
  r.setAttribute('uv', new Float32BufferAttribute(out, 2));
  r.setAttribute('tag', new Float32BufferAttribute(tag, 2));
  const index = g.index;
  r.setIndex(
    index === null
      ? null
      : new Uint32BufferAttribute(
          Uint32Array.from({ length: index.count }, (_, i) => index.getX(i)),
          1,
        ),
  );
  g.dispose();
  return r;
}

/** An attribute as plain floats (the file's are quantized). */
function plain(a: BufferAttribute, size: number): Float32BufferAttribute {
  const out = new Float32Array(size * a.count);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < size; c++) {
      out[size * i + c] = a.getComponent(i, c);
    }
  }
  return new Float32BufferAttribute(out, size);
}

/**
 * The deck level's meshes as one geometry for the fleet: in the figure's
 * space, its bones in the rig's order, its uv in the atlas, and its tag.
 */
export function deckLook(meshes: Mesh[], rig: Rig, uv: Matrix3, layer: number): DeckLook {
  // How far down a cloth's or hair's chain each bone is, 0 to 1.
  const sway = new Float32Array(rig.names.length);
  for (const chain of CHAINS) {
    chain.forEach((name, k) => {
      const i = rig.bone(name);
      if (i >= 0) {
        sway[i] = (k + 1) / chain.length;
      }
    });
  }
  const inverse = new Float32Array(16 * rig.names.length);
  const parts: BufferGeometry[] = [];
  const v = new Vector3();
  const p = new Vector3();
  const nm = new Matrix3();
  for (const mesh of meshes) {
    if (!(mesh instanceof SkinnedMesh)) {
      continue;
    }
    // From each skeleton bone to the rig's.
    const bones = mesh.skeleton.bones.map((b) => rig.bone(b.name));
    mesh.skeleton.boneInverses.forEach((m, j) => {
      const i = bones[j] ?? -1;
      if (i >= 0) {
        // The mesh's bind matrix taken in, so a vertex skins from the figure's space.
        new Matrix4()
          .multiplyMatrices(m, mesh.bindMatrix)
          .multiply(new Matrix4().copy(mesh.matrixWorld).invert())
          .toArray(inverse, 16 * i);
      }
    });
    const g = mesh.geometry;
    const n = g.getAttribute('position').count;
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const tex = g.getAttribute('uv');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const out = {
      position: new Float32Array(3 * n),
      normal: new Float32Array(3 * n),
      uv: new Float32Array(2 * n),
      skinIndex: new Float32Array(4 * n),
      skinWeight: new Float32Array(4 * n),
      tag: new Float32Array(2 * n),
    };
    nm.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i)
        .applyMatrix4(mesh.matrixWorld)
        .toArray(out.position, 3 * i);
      v.fromBufferAttribute(nor, i)
        .applyMatrix3(nm)
        .normalize()
        .toArray(out.normal, 3 * i);
      v.set(tex.getX(i), tex.getY(i), 1).applyMatrix3(uv);
      out.uv[2 * i] = v.x;
      out.uv[2 * i + 1] = v.y;
      let s = 0;
      for (let c = 0; c < 4; c++) {
        const b = bones[si.getComponent(i, c)] ?? 0;
        const w = sw.getComponent(i, c);
        out.skinIndex[4 * i + c] = Math.max(0, b);
        out.skinWeight[4 * i + c] = w;
        s += w * (sway[b] ?? 0);
      }
      out.tag[2 * i] = layer;
      out.tag[2 * i + 1] = s;
    }
    const r = new Geometry();
    r.setAttribute('position', new BufferAttribute(out.position, 3));
    r.setAttribute('normal', new BufferAttribute(out.normal, 3));
    r.setAttribute('uv', new BufferAttribute(out.uv, 2));
    r.setAttribute('skinIndex', new BufferAttribute(out.skinIndex, 4));
    r.setAttribute('skinWeight', new BufferAttribute(out.skinWeight, 4));
    r.setAttribute('tag', new BufferAttribute(out.tag, 2));
    const index = g.index;
    r.setIndex(
      index === null
        ? null
        : new Uint32BufferAttribute(
            Uint32Array.from({ length: index.count }, (_, k) => index.getX(k)),
            1,
          ),
    );
    parts.push(r);
  }
  return { geometry: merge(parts), rig, inverse };
}

/**
 * The bones a far figure's vertices are carried by, each with the bone its
 * length runs to (none: a point): the body's, which bear the limbs rigidly.
 */
const CARRIERS: [string, string | null][] = [
  ['pelvis', 'spine_01'],
  ['spine_01', 'spine_02'],
  ['spine_02', 'spine_03'],
  ['spine_03', 'neck_01'],
  ['neck_01', 'head'],
  ['head', null],
  ...(['l', 'r'] as const).flatMap((s): [string, string | null][] => [
    [`clavicle_${s}`, `upperarm_${s}`],
    [`upperarm_${s}`, `lowerarm_${s}`],
    [`lowerarm_${s}`, `hand_${s}`],
    [`hand_${s}`, `middle_01_${s}`],
    [`thigh_${s}`, `calf_${s}`],
    [`calf_${s}`, `foot_${s}`],
    [`foot_${s}`, `ball_${s}`],
    [`ball_${s}`, null],
  ]),
];

/** Every bone's matrix in the figure's space at a clip's first frame (at rest without one). */
function frameOf(rig: Rig, clip: Clip | null): Float32Array {
  const pose = new Pose(rig.names.length).rest(rig);
  clip?.sample(0, pose);
  pose.to(rig);
  rig.fk();
  const out = Float32Array.from(rig.world);
  rig.reset();
  return out;
}

/** The distance from a point to a segment. */
function toSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = new Vector3().subVectors(b, a);
  const l2 = ab.lengthSq();
  const f = l2 > 0 ? Math.max(0, Math.min(1, new Vector3().subVectors(p, a).dot(ab) / l2)) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, f));
}

/**
 * A look's far figure posed in clips, from its seated far figure (in
 * figureNode's frame, seated at seat): each vertex given to its nearest
 * bone in the helm clip's first frame, and carried rigidly to each clip's
 * first frame (the bone there times its inverse at the helm), placed by
 * that clip's place. Each figure in the frame its clip's place is to (on
 * the trapeze, the rack's edge; on the rail, the deck's edge); and, with
 * each, its bones' carry from the helm and its clip's frame. Null if the
 * helm's or any of the clips is not there, or one is not placed.
 */
export function carriedFigures(
  far: BufferGeometry,
  seat: FleetSeat,
  clips: Map<string, Clip>,
  rig: Rig,
  names: readonly string[],
): { geometry: BufferGeometry; clip: Clip; frame: Float32Array }[] | null {
  const helm = clips.get('helm');
  const posed = names.map((n) => clips.get(n));
  if (helm?.place == null || posed.some((c) => c?.place == null)) {
    return null;
  }
  const atHelm = frameOf(rig, helm);
  // From figureNode's frame back to the boat model's (the stage's, as the
  // clips' places are), then into the helm clip's figure.
  const toHelm = new Matrix4()
    .copy(helm.place as Matrix4)
    .invert()
    .multiply(new Matrix4().makeTranslation(seat.out, seat.y, seat.z))
    .multiply(new Matrix4().makeRotationY(Math.PI));
  const pos = far.getAttribute('position');
  const n = pos.count;
  // Each vertex's carrier, nearest at the helm.
  const segments = CARRIERS.map(([from, to]) => {
    const i = rig.bone(from);
    const j = to === null ? -1 : rig.bone(to);
    const a = new Vector3().fromArray(atHelm, 16 * i + 12);
    return { bone: i, a, b: j < 0 ? a.clone() : new Vector3().fromArray(atHelm, 16 * j + 12) };
  }).filter((g) => g.bone >= 0);
  const carrier = new Int32Array(n);
  const p = new Vector3();
  for (let k = 0; k < n; k++) {
    p.fromBufferAttribute(pos, k).applyMatrix4(toHelm);
    let best = Infinity;
    for (const g of segments) {
      const d = toSegment(p, g.a, g.b);
      if (d < best) {
        best = d;
        carrier[k] = g.bone;
      }
    }
  }
  return posed.map((clip) => {
    const c = clip as Clip;
    const frame = frameOf(rig, c);
    // Each bone's carry: placed by the clip, the bone there, its inverse at the helm.
    const carry = rig.names.map((_, b) =>
      new Matrix4()
        .copy(c.place as Matrix4)
        .multiply(new Matrix4().fromArray(frame, 16 * b))
        .multiply(new Matrix4().fromArray(atHelm, 16 * b).invert())
        .multiply(toHelm),
    );
    const g = far.clone();
    const gp = g.getAttribute('position') as BufferAttribute;
    const gn = g.getAttribute('normal') as BufferAttribute;
    const normal = new Matrix3();
    for (let k = 0; k < n; k++) {
      const m = carry[carrier[k] as number] as Matrix4;
      p.fromBufferAttribute(gp, k).applyMatrix4(m);
      gp.setXYZ(k, p.x, p.y, p.z);
      p.fromBufferAttribute(gn, k).applyMatrix3(normal.getNormalMatrix(m)).normalize();
      gn.setXYZ(k, p.x, p.y, p.z);
    }
    return { geometry: g, clip: c, frame };
  });
}

/**
 * A look's far figure out fully on a trapeze's wire, each side, from its
 * seated far figure (carriedFigures), placed from the rack's edge. The two
 * merged, tagged 1 (starboard) and 2 (port); and the hook's eye (hook, in
 * the figure's space at rest, carried by the pelvis) on each. Null if the
 * clips are not all there.
 */
export function wireFigures(
  far: BufferGeometry,
  seat: FleetSeat,
  clips: Map<string, Clip>,
  rig: Rig,
  hook: Vector3 | null,
): { geometry: BufferGeometry; hooks: [Vector3, Vector3] } | null {
  const made = carriedFigures(far, seat, clips, rig, [
    TRAPEZE_CLIPS.out,
    `${TRAPEZE_CLIPS.out}-port`,
  ]);
  if (made === null) {
    return null;
  }
  const atRest = frameOf(rig, null);
  const pelvis = rig.bone('pelvis');
  const hooks = made.map(({ geometry, clip, frame }, side) => {
    const tag = geometry.getAttribute('tag') as BufferAttribute;
    for (let k = 0; k < tag.count; k++) {
      tag.setY(k, side + 1);
    }
    // The hook, carried by the pelvis from rest to the wire.
    return (hook ?? new Vector3().fromArray(atRest, 16 * pelvis + 12))
      .clone()
      .applyMatrix4(new Matrix4().fromArray(atRest, 16 * pelvis).invert())
      .applyMatrix4(new Matrix4().fromArray(frame, 16 * pelvis))
      .applyMatrix4(clip.place as Matrix4);
  });
  return { geometry: merge(made.map((m) => m.geometry)), hooks: hooks as [Vector3, Vector3] };
}

/**
 * A look's far figures on a rail, from its seated far figure
 * (carriedFigures): sat upright and leaning out, on each side, each placed
 * from the deck's edge on its side (rail.ts), by clip name. Null if the
 * clips are not all there.
 */
export function railFigures(
  far: BufferGeometry,
  seat: FleetSeat,
  clips: Map<string, Clip>,
  rig: Rig,
): Map<string, BufferGeometry> | null {
  const names = [RAIL_CLIPS.up, RAIL_CLIPS.out].flatMap((n) => [n, `${n}-port`]);
  const made = carriedFigures(far, seat, clips, rig, names);
  return made === null ? null : new Map(made.map((m, i) => [names[i] as string, m.geometry]));
}
