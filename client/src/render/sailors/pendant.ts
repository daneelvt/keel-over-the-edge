// SPDX-License-Identifier: AGPL-3.0-only

// The certificate's pendant: a small piece of metal on a dark cord, worn at
// the neck by whoever holds a certificate, the highest they hold (a copper
// anchor, a bronze ship's wheel, a silver compass rose, a silver spyglass,
// a gold sunburst). The pendants are one model (art/pendants/build.ts), a
// node a certificate's, its origin where the cord runs through its bail;
// each look's version says where that hangs on its figure as bound, and
// which way the pendant's face looks out from the clothes under it (the
// catalog's art.pendant). It rides the skeleton's pendant bone, which
// follows the chest, on the close and deck levels; the far level, a figure
// a few pixels high, wears none.
//
// A figure drawn as its own skinned mesh (the boat in view's sailor, the
// dressing room's) wears it as a mesh under its pendant bone. The figures
// drawn many to a draw (the crew, the fleet's near sailors) wear it in a
// draw of its own beside theirs: every pendant's vertices in one geometry,
// each instance a person's row, its vertices placed as if weighted wholly
// to the pendant bone and folded to a point but for the pendant the row
// wears.
//
// Its colours are in its vertices and its metal's metalness and roughness
// in its second texture coordinate; the metal reflects the sky above and
// the sea below as a sailor's metal does (material.ts), the game having no
// environment map. The model loads the first time a pendant is worn.

import {
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  Mesh,
  type Object3D,
  type Skeleton,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  attribute,
  cameraPosition,
  dot,
  Fn,
  If,
  mix,
  normalize,
  normalLocal,
  normalWorld,
  positionGeometry,
  positionWorld,
  reflect,
  smoothstep,
  vec3,
} from 'three/tsl';
import type { MeshStandardNodeMaterial, Node, WebGPURenderer } from 'three/webgpu';
import type { PendantPlace } from '../../catalog/types.gen';
import { litMaterial } from '../materials';
import { sailorLight } from './material';
import { gltfLoader } from './model';

/** The skeleton's bone the pendant rides. */
export const PENDANT_BONE = 'pendant';

/** How much of the sky's and sea's own colour the metal keeps in what it reflects, as a sailor's does. */
const METAL_HUE = 0.3;

/**
 * The pendants as loaded: each certificate's in its own frame, in the
 * catalog's order; and all of them as one geometry, each vertex's
 * `pendant` attribute whose it is (1 the first certificate's).
 */
export interface Pendants {
  each: BufferGeometry[];
  all: BufferGeometry;
}

/**
 * The pendants from their model's scene: each node named by a
 * certificate's pendantNode, its parts merged in its own frame.
 */
export function pendantsFrom(scene: Object3D, nodes: readonly string[]): Pendants {
  scene.updateMatrixWorld(true);
  const each = nodes.map((name) => {
    const node = scene.getObjectByName(name);
    if (node === undefined) {
      throw new Error(`the pendants have no ${name}`);
    }
    const parts: BufferGeometry[] = [];
    const toNode = new Matrix4().copy(node.matrixWorld).invert();
    node.traverse((o) => {
      if (o instanceof Mesh) {
        const g = plain(o.geometry as BufferGeometry);
        g.applyMatrix4(new Matrix4().multiplyMatrices(toNode, o.matrixWorld));
        parts.push(g);
      }
    });
    const g = parts.length === 1 ? (parts[0] as BufferGeometry) : mergeGeometries(parts);
    if (g === null) {
      throw new Error(`the ${name} pendant's parts do not merge`);
    }
    return g;
  });
  const tagged = each.map((g, i) => {
    const t = g.clone();
    t.setAttribute(
      'pendant',
      new BufferAttribute(new Float32Array(t.getAttribute('position').count).fill(i + 1), 1),
    );
    return t;
  });
  const all = mergeGeometries(tagged);
  if (all === null) {
    throw new Error('the pendants do not merge');
  }
  return { each, all };
}

