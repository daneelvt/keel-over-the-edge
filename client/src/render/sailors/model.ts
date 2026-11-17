// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's model, loaded as the build wrote it: a level of its look (the
// close, the deck or the far), whose meshes keep their skin, skeleton,
// atlas and mask; and its clips, the skeleton alone with its animations.
// Every mesh's material is made again by sailorMaterial, from the file's
// atlas (its base colour) and mask (its occlusion texture, which the build
// uses to carry it: it is never read as occlusion).
//
// The atlas and mask are KTX2 (Basis Universal), transcoded in a worker to
// what the GPU offers (started from a file of the page's own:
// transcoder.ts); the transcoder loads with the first sailor.
//
// Where a pose seats the figure in the dinghy is in the files too, as named
// empty nodes: `place` in the far level's, for the pose it is made in, and
// `place-<clip>` in the clips', each a transform from the figure's own
// space to the boat model's. The figure is put under the boat's model with
// that transform, and sits where the build judged it.

import {
  type AnimationClip,
  type BufferAttribute,
  type BufferGeometry,
  LoadingManager,
  type Matrix4,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Skeleton,
  SkinnedMesh,
  type Texture,
} from 'three';
import transcoderJs from 'three/addons/libs/basis/basis_transcoder.js?url';
import transcoderWasm from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { positionGeometry, userData, varying, vec3 } from 'three/tsl';
import type { Node, WebGPURenderer } from 'three/webgpu';
import { catalog } from '../../catalog';
import type { Cockade } from '../../catalog/types.gen';
import { type CockadePlace, cockadeColours, cockadeCoords, cockadePlace } from './cockade';
import type { SailorColours } from './material';
import { sailorMaterial } from './material';
import { type Transcoding, transcodeFromFile } from './transcoder';

/** The winner's cockade's colours, linear. */
const COCKADE_COLOURS = cockadeColours(catalog.world.committee.prizes.cockade);

/** Where a look's version wears the winner's cockade, at the catalog's width. */
export function cockadeOf(art: { cockade: Cockade }): CockadePlace {
  return cockadePlace(art.cockade, catalog.world.committee.prizes.cockade.across);
}

/** Puts the winner's cockade on a level's meshes, or takes it off. */
export function wearCockade(model: SailorModel, on: boolean): void {
  for (const m of model.meshes) {
    m.userData.cockade = on ? 1 : 0;
  }
}

/** A level of a sailor's look, as loaded. */
export interface SailorModel {
  /** The file's scene: the meshes and, but for the far level, the skeleton. */
  root: Object3D;
  /** Its meshes: skinned, but for the far level's one rigid figure. */
  meshes: Mesh[];
  /** The skeleton they share; null for the far level. */
  skeleton: Skeleton | null;
  /** Where a pose seats the figure in the boat model, by name ('place'). */
  places: Map<string, Matrix4>;
  /** The atlas and mask, shared by its meshes' material. */
  atlas: Texture;
  mask: Texture;
}

/** A look's clips: its animations, and where each is placed by name (`place-<clip>`). */
export interface SailorClips {
  clips: AnimationClip[];
  places: Map<string, Matrix4>;
}

/** The transcoder's files, at the names KTX2Loader asks for under its path. */
const TRANSCODER_PATH = 'basis/';
const TRANSCODER: Record<string, string> = {
  [`${TRANSCODER_PATH}basis_transcoder.js`]: transcoderJs,
  [`${TRANSCODER_PATH}basis_transcoder.wasm`]: transcoderWasm,
};

let ktx2: KTX2Loader | null = null;
let ktx2Renderer: WebGPURenderer | null = null;

/** The KTX2 loader, told what the renderer's GPU can take. */
function ktx2For(renderer: WebGPURenderer): KTX2Loader {
  if (ktx2 === null) {
    const manager = new LoadingManager();
    // Vite gives the transcoder's files names of its own.
    manager.setURLModifier((url) => TRANSCODER[url] ?? url);
    ktx2 = new KTX2Loader(manager).setTranscoderPath(TRANSCODER_PATH);
    // Its workers from a file of the page's own, not a blob (transcoder.ts).
    transcodeFromFile(ktx2 as unknown as Transcoding);
  }
  if (ktx2Renderer !== renderer) {
    ktx2.detectSupport(renderer);
    ktx2Renderer = renderer;
  }
  return ktx2;
}

/** A loader for sailors' files: meshopt, and KTX2 transcoded to what the renderer's GPU takes. */
export function gltfLoader(renderer: WebGPURenderer): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(ktx2For(renderer));
  return loader;
}

/** The named place nodes under a file's scene, as transforms to their parent's space. */
export function placesOf(root: Object3D): Map<string, Matrix4> {
  const out = new Map<string, Matrix4>();
  root.traverse((o) => {
    if (o.name.startsWith('place') && !(o instanceof Mesh)) {
      o.updateMatrix();
      out.set(o.name, o.matrix.clone());
    }
  });
  for (const name of out.keys()) {
    root.getObjectByName(name)?.removeFromParent();
  }
  return out;
}

/**
 * Loads a level of a sailor's look from url, its meshes' material made by
 * sailorMaterial and their colours the given ones (shared, so a change to
 * them shows on every mesh). The renderer's GPU decides how the textures
 * are transcoded. A machine's lamps glow as each mesh's userData glow says
 * (1 at first). Given its cockade's place, the winner's cockade is drawn
 * there while each mesh's userData cockade is 1 (0 at first).
 */
