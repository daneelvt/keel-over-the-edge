// SPDX-License-Identifier: AGPL-3.0-only

// What the page sends the GPU a frame. three.js keeps a uniform in its
// object group unless told otherwise: a buffer of it for every object that
// draws with it, written whenever the object is drawn, in every pass, every
// frame, whether or not it changed. That is right for an object's own
// matrices and wasteful for the rest, so:
//
// - What every object shares and may change from frame to frame (the
//   fog's drift, the dome's centre, the sea's phases) goes in one shared
//   group, "scene", which three.js brings up to date once a render call:
//   one buffer for all the materials that read the same of it, its changed
//   values written, and one for each array.
// - An array every object shares, which changes now and then or never (the
//   fog's sources, the boats' paints), goes in a group of its own in the
//   bind group "kept", written once when it is marked changed (`changed`)
//   and not otherwise.
//
// A material then binds at most four groups (render, scene, kept, object):
// WebGPU's least limit.
// - A skeleton's bones go in a texture, written once a frame however many
//   parts and passes draw with them, not in a uniform buffer for each.
// - An instanced mesh that asks for it (`instancesByAttribute`) takes its
//   matrices as an instanced attribute, sent only when its version moves and
//   only the instances in use, not in a uniform buffer written at every draw.
//
// The last two are three.js's own paths for bones and instances too many for
// a uniform buffer; a builder is told the buffer holds nothing for those
// objects, so it takes them.

import { type BufferGeometry, type Material, Mesh, type Object3D } from 'three';
import { sharedUniformGroup } from 'three/tsl';
import type { InstancedMesh, WebGPURenderer } from 'three/webgpu';

/** Anything with a uniform group: a uniform, a uniform array. */
interface Grouped {
  setGroup(group: unknown): unknown;
  groupNode?: { needsUpdate: boolean };
}

/**
 * The scene's group. Unlike three.js's render group, it holds nothing of an
 * object's or a material's own, so the materials that read the same of it
 * share one bind group and one buffer.
 */
const sceneGroup = sharedUniformGroup('scene', 0, 'render');

/** A uniform or array every object shares, which may change from frame to frame: compared, or sent, once a render call. */
export function eachRender<T extends Grouped>(node: T): T {
  node.setGroup(sceneGroup);
  return node;
}

/**
 * A uniform array every object shares, sent when it is marked changed: in a
 * group of its own (one of the bind group three.js names "kept"). It is sent
 * once at its first draw.
 */
export function kept<T extends Grouped>(node: T): T {
  node.setGroup(sharedUniformGroup('kept'));
  return node;
}

/** Marks a kept array changed: it is sent before the next draw that reads it. */
export function changed(node: Grouped): void {
  if (node.groupNode !== undefined) {
    node.groupNode.needsUpdate = true;
  }
}

const BY_ATTRIBUTE = 'instancesByAttribute';

/**
 * Has an instanced mesh take its matrices as an instanced attribute: sent
 * when instanceMatrix.needsUpdate is set, and then only its update ranges
 * when it has them (setInstancesInUse). The mesh takes one more vertex
 * buffer than with a uniform buffer: a mesh near the GPU's limit of eight
 * must not ask.
 */
export function instancesByAttribute<T extends InstancedMesh>(mesh: T): T {
  mesh.userData[BY_ATTRIBUTE] = true;
  return mesh;
}

/**
 * Marks the first n of a mesh's instances' matrices changed: the next frame
 * sends those, not the whole capacity.
 */
export function sendInstances(mesh: InstancedMesh, n: number): void {
  const m = mesh.instanceMatrix;
  m.clearUpdateRanges();
  if (n > 0) {
    m.addUpdateRange(0, n * 16);
    m.needsUpdate = true;
  }
}

/** Whether a builder for an object is to take three.js's paths that need no uniform buffer. */
export function bufferless(object: Object3D | null): boolean {
  if (object === null) {
    return false;
  }
  return (
    (object as { isSkinnedMesh?: boolean }).isSkinnedMesh === true ||
    object.userData[BY_ATTRIBUTE] === true
  );
}

interface BuilderMaker {
  createNodeBuilder(
    object: Object3D | null,
    renderer: unknown,
  ): { getUniformBufferLimit(): number };
}

/** Has the renderer's builders take those paths for the objects that want them (bufferless). */
export function sendLess(renderer: WebGPURenderer): void {
  sharedByStage(renderer);
  const backend = renderer.backend as unknown as BuilderMaker;
  const make = backend.createNodeBuilder.bind(backend);
  backend.createNodeBuilder = (object, r) => {
    const builder = make(object, r);
    if (bufferless(object)) {
      builder.getUniformBufferLimit = () => 0;
    }
    return builder;
  };
}