/** A geometry's position, normal, colour and metal as plain floats, whatever the file packed them as. */
function plain(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'uv1']) {
    const a = g.getAttribute(name);
    if (a === undefined) {
      throw new Error(`a pendant has no ${name}`);
    }
    const size = name === 'uv1' ? 2 : 3;
    const f = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      f[i * size] = a.getX(i);
      f[i * size + 1] = a.getY(i);
      if (size === 3) {
        f[i * size + 2] = a.getZ(i);
      }
    }
    out.setAttribute(name, new BufferAttribute(f, size));
  }
  if (g.index !== null) {
    out.setIndex(Array.from(g.index.array));
  }
  return out;
}

let files: (() => Promise<string>) | null = null;
let loading: Promise<Pendants> | null = null;
let loaded: Pendants | null = null;
const waiting = new Set<(p: Pendants) => void>();
let renderer: WebGPURenderer | null = null;
let nodes: readonly string[] = [];

/**
 * Where the pendants' model is, and the renderer that loads it: told once,
 * by whoever draws sailors, before the first pendant is worn; with the
 * certificates' pendants' nodes in order.
 */
export function pendantFiles(
  url: () => Promise<string>,
  by: WebGPURenderer,
  names: readonly string[],
): void {
  files = url;
  renderer = by;
  nodes = names;
}

/** The pendants, if loaded; null until a pendant is first worn and the model has loaded. */
export function pendantsLoaded(): Pendants | null {
  return loaded;
}

/** Calls then with the pendants when they have loaded, at once if they have; starts loading them if not yet. */
export function whenPendants(then: (p: Pendants) => void): void {
  if (loaded !== null) {
    then(loaded);
    return;
  }
  waiting.add(then);
  if (loading !== null || files === null || renderer === null) {
    return;
  }
  const url = files;
  const by = renderer;
  loading = url()
    .then((u) => gltfLoader(by).loadAsync(u))
    .then((gltf) => pendantsFrom(gltf.scene, nodes));
  loading.then(
    (p) => {
      loaded = p;
      for (const w of waiting) {
        w(p);
      }
      waiting.clear();
    },
    (e: unknown) => {
      // Drawn without its pendants; tried again the next time one is worn.
      loading = null;
      console.error('the pendants did not load', e);
    },
  );
}

/** The pendant's frame on a figure as bound, from its own: its bail at the place's at, its face toward facing, across level. */
export function pendantMatrix(place: PendantPlace, out = new Matrix4()): Matrix4 {
  const [fx, fy, fz] = place.facing as [number, number, number];
  const z = new Vector3(fx, fy, fz).normalize();
  const x = new Vector3(1, 0, 0);
  x.addScaledVector(z, -x.dot(z)).normalize();
  const y = new Vector3().crossVectors(z, x);
  const [ax, ay, az] = place.at as [number, number, number];
  return out.makeBasis(x, y, z).setPosition(ax, ay, az);
}

/**
 * The pendant's material, its vertex placed by vertex if given (its
 * normal set there too): its vertices' colours and metal, its metal
 * reflecting the sky and the sea.
 */
export function pendantMaterial(vertex?: Node<'vec3'>): MeshStandardNodeMaterial {
  const m = litMaterial({ vertexColors: true }, vertex);
  const metal = attribute('uv1', 'vec2') as unknown as Node<'vec2'>;
  m.metalnessNode = metal.x;
  m.roughnessNode = metal.y;
  m.emissiveNode = Fn(() => {
    const n = normalize(normalWorld);
    const v = normalize(cameraPosition.sub(positionWorld));
    const r = reflect(v.negate(), n);
    const seen = mix(sailorLight.sea, sailorLight.sky, smoothstep(-0.15, 0.25, r.y));
    const grey = mix(vec3(dot(seen, vec3(0.2126, 0.7152, 0.0722))), seen, METAL_HUE);
    const albedo = attribute('color', 'vec3') as unknown as Node<'vec3'>;
    return albedo.mul(grey).mul(metal.x);
  })() as unknown as Node<'vec3'>;
  m.name = 'pendant';
  return m;
}

/**
 * The pendant's vertex in a draw of many figures: the vertex's place on
 * the figure as bound (its pendant's frame from the row's look's place,
 * at and facing), skinned by the pendant bone's matrix in the row, then
 * placed as the row's figure is (place, and turn for its normal); folded
 * to a point unless the row wears the vertex's pendant (worn, 0 none).
 */
