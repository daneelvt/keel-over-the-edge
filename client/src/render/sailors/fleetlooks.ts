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
import { Clip } from './clips';
import { LayeredTexture } from './layers2d';
import { gltfLoader, placesOf } from './model';
import { boneNames } from './onboat';
import { Rig } from './rig';
import { CHAINS } from './springs';

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
  /** Whether a boat with it has come near: its clips are wanted. */
  near = false;
  deck: DeckLook | null = null;
  /** The far figure, seated, in figureNode's frame; uv in the atlas, tag (layer, 0). */
  far: BufferGeometry | null = null;
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

  /** Starts loading a look's deck and far levels, if not yet; and its clips, if near. */
  want(look: FleetLook, near: boolean): void {
    look.near ||= near;
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
    if (look.near && look.state === 'ready' && look.clipsState === 'none' && look.deck !== null) {
      look.clipsState = 'loading';
      this.#loadClips(look, look.deck.rig).then(
        () => {
          look.clipsState = 'ready';
          this.onLoad(look);
        },
        (e: unknown) => {
          look.clipsState = 'failed';
          console.error(`the fleet's sailor's clips ${look.art.clips} did not load`, e);
        },
      );
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
      while (look.clipsState === 'loading') {
        await new Promise((r) => setTimeout(r, 10));
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

  async #loadClips(look: FleetLook, rig: Rig): Promise<void> {
    const url = await this.files(look.art.clips);
    const gltf = await gltfLoader(this.renderer).loadAsync(url);
    const places = placesOf(gltf.scene);
    const identity = new Matrix4();
    const clips = new Map<string, Clip>();
    for (const a of gltf.animations) {
      const place = places.get(`place-${a.name}`) ?? null;
      clips.set(
        a.name,
        Clip.from(a, rig, place !== null && !place.equals(identity) ? place : null),
      );
    }
    look.clips = clips;
  }

  /**
   * The pools made again from every loaded look. Whoever draws the old ones
   * frees them once it has taken the new ones.
   */
  #pools(): void {
    const near = this.looks.map((l) => l.deck?.geometry).filter((g) => g !== undefined);
    const far = this.looks.map((l) => l.far).filter((g) => g !== null);
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