/**
 * A mesh drawn its count times (0 at first), each instance placing itself
 * by instanceIndex from attributes or textures of its own: three.js's
 * Mesh.count. An InstancedMesh's matrices, which such a mesh would leave at
 * the identity, are sent in full at every draw.
 *
 * three.js tells an instanced object's shaders apart by the object only
 * while it draws more than one; at one, two such meshes whose materials
 * look alike (the fleet's kinds' parts, named alike) would share one
 * build, and with it the first one's instance attributes. Its material is
 * told apart by the mesh instead, as an InstancedMesh's always is.
 */
export function instances(geometry: BufferGeometry, material: Material | Material[]): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.count = 0;
  for (const m of Array.isArray(material) ? material : [material]) {
    const own = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${own()}|${mesh.uuid}`;
  }
  return mesh;
}

/** What sendFirst sends: an instanced attribute or the buffer several share. */
interface InstanceData {
  readonly itemSize?: number;
  readonly stride?: number;
  needsUpdate: boolean;
  clearUpdateRanges(): void;
  addUpdateRange(start: number, count: number): void;
}

/** Marks the first n instances of an instanced attribute or interleaved buffer changed: the next frame sends those alone. */
export function sendFirst(data: InstanceData, n: number): void {
  data.clearUpdateRanges();
  if (n > 0) {
    data.addUpdateRange(0, n * (data.stride ?? data.itemSize ?? 1));
    data.needsUpdate = true;
  }
}

/** A binding of a bind group, as three.js's Bindings sees it. */
interface StagedBinding {
  visibility: number;
}

/** What three.js's Bindings keeps its shared bind groups in: by render context, a map by cache key. */
interface SharedStore {
  get(context: object): Map<string, unknown> | undefined;
  set(context: object, groups: Map<string, unknown>): void;
}

/** The parts of three.js's Bindings that sharedByStage changes. */
export interface SharedBindings {
  _sharedBindGroups: SharedStore;
  getSharedBindGroup(group: { bindings: StagedBinding[] }, context?: object | null): unknown;
}

/**
 * Has the renderer share a bind group only between builds that read each of
 * its bindings in the same shader stages.
 *
 * three.js shares a group (the scene's and the kept: sharedUniformGroup)
 * between every build whose group holds the same uniforms, by a key of
 * their ids alone. But a uniform array's or a texture's binding is visible
 * only to the stages that read it, and the GPU's layout of a group is
 * made once, from the first build's: a material that reads an array in its
 * vertex shader, given the group of one that read it only in its fragment
 * shader, makes no pipeline at all ("not in the binding visibility"). Each
 * set of stages here has a store of its own, so every build gets a group
 * laid out for its own stages, as three.js 0.186 gave it.
 *
 * A group let go is taken out of every set's store by its key: one of
 * another set with the same key is then made again when next asked for.
 */
export function sharedByStage(renderer: WebGPURenderer): void {
  const bindings = (renderer as unknown as { _bindings?: SharedBindings })._bindings;
  if (bindings === undefined) {
    return;
  }
  const stores = new Map<string, WeakMap<object, Map<string, unknown>>>();
  const storeOf = (stages: string): WeakMap<object, Map<string, unknown>> => {
    let s = stores.get(stages);
    if (s === undefined) {
      s = new WeakMap();
      stores.set(stages, s);
    }
    return s;
  };
  /** The stages of the group being asked for, or null outside getSharedBindGroup (a group let go). */
  let asking: string | null = null;
  bindings._sharedBindGroups = {
    get(context) {
      if (asking !== null) {
        return storeOf(asking).get(context);
      }
      // A group let go: its key out of every store.
      const all = [...stores.values()].map((s) => s.get(context)).filter((m) => m !== undefined);
      const forget = new Map<string, unknown>();
      forget.delete = (key: string) => {
        for (const m of all) {
          m.delete(key);
        }
        return true;
      };
      return forget;
    },
    set(context, groups) {
      storeOf(asking ?? '').set(context, groups);
    },
  };
  const get = bindings.getSharedBindGroup.bind(bindings);
  bindings.getSharedBindGroup = (group, context) => {
    asking = group.bindings.map((b) => b.visibility).join(',');
    try {
      return get(group, context);
    } finally {
      asking = null;
    }
  };
}