export function pendantVertex(o: {
  worn: Node<'float'>;
  at: Node<'vec3'>;
  facing: Node<'vec3'>;
  skin: (p: Node<'vec3'>, n: Node<'vec3'>) => { p: Node<'vec3'>; n: Node<'vec3'> };
  place: (p: Node<'vec3'>) => Node<'vec3'>;
  turn: (n: Node<'vec3'>) => Node<'vec3'>;
}): Node<'vec3'> {
  return Fn(() => {
    const out = vec3(0, 0, 0).toVar();
    const whose = attribute('pendant', 'float') as unknown as Node<'float'>;
    If(o.worn.greaterThan(0.5).and(abs(whose.sub(o.worn)).lessThan(0.5)), () => {
      const z = normalize(o.facing);
      const x = normalize(vec3(1, 0, 0).sub(z.mul(z.x)));
      const y = z.cross(x);
      const g = positionGeometry;
      const n0 = attribute('normal', 'vec3') as unknown as Node<'vec3'>;
      const p = o.at.add(x.mul(g.x)).add(y.mul(g.y)).add(z.mul(g.z));
      const n = x.mul(n0.x).add(y.mul(n0.y)).add(z.mul(n0.z));
      const s = o.skin(p as unknown as Node<'vec3'>, n as unknown as Node<'vec3'>);
      normalLocal.assign(normalize(o.turn(s.n)));
      out.assign(o.place(s.p));
    });
    return out;
  })() as unknown as Node<'vec3'>;
}

/** A geometry with no pendant in it yet, with the attributes a pendant's draw reads: drawn as nothing until they load. */
export function noPendants(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1]), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('uv1', new BufferAttribute(new Float32Array(2), 2));
  g.setAttribute('pendant', new BufferAttribute(new Float32Array(1), 1));
  return g;
}

/** The pendants, once loaded: started now if not yet. */
export function pendantsReady(): Promise<Pendants> {
  return new Promise((done) => whenPendants(done));
}

/**
 * A figure of its own (a level of the boat in view's sailor, the
 * dressing room's), by its skeleton, wearing its pendant: a mesh under its
 * pendant bone, placed by its look's place; none for 0.
 */
export class WornPendant {
  readonly #bone: Object3D | null;
  readonly #matrix = new Matrix4();
  #mesh: Mesh | null = null;
  #worn = 0;
  #shadows = false;

  constructor(skeleton: Skeleton | null, place: PendantPlace) {
    const i = skeleton?.bones.findIndex((b) => b.name === PENDANT_BONE) ?? -1;
    this.#bone = i < 0 || skeleton === null ? null : (skeleton.bones[i] ?? null);
    const inverse = i < 0 ? null : (skeleton?.boneInverses[i] ?? null);
    // From the pendant's frame to the bone's, as the figure is bound.
    this.#matrix.multiplyMatrices(inverse ?? new Matrix4(), pendantMatrix(place));
  }

  /** Whether it casts shadows, as its figure does. */
  set shadows(on: boolean) {
    this.#shadows = on;
    if (this.#mesh !== null) {
      this.#mesh.castShadow = on;
    }
  }

  /** The pendant worn: 0 none, else the certificate's place and one. */
  get worn(): number {
    return this.#worn;
  }

  /** Whether the pendant worn is drawn: its model loaded and a bone to hang it on. */
  get drawn(): boolean {
    return this.#mesh?.visible === true;
  }

  /** Wears pendant n (0 none), loading the pendants first if need be. */
  wear(n: number): void {
    this.#worn = n;
    if (n <= 0) {
      if (this.#mesh !== null) {
        this.#mesh.visible = false;
      }
      return;
    }
    whenPendants((p) => this.#put(p));
  }

  #put(p: Pendants): void {
    const g = p.each[this.#worn - 1];
    if (this.#bone === null || g === undefined) {
      if (this.#mesh !== null) {
        this.#mesh.visible = false;
      }
      return;
    }
    if (this.#mesh === null) {
      this.#mesh = new Mesh(g, pendantMaterial());
      this.#mesh.name = 'pendant';
      this.#mesh.matrixAutoUpdate = false;
      this.#mesh.matrix.copy(this.#matrix);
      // A few centimetres on a moving figure: its bone moves it, never its bounds.
      this.#mesh.frustumCulled = false;
      this.#mesh.castShadow = this.#shadows;
      this.#bone.add(this.#mesh);
    }
    this.#mesh.geometry = g;
    this.#mesh.visible = this.#worn > 0;
  }
}
