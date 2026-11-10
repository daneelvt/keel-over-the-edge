// SPDX-License-Identifier: AGPL-3.0-only

// The crew drawn skinned on the GPU, a level in one draw whatever the looks
// in it: each look's figure kept once in its bind pose with its bones and
// weights, in a float texture (the level's pool, four texels a vertex), and
// each person's bones posed on the CPU (crewbody.ts) and written into their
// row of another (the level's rows, as the fleet's near sailors' are:
// fleetsailors.ts). A level is one instanced mesh of as many vertices as its
// largest figure: each instance reads its row, each vertex its figure's
// vertex from the pool, skins it by its bones from the row and puts it in
// the row's frame; the vertices past its figure's end are folded to a
// point. The looks' atlases and masks are the fleet's layers (fleetlooks.ts),
// so every look draws in one material.
//
// A row, texel by texel (each four floats):
//   0 the figure: its first vertex in the pool, its vertices, its look's
//     layer, 1 for a machine
//   1 main colour (linear)
//   2 skin colour
//   3 hair colour
//   4–6 the frame: the rows of the matrix from the person's boat's model
//     to the level's parent (the identity for the boat the level is under)
//   7 unused
//   8 on: three texels a bone, the rows of its matrix from the figure's
//     bind pose to the boat's model.
//
// The pool's vertex, texel by texel: place and u; normal and v; the four
// bones; their weights.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  DataTexture,
  FloatType,
  InstancedMesh,
  NearestFilter,
  RGBAFormat,
  type Texture,
} from 'three';
import {
  dot,
  Fn,
  float,
  instanceIndex,
  int,
  ivec2,
  modelWorldMatrix,
  normalize,
  normalLocal,
  select,
  texture,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { FleetLooks } from './fleetlooks';
import { ROW_HEAD, SailorRows, skinRow } from './fleetsailors';
import { sailorMaterial } from './material';

/** The pool's width, texels. */
const POOL_WIDTH = 2048;
/** Floats a vertex in a figure: place and u, normal and v, bones, weights. */
export const STRIDE = 16;
/** A machine's lamps, steady: the fleet's pulse at its middle. */
const LAMPS = 0.86;
/** The most people a level draws: the instances its mesh is made with. */
export const LEVEL_MOST = 256;

/** Where a figure lies in a pool, in vertices. */
export interface Placed {
  offset: number;
  count: number;
}

/** A float texture of figures, four texels a vertex, grown as figures are added. */
export class Pool {
  texture: DataTexture;
  #data: Float32Array;
  #used = 0;
  readonly placed = new Map<string, Placed>();
  /** Told the new texture when it grows. */
  readonly users: { value: Texture }[] = [];

  constructor(
    readonly name: string,
    /** The most vertices it keeps before it is emptied for those wanted. */
    readonly most: number,
  ) {
    this.#data = new Float32Array(0);
    this.texture = this.#make(16);
  }

  #make(rows: number): DataTexture {
    const data = new Float32Array(4 * POOL_WIDTH * rows);
    data.set(this.#data.subarray(0, Math.min(this.#data.length, data.length)));
    this.#data = data;
    const t = new DataTexture(data, POOL_WIDTH, rows, RGBAFormat, FloatType);
    t.name = this.name;
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Puts the figures of the keys not yet in the pool into it; if they do not
   * fit, empties it first, keeping only those keys'.
   */
  add(keys: readonly string[], figure: (key: string) => Float32Array): void {
    const missing = keys.filter((k) => !this.placed.has(k));
    if (missing.length === 0) {
      return;
    }
    let more = 0;
    for (const k of missing) {
      more += figure(k).length / STRIDE;
    }
    if (this.#used + more > this.most) {
      this.placed.clear();
      this.#used = 0;
      for (const k of new Set(keys)) {
        this.#put(k, figure(k));
      }
    } else {
      for (const k of new Set(missing)) {
        this.#put(k, figure(k));
      }
    }
    this.texture.needsUpdate = true;
  }

  #put(key: string, f: Float32Array): void {
    const count = f.length / STRIDE;
    const texels = STRIDE / 4;
    const need = Math.ceil((texels * (this.#used + count)) / POOL_WIDTH);
    if (need > this.texture.image.height) {
      let rows = this.texture.image.height;
      while (rows < need) {
        rows *= 2;
      }
      const old = this.texture;
      this.texture = this.#make(rows);
      for (const u of this.users) {
        u.value = this.texture;
      }
      old.dispose();
    }
    this.#data.set(f, 4 * texels * this.#used);
    this.placed.set(key, { offset: this.#used, count });
    this.#used += count;
  }
}

/** One level of the crew: its pool, its people's rows and its mesh. */
export class CrewLevel {
  readonly pool: Pool;
  /** The people's rows, grown as more are drawn. */
  rows: SailorRows;
  readonly #rowsUsers: { value: Texture }[] = [];
  readonly mesh: InstancedMesh;
  /** How many are drawn. */
  count = 0;

  constructor(
    readonly name: string,
    /** Bones a figure has. */
    readonly bones: number,
    /** The most vertices of a figure, and how many figures the pool keeps. */
    vertices: number,
    figures: number,
    looks: FleetLooks,
  ) {
    this.pool = new Pool(`crew ${name} figures`, vertices * figures);
    this.rows = new SailorRows(ROW_HEAD + 3 * bones, 8, `crew ${name} rows`);
    const nodes = crewNodes(this.pool, this.rows.texture, this.#rowsUsers);
    const material = sailorMaterial(looks.atlas.texture as Texture, looks.mask.texture as Texture, {
      vertex: nodes.vertex,
      uv: nodes.uv,
      normal: nodes.normal,
      glow: float(LAMPS) as unknown as Node<'float'>,
      instance: { ...nodes, users: { atlas: looks.atlas.users, mask: looks.mask.users } },
    });
    material.name = `crew ${name}`;
    // Only as many vertices as the largest figure; each instance draws its own.
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(3 * vertices), 3));
    // Read by nothing but the material's default normal, which the vertex node replaces.
    g.setAttribute('normal', new BufferAttribute(new Float32Array(3 * vertices), 3));
    this.mesh = new InstancedMesh(g, material, LEVEL_MOST);
    this.mesh.name = `crew ${name}`;
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Placed by its vertex node: the instance matrices stay the identity.
    this.mesh.frustumCulled = false;
  }

  /** Room for n rows: the rows' texture made taller, its rows kept, if they do not fit. */
  room(n: number): void {
    if (n <= this.rows.rows) {
      return;
    }
    let rows = this.rows.rows;
    while (rows < n) {
      rows *= 2;
    }
    const old = this.rows;
    this.rows = new SailorRows(old.width, rows, old.texture.name);
    this.rows.data.set(old.data);
    for (const u of this.#rowsUsers) {
      u.value = this.rows.texture;
    }
    old.texture.dispose();
  }

  /** Row r's head: the figure, its look's layer, whether a machine, and the colours. */
  head(
    r: number,
    figure: Placed,
    colours: { main: Color; skin: Color; hair: Color },
    layer: number,
    machine: boolean,
  ): void {
    const d = this.rows.data;
    const o = 4 * this.rows.width * r;
    d[o] = figure.offset;
    d[o + 1] = figure.count;
    d[o + 2] = layer;
    d[o + 3] = machine ? 1 : 0;
    const { main, skin, hair } = colours;
    d[o + 4] = main.r;
    d[o + 5] = main.g;
    d[o + 6] = main.b;
    d[o + 8] = skin.r;
    d[o + 9] = skin.g;
    d[o + 10] = skin.b;
    d[o + 12] = hair.r;
    d[o + 13] = hair.g;
    d[o + 14] = hair.b;
  }

  /** Row r's frame: the rows of a column-major matrix (sixteen floats) from its boat's model to the level's parent; the identity if none. */
  frame(r: number, m: ArrayLike<number> | null): void {
    const d = this.rows.data;
    const o = 4 * (this.rows.width * r + 4);
    for (let row = 0; row < 3; row++) {
      for (let c = 0; c < 4; c++) {
        d[o + 4 * row + c] = m === null ? (row === c ? 1 : 0) : (m[4 * c + row] as number);
      }
    }
  }

  /** Row r's bones: twelve floats a bone, the first three rows of each matrix. */
  bonesAt(r: number, bones: Float32Array): void {
    this.rows.data.set(bones, 4 * (this.rows.width * r + ROW_HEAD));
  }

  /** count people written, of the figures of keys: each runs as many vertices as the largest. */
  commit(count: number, keys: readonly string[]): void {
    let most = 0;
    for (const k of keys) {
      most = Math.max(most, this.pool.placed.get(k)?.count ?? 0);
    }
    this.mesh.geometry.setDrawRange(0, most);
    this.count = count;
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.rows.texture.needsUpdate = true;
  }

  /** The rows' texture goes to the GPU with the next draw: bones written since. */
  touch(): void {
    this.rows.texture.needsUpdate = true;
  }
}

/** A level's vertex and per-instance values, as nodes. */
function crewNodes(
  pool: Pool,
  rowsTexture: Texture,
  rowsUsers: { value: Texture }[],
): {
  vertex: Node<'vec3'>;
  uv: Node<'vec2'>;
  normal: Node<'vec3'>;
  main: Node<'vec3'>;
  skin: Node<'vec3'>;
  hair: Node<'vec3'>;
  machine: Node<'float'>;
  layer: Node<'float'>;
} {
  const figures = texture(pool.texture);
  pool.users.push(figures);
  const t = texture(rowsTexture);
  rowsUsers.push(t);
  const row = int(instanceIndex);
  const at = (x: number): Node<'vec4'> => t.load(ivec2(x, row)) as unknown as Node<'vec4'>;
  const figure = at(0);
  const main = at(1);
  const skin = at(2);
  const hair = at(3);
  const f0 = at(4);
  const f1 = at(5);
  const f2 = at(6);
  const vi = int(vertexIndex);
  const texel = (k: number): Node<'vec4'> => {
    const i = int(figure.x).add(vi).mul(4).add(k);
    const y = i.div(POOL_WIDTH);
    return figures.load(ivec2(i.sub(y.mul(POOL_WIDTH)), y)) as unknown as Node<'vec4'>;
  };
  const a = texel(0);
  const b = texel(1);
  const bones = texel(2);
  const weights = texel(3);
  const skinned = skinRow(t, row, bones, weights, a.xyz, b.xyz);
  const n = normalize(
    vec3(dot(f0.xyz, skinned.n), dot(f1.xyz, skinned.n), dot(f2.xyz, skinned.n)),
  ) as unknown as Node<'vec3'>;
  const vertex = Fn(() => {
    const p4 = vec4(skinned.p, 1);
    const p = vec3(dot(f0, p4), dot(f1, p4), dot(f2, p4));
    normalLocal.assign(n);
    // Past its figure's end, folded to a point.
    return select(vi.lessThan(int(figure.y)), p, vec3(0, 0, 0));
  })() as unknown as Node<'vec3'>;
  return {
    vertex,
    uv: varying(vec2(a.w, b.w)) as unknown as Node<'vec2'>,
    normal: varying(modelWorldMatrix.mul(vec4(n, 0)).xyz) as unknown as Node<'vec3'>,
    main: varying(main.xyz) as unknown as Node<'vec3'>,
    skin: varying(skin.xyz) as unknown as Node<'vec3'>,
    hair: varying(hair.xyz) as unknown as Node<'vec3'>,
    machine: varying(figure.w) as unknown as Node<'float'>,
    layer: varying(figure.z) as unknown as Node<'float'>,
  };
}
