// SPDX-License-Identifier: AGPL-3.0-only

// The towns on the page: each building and prop of the chunks held, an
// instance of its kind's model from its biome's kit (art/town). Near the
// camera a house is its kind's model, one instanced draw for each kind in
// view; further off every building is a box under a roof of its own size
// and colours, all of them one draw; props are drawn near only, all of a
// kit's one draw. Every house is coloured from its kit's palette, by its
// own numbers: its walls, its roof, its shutters and doors. A model is
// built at its kind's most storeys: for a house of fewer, its vertex
// shader lowers the roof and the eaves a storey for each storey fewer, and
// draws the windows of the storeys it has not as nothing. At night a share
// of each house's windows is lit, each window by its own number and the
// house's, so the town keeps its lit windows from frame to frame and from
// phone to phone.
//
// Every material is the factory's, so every vertex takes the dome's bend.
// The instances are placed in world metres, east and −north, under a group
// the floating origin moves, so they are placed again only when what is
// drawn changes.

import {
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs,
  attribute,
  Fn,
  float,
  floor,
  fract,
  If,
  positionLocal,
  select,
  sin,
  uniform,
  varying,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { BuildingKind, World } from '../catalog/types.gen';
import type { ChunkBuilding, ChunkTown } from '../workers/mesh/chunk';
import { artUrl } from './boat';
import { headingToRotationY } from './coords';
import { litMaterial } from './materials';

/** A storey's height, m, as the kits build them and the generator reckons. */
export const STOREY = 3;

/** A part of a building, as its model's vertices name it (art/town/lib/kit.ts). */
const PART = {
  wall: 0,
  timber: 1,
  roof: 2,
  shutter: 3,
  glass: 4,
  stone: 5,
  wood: 6,
  cloth: 7,
  iron: 8,
} as const;
/** A vertex's role: 1 + k a storey's own, ABOVE what stands above the walls. */
const ABOVE = 4;
/** The window numbers a lantern's glass and a belfry's openings carry: always lit at night, and never. */
const LANTERN = 62;
const BELFRY = 63;

/** The warm light of a lit window, linear. */
const LAMPLIGHT: [number, number, number] = [1, 0.62, 0.28];

/** Whether a kind is built as a house: of storeys the page varies. */
export function housed(k: BuildingKind): boolean {
  return !k.prop && ['street', 'quay', 'quayEnd', 'square', 'fields'].includes(k.stands);
}

/** A colour #rrggbb as linear values. */
function linear(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/** The page's own numbers a building's seed gives: whether window n is lit, as the shader reckons it. */
export function windowLit(seed: number, window: number, share: number): boolean {
  const x = Math.sin(seed * 12.9898 + window * 78.233) * 43758.5453;
  return x - Math.floor(x) < share;
}

/** What a frame needs to draw the towns. */
export interface TownsFrame {
  /** The floating origin, m east and north. */
  origin: { x: number; y: number };
  /** The camera, m east and north. */
  cameraEast: number;
  cameraNorth: number;
  /** How lit the towns' lamps are, 0 by day to 1 at night. */
  night: number;
}

/** What the developer panel and the tests read of the towns. */
export interface TownsStats {
  buildings: number;
  near: number;
  far: number;
  props: number;
  draws: number;
  triangles: number;
}

/** A kit's models: each kind's geometry, by its index, and how big it was built. */
interface Kit {
  geometry: Map<number, BufferGeometry>;
  built: Map<number, { frontage: number; depth: number }>;
  props: BufferGeometry | null;
  propIndex: Map<number, number>;
}

/** The instance data a model's draw is given: four vec4s an instance. */
const STRIDE = 16;

/** An instanced draw and its data: one interleaved buffer of four vec4s an instance, so a model's draw uses few vertex buffers. */
class Draw {
  mesh: InstancedMesh;
  buffer: InstancedInterleavedBuffer;
  constructor(geometry: BufferGeometry, material: ReturnType<typeof litMaterial>, capacity: number, name: string) {
    const g = geometry.clone();
    this.buffer = new InstancedInterleavedBuffer(new Float32Array(capacity * STRIDE), STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    ['townWall', 'townRoof', 'townShutter', 'townShape'].forEach((name, k) => {
      g.setAttribute(name, new InterleavedBufferAttribute(this.buffer, 4, k * 4));
    });
    this.mesh = new InstancedMesh(g, material, capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Writes instance i's four vec4s. */
  set(i: number, k: number, x: number, y: number, z: number, w: number): void {
    const a = this.buffer.array as Float32Array;
    const o = i * STRIDE + k * 4;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = w;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}

const M = new Matrix4();
const Q = new Quaternion();
const P = new Vector3();
const S = new Vector3();
const UP = new Vector3(0, 1, 0);

export class Towns {
  readonly root = new Group();
  readonly stats: TownsStats = { buildings: 0, near: 0, far: 0, props: 0, draws: 0, triangles: 0 };
  /** The lamps: 0 by day, 1 at night. */
  readonly night = uniform(0);
  /** The share of a house's windows lit at night. */
  readonly share = uniform(0.6);
  /** Called with each kit as it is loaded (the tests). */
  onKit: ((kit: number) => void) | null = null;

  readonly #world: World;
  readonly #kinds: BuildingKind[];
  readonly #chunks = new Map<number, ChunkTown>();
  readonly #kits = new Map<number, Kit | 'loading' | 'failed'>();
  readonly #draws = new Map<string, Draw>();
  readonly #material: ReturnType<typeof litMaterial>;
  readonly #farMaterial: ReturnType<typeof litMaterial>;
  readonly #propMaterial: ReturnType<typeof litMaterial>;
  #far: Draw;
  #version = 0;
  #placed = -1;
  #at = { east: Number.NaN, north: Number.NaN };
  readonly #walls: [number, number, number][][];
  readonly #roofs: [number, number, number][][];
  readonly #shutters: [number, number, number][][];

  constructor(world: World) {
    this.#world = world;
    this.#kinds = world.towns.buildings;
    this.share.value = world.towns.lit.windows;
    this.root.name = 'towns';
    this.#walls = world.towns.kits.map((k) => k.walls.map(linear));
    this.#roofs = world.towns.kits.map((k) => k.roofs.map(linear));
    this.#shutters = world.towns.kits.map((k) => k.shutters.map(linear));
    this.#material = this.#makeMaterial(false);
    this.#farMaterial = this.#makeMaterial(true);
    this.#propMaterial = this.#makeMaterial(false, true);
    this.#far = new Draw(farGeometry(), this.#farMaterial, 256, 'town far');
    this.root.add(this.#far.mesh);
  }

  /** The material every model's draw shares: its parts coloured house by house, its storeys, its lit windows. */
  #makeMaterial(far: boolean, props = false): ReturnType<typeof litMaterial> {
    const wall = attribute('townWall', 'vec4') as unknown as Node<'vec4'>;
    const roof = attribute('townRoof', 'vec4') as unknown as Node<'vec4'>;
    const shutter = attribute('townShutter', 'vec4') as unknown as Node<'vec4'>;
    const shape = attribute('townShape', 'vec4') as unknown as Node<'vec4'>;
    // uv1: (part, role); uv: (window / 64, ·).
    const tag = attribute('uv1', 'vec2') as unknown as Node<'vec2'>;
    const uv = attribute('uv', 'vec2') as unknown as Node<'vec2'>;
    const part = tag.x;
    const role = tag.y;
    // shape: (storeys missing × a storey, storeys it has, its seed, its level).
    const vertex = Fn(() => {
      const p = positionLocal.toVar();
      if (props) {
        // Among the props' models merged, only this instance's own.
        const prop = uv.y;
        If(abs(prop.sub(shape.w)).greaterThan(0.5), () => {
          p.assign(vec3(0, -500, 0));
        });
      } else if (!far) {
        If(role.greaterThan(ABOVE - 0.5), () => {
          p.y.subAssign(shape.x);
        });
        // A storey it has not: its windows and bands drawn as nothing.
        const storey = role.sub(1);
        If(
          role
            .greaterThan(0.5)
            .and(role.lessThan(ABOVE - 0.5))
            .and(storey.greaterThan(shape.y.sub(0.5))),
          () => {
            p.y.assign(shape.w.add(shape.y.mul(STOREY)).sub(0.02));
          },
        );
      }
      return p;
    })() as unknown as Node<'vec3'>;
    const m = litMaterial({ roughness: 0.9, metalness: 0 }, vertex);
    m.name = far ? 'towns far' : props ? 'town props' : 'towns';
    const base = (far ? vec3(1, 1, 1) : vertexColor()) as unknown as Node<'vec3'>;
    const vPart = varying(part);
    const isPart = (k: number): Node<'bool'> =>
      abs(vPart.sub(k)).lessThan(0.5) as unknown as Node<'bool'>;
    const vWall = varying(wall.xyz);
    const vRoof = varying(roof.xyz);
    const vShutter = varying(shutter.xyz);
    const vBase = varying(base);
    m.colorNode = select(
      isPart(PART.wall),
      vWall.mul(vBase),
      select(
        isPart(PART.roof),
        vRoof.mul(vBase),
        select(isPart(PART.shutter).or(isPart(PART.cloth)), vShutter.mul(vBase), vBase),
      ),
    ) as unknown as Node<'vec3'>;
    if (!far) {
      // A window lit: a share of them, each by its number and the house's seed.
      const win = floor(uv.x.mul(64).add(0.5));
      const r = fract(sin(shape.z.mul(12.9898).add(win.mul(78.233))).mul(43758.5453));
      const lit = select(
        win.greaterThan(LANTERN - 0.5).and(win.lessThan(LANTERN + 0.5)),
        float(1),
        select(
          win.greaterThan(BELFRY - 0.5),
          float(0),
          select(r.lessThan(this.share), float(1), float(0)),
        ),
      );
      const vLit = varying(select(abs(part.sub(PART.glass)).lessThan(0.5), lit, float(0)));
      m.emissiveNode = vec3(...LAMPLIGHT).mul(
        vLit.mul(this.night).mul(1.6),
      ) as unknown as Node<'vec3'>;
    }
    return m;
  }

  /** A chunk's towns, handed with its land. */
  add(n: number, town: ChunkTown | null): void {
    if (town === null || town.buildings.length === 0) {
      return;
    }
    this.#chunks.set(n, town);
    this.#version++;
    for (const b of town.buildings) {
      this.#load(b.kit);
    }
  }

  /** A chunk's land let go: its towns go with it. */
  drop(n: number): void {
    if (this.#chunks.delete(n)) {
      this.#version++;
    }
  }

  /** Lets every town go: a new world. */
  clear(): void {
    this.#chunks.clear();
    this.#version++;
  }

  /** Every building and prop held (flags, smoke, lanterns, sounds and the tests read them). */
  *buildings(): IterableIterator<ChunkBuilding> {
    for (const t of this.#chunks.values()) {
      yield* t.buildings;
    }
  }

  /** The discs of harbour water held. */
  *harbour(): IterableIterator<{ east: number; north: number; radius: number }> {
    for (const t of this.#chunks.values()) {
      yield* t.harbour;
    }
  }

  /** The catalog's kinds of building. */
  get kinds(): readonly BuildingKind[] {
    return this.#kinds;
  }

  /** Loads a kit's models, once, when a town of its biome is first held. */
  #load(kit: number): void {
    if (this.#kits.has(kit)) {
      return;
    }
    const k = this.#world.towns.kits[kit];
    if (k === undefined) {
      this.#kits.set(kit, 'failed');
      return;
    }
    this.#kits.set(kit, 'loading');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader
      .loadAsync(artUrl(k.art.model))
      .then((gltf) => {
        const out: Kit = {
          geometry: new Map(),
          built: new Map(),
          props: null,
          propIndex: new Map(),
        };
        const props: BufferGeometry[] = [];
        gltf.scene.traverse((o) => {
          if (!(o instanceof Mesh)) {
            return;
          }
          // A node is its kind's, by the kind's id read from the catalog.
          const holder = o;
          const index = this.#kinds.findIndex((kd) => kd.id === holder.name);
          const kind = this.#kinds[index];
          if (kind === undefined) {
            return;
          }
          const g = (o.geometry as BufferGeometry).clone();
          g.applyMatrix4(o.matrixWorld);
          const extras = (holder.userData ?? {}) as { frontage?: number; depth?: number };
          out.built.set(index, { frontage: extras.frontage ?? 1, depth: extras.depth ?? 1 });
          if (kind.prop) {
            // Each prop's vertices tagged with its place among the props.
            const uvs = g.getAttribute('uv');
            for (let v = 0; v < uvs.count; v++) {
              uvs.setY(v, props.length);
            }
            out.propIndex.set(index, props.length);
            props.push(g);
          } else {
            out.geometry.set(index, g);
          }
        });
        out.props = props.length > 0 ? mergeGeometries(props) : null;
        this.#kits.set(kit, out);
        this.#version++;
        this.onKit?.(kit);
      })
      .catch(() => {
        this.#kits.set(kit, 'failed');
      });
  }

  /** The draw for a kind of a kit, made or grown to hold count instances. */
  #draw(key: string, geometry: BufferGeometry, count: number, props: boolean): Draw {
    let d = this.#draws.get(key);
    if (d === undefined || d.mesh.instanceMatrix.count < count) {
      if (d !== undefined) {
        this.root.remove(d.mesh);
        d.dispose();
      }
      const material = props ? this.#propMaterial : this.#material;
      d = new Draw(geometry, material, Math.max(16, Math.ceil(count * 1.5)), `town ${key}`);
      this.#draws.set(key, d);
      this.root.add(d.mesh);
    }
    return d;
  }

  /** Writes instance i of a draw: the building's place, turn and size, its colours and its shape. */
  #put(
    d: Draw,
    i: number,
    b: ChunkBuilding,
    sx: number,
    sy: number,
    sz: number,
    storeysMissing: number,
    storeys: number,
  ): void {
    Q.setFromAxisAngle(UP, headingToRotationY(b.heading));
    P.set(b.east, b.level, -b.north);
    S.set(sx, sy, sz);
    M.compose(P, Q, S);
    d.mesh.setMatrixAt(i, M);
    const walls = this.#walls[b.kit] ?? [];
    const roofs = this.#roofs[b.kit] ?? [];
    const shutters = this.#shutters[b.kit] ?? [];
    const w = walls[b.wall % Math.max(walls.length, 1)] ?? [0.8, 0.8, 0.8];
    const r = roofs[b.roof % Math.max(roofs.length, 1)] ?? [0.5, 0.3, 0.2];
    const s = shutters[b.shutter % Math.max(shutters.length, 1)] ?? [0.3, 0.4, 0.3];
    d.set(i, 0, w[0], w[1], w[2], 0);
    d.set(i, 1, r[0], r[1], r[2], 0);
    d.set(i, 2, s[0], s[1], s[2], 0);
    d.set(i, 3, storeysMissing * STOREY, storeys, b.seed, b.level);
  }

  /** Places what is drawn, if the camera has moved far enough or the towns changed. */
  frame(f: TownsFrame): void {
    this.root.position.set(-f.origin.x, 0, f.origin.y);
    this.night.value = f.night;
    const moved = Math.hypot(f.cameraEast - this.#at.east, f.cameraNorth - this.#at.north);
    if (this.#placed === this.#version && moved < 15) {
      return;
    }
    this.#placed = this.#version;
    this.#at = { east: f.cameraEast, north: f.cameraNorth };
    const lit = this.#world.towns.lit;
    const near2 = lit.near * lit.near;
    const props2 = lit.props * lit.props;
    // Sort the buildings into their draws.
    const near = new Map<string, ChunkBuilding[]>();
    const far: ChunkBuilding[] = [];
    let total = 0;
    for (const b of this.buildings()) {
      total++;
      const kind = this.#kinds[b.kind];
      const kit = this.#kits.get(b.kit);
      if (kind === undefined) {
        continue;
      }
      const dx = b.east - f.cameraEast;
      const dy = b.north - f.cameraNorth;
      const d2 = dx * dx + dy * dy;
      if (kind.prop) {
        if (d2 <= props2 && typeof kit === 'object' && kit.props !== null) {
          const key = `${b.kit}/props`;
          (near.get(key) ?? near.set(key, []).get(key) ?? []).push(b);
        }
        continue;
      }
      if (d2 <= near2 && typeof kit === 'object' && kit.geometry.has(b.kind)) {
        const key = `${b.kit}/${b.kind}`;
        (near.get(key) ?? near.set(key, []).get(key) ?? []).push(b);
      } else {
        far.push(b);
      }
    }
    // Each kind's draw near.
    let draws = 0;
    let triangles = 0;
    let nearCount = 0;
    let propCount = 0;
    for (const [key, d] of this.#draws) {
      if (!near.has(key)) {
        d.mesh.count = 0;
        d.mesh.visible = false;
      }
    }
    for (const [key, list] of near) {
      const [kitIndex, rest] = key.split('/') as [string, string];
      const kit = this.#kits.get(Number(kitIndex)) as Kit;
      const isProps = rest === 'props';
      const geometry = isProps
        ? (kit.props as BufferGeometry)
        : (kit.geometry.get(Number(rest)) as BufferGeometry);
      const d = this.#draw(key, geometry, list.length, isProps);
      list.forEach((b, i) => {
        const kind = this.#kinds[b.kind] as BuildingKind;
        if (isProps) {
          this.#put(d, i, b, 1, 1, 1, 0, 3);
          // A prop's own model among the props': the others drawn as nothing.
          d.set(i, 3, 0, 3, b.seed, kit.propIndex.get(b.kind) ?? 0);
          return;
        }
        const built = kit.built.get(b.kind) ?? { frontage: b.frontage, depth: b.depth };
        const most = kind.storeys[1] ?? 1;
        const storeys = housed(kind) ? Math.min(Math.max(b.storeys, 1), most) : 3;
        this.#put(
          d,
          i,
          b,
          b.frontage / built.frontage,
          1,
          b.depth / built.depth,
          housed(kind) ? most - storeys : 0,
          storeys,
        );
      });
      d.mesh.count = list.length;
      d.mesh.visible = list.length > 0;
      d.mesh.instanceMatrix.needsUpdate = true;
      d.buffer.needsUpdate = true;
      draws++;
      triangles += ((geometry.index?.count ?? 0) / 3) * list.length;
      if (isProps) {
        propCount += list.length;
      } else {
        nearCount += list.length;
      }
    }
    // Every other building: its box and roof.
    if (this.#far.mesh.instanceMatrix.count < far.length) {
      this.root.remove(this.#far.mesh);
      this.#far.dispose();
      this.#far = new Draw(
        farGeometry(),
        this.#farMaterial,
        Math.ceil(far.length * 1.5),
        'town far',
      );
      this.root.add(this.#far.mesh);
    }
    far.forEach((b, i) => {
      const height = Math.max(b.top - b.level, 2);
      this.#put(this.#far, i, b, b.frontage, height, b.depth, 0, 3);
    });
    this.#far.mesh.count = far.length;
    this.#far.mesh.visible = far.length > 0;
    this.#far.mesh.instanceMatrix.needsUpdate = true;
    this.#far.buffer.needsUpdate = true;
    if (far.length > 0) {
      draws++;
      triangles += ((this.#far.mesh.geometry.index?.count ?? 0) / 3) * far.length;
    }
    const s = this.stats;
    s.buildings = total;
    s.near = nearCount;
    s.far = far.length;
    s.props = propCount;
    s.draws = draws;
    s.triangles = triangles;
  }
}

/** A building far off: a box a metre on a side to its eaves at 0.65, a gabled roof to 1, a front of −z. */
function farGeometry(): BufferGeometry {
  const walls = new BoxGeometry(1, 0.65, 1).translate(0, 0.325, 0);
  const roof = new BufferGeometry();
  // Two slopes and two gables, the ridge across the frontage (x).
  const v = [
    -0.55, 0.65, -0.55, 0.55, 0.65, -0.55, 0.55, 1, 0, -0.55, 1, 0, 0.55, 0.65, 0.55, -0.55, 0.65,
    0.55, -0.55, 1, 0, 0.55, 1, 0, -0.5, 0.65, 0.5, -0.5, 0.65, -0.5, -0.5, 1, 0, 0.5, 0.65, -0.5,
    0.5, 0.65, 0.5, 0.5, 1, 0,
  ];
  roof.setAttribute('position', new Float32BufferAttribute(v, 3));
  roof.setIndex([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 11, 13, 12]);
  roof.computeVertexNormals();
  const tag = (g: BufferGeometry, part: number): BufferGeometry => {
    const n = g.getAttribute('position').count;
    g.deleteAttribute('uv');
    g.setAttribute(
      'uv1',
      new Float32BufferAttribute(
        new Float32Array(n * 2).map((_, i) => (i % 2 === 0 ? part : 0)),
        2,
      ),
    );
    g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
    return g;
  };
  const merged = mergeGeometries([
    tag(walls.toNonIndexed(), PART.wall),
    tag(roof.toNonIndexed(), PART.roof),
  ]);
  if (merged === null) {
    throw new Error('a far building’s parts would not merge');
  }
  return merged;
}