export async function loadSailor(
  url: string,
  renderer: WebGPURenderer,
  colours: SailorColours,
  machine = false,
  cockade: CockadePlace | null = null,
): Promise<SailorModel> {
  const gltf = await gltfLoader(renderer).loadAsync(url);
  const root = gltf.scene;
  const places = placesOf(root);
  const meshes: Mesh[] = [];
  let atlas: Texture | null = null;
  let mask: Texture | null = null;
  let skeleton: Skeleton | null = null;
  root.traverse((o) => {
    if (o instanceof Mesh) {
      meshes.push(o);
      const src = o.material as MeshStandardMaterial;
      atlas ??= src.map;
      mask ??= src.aoMap;
      if (o instanceof SkinnedMesh) {
        skeleton ??= o.skeleton;
      }
    }
  });
  if (atlas === null || mask === null) {
    throw new Error(`${url}: no atlas and mask`);
  }
  const material = sailorMaterial(
    atlas,
    mask,
    cockade === null
      ? { machine }
      : {
          machine,
          cockade: {
            coords: varying(
              cockadeCoords(
                positionGeometry,
                vec3(cockade.at.x, cockade.at.y, cockade.at.z),
                vec3(cockade.facing.x, cockade.facing.y, cockade.facing.z),
                cockade.radius,
              ),
            ) as unknown as Node<'vec3'>,
            wears: userData('cockade', 'float') as unknown as Node<'float'>,
            colours: COCKADE_COLOURS,
          },
        },
  );
  for (const o of meshes) {
    (o.material as MeshStandardMaterial).dispose();
    o.material = material;
    o.userData.main = colours.main;
    o.userData.skin = colours.skin;
    o.userData.hair = colours.hair;
    o.userData.cockade = 0;
    if (machine) {
      o.userData.glow = 1;
    }
    // Bones and the bend move the figure beyond its rest pose's bounds.
    o.frustumCulled = false;
  }
  return { root, meshes, skeleton, places, atlas, mask };
}

/** Loads a look's clips from url. */
export async function loadClips(url: string, renderer: WebGPURenderer): Promise<SailorClips> {
  const gltf = await gltfLoader(renderer).loadAsync(url);
  return { clips: gltf.animations, places: placesOf(gltf.scene) };
}

/** Whether two meshes' geometries can be put one after the other: the same attributes, of the same kinds. */
function sameLayout(a: BufferGeometry, b: BufferGeometry): boolean {
  const names = Object.keys(a.attributes);
  if (
    names.length !== Object.keys(b.attributes).length ||
    (a.index === null) !== (b.index === null) ||
    a.groups.length > 0 ||
    b.groups.length > 0 ||
    Object.keys(a.morphAttributes).length > 0 ||
    Object.keys(b.morphAttributes).length > 0
  ) {
    return false;
  }
  return names.every((n) => {
    const x = a.attributes[n] as BufferAttribute;
    const y = b.attributes[n] as BufferAttribute | undefined;
    return (
      y !== undefined &&
      x.itemSize === y.itemSize &&
      x.normalized === y.normalized &&
      x.array.constructor === y.array.constructor
    );
  });
}

/** Whether two skeletons are the same bones, bound alike (the loader makes one a mesh). */
function sameSkeleton(a: Skeleton, b: Skeleton): boolean {
  return (
    a === b ||
    (a.bones.length === b.bones.length &&
      a.bones.every((bone, i) => bone === b.bones[i]) &&
      a.boneInverses.every((m, i) => m.equals(b.boneInverses[i] as Matrix4)))
  );
}

/**
 * A level's skinned meshes as one, where they can be: the same material,
 * skeleton, binding, parent and place, their geometries put one after the
 * other in the file's order. One draw a pass for the figure, not one a
 * part; what each draws is the same. A level that cannot be is left as it
 * is.
 */
export function oneMesh(model: SailorModel): SailorModel {
  const parts = model.meshes;
  const first = parts[0];
  if (
    parts.length < 2 ||
    model.skeleton === null ||
    !(first instanceof SkinnedMesh) ||
    first.parent === null
  ) {
    return model;
  }
  for (const m of parts) {
    if (
      !(m instanceof SkinnedMesh) ||
      !sameSkeleton(m.skeleton, first.skeleton) ||
      m.material !== first.material ||
      m.parent !== first.parent ||
      !m.bindMatrix.equals(first.bindMatrix) ||
      !m.matrix.equals(first.matrix) ||
      !m.position.equals(first.position) ||
      !m.quaternion.equals(first.quaternion) ||
      !m.scale.equals(first.scale) ||
      !sameLayout(m.geometry, first.geometry)
    ) {
      return model;
    }
  }
  const geometry = mergeGeometries(parts.map((m) => m.geometry));
  if (geometry === null) {
    return model;
  }
  const one = new SkinnedMesh(geometry, first.material);
  one.name = 'figure';
  one.position.copy(first.position);
  one.quaternion.copy(first.quaternion);
  one.scale.copy(first.scale);
  one.userData = first.userData;
  one.frustumCulled = first.frustumCulled;
  one.castShadow = first.castShadow;
  one.receiveShadow = first.receiveShadow;
  one.bind(first.skeleton, first.bindMatrix);
  const parent = first.parent;
  parent.add(one);
  for (const m of parts) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  return { ...model, meshes: [one] };
}
