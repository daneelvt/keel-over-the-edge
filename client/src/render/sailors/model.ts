// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's model, loaded as the build wrote it: a level of its look (the
// close, the deck or the far), whose meshes keep their skin, skeleton,
// atlas and mask; and its clips, the skeleton alone with its animations.
// Every mesh's material is made again by sailorMaterial, from the file's
// atlas (its base colour) and mask (its occlusion texture, which the build
// uses to carry it: it is never read as occlusion).
//
// The atlas and mask are KTX2 (Basis Universal), transcoded in a worker to
// what the GPU offers; the transcoder loads with the first sailor.
//
// Where a pose seats the figure in the dinghy is in the files too, as named
// empty nodes: `place` in the far level's, for the pose it is made in, and
// `place-<clip>` in the clips', each a transform from the figure's own
// space to the boat model's. The figure is put under the boat's model with
// that transform, and sits where the build judged it.

import {
  type AnimationClip,
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
import type { WebGPURenderer } from 'three/webgpu';
import type { SailorColours } from './material';
import { sailorMaterial } from './material';

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
  }
  if (ktx2Renderer !== renderer) {
    ktx2.detectSupport(renderer);
    ktx2Renderer = renderer;
  }
  return ktx2;
}

function gltfLoader(renderer: WebGPURenderer): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.setKTX2Loader(ktx2For(renderer));
  return loader;
}

/** The named place nodes under a file's scene, as transforms to their parent's space. */
function placesOf(root: Object3D): Map<string, Matrix4> {
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
 * are transcoded.
 */
export async function loadSailor(
  url: string,
  renderer: WebGPURenderer,
  colours: SailorColours,
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
  const material = sailorMaterial(atlas, mask);
  for (const o of meshes) {
    (o.material as MeshStandardMaterial).dispose();
    o.material = material;
    o.userData.main = colours.main;
    o.userData.skin = colours.skin;
    o.userData.hair = colours.hair;
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
