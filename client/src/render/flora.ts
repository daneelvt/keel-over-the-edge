// SPDX-License-Identifier: AGPL-3.0-only

// The plants on the page: each chunk's plants, as the mesh worker placed
// them, an instance of their kind's model (art/flora). Near the camera each
// kind is one instanced draw of its model; beyond, a tree is its far
// crown, each kind one draw more, to the far reach and the horizon; shrubs
// and tufts are drawn near only, within half the near reach. The nearest
// are drawn first, until the rung's triangles are spent: a phone's budget
// is the frame's, not the island's.
//
// Every plant sways with the true wind as Beaufort's land scale says it
// does (Royal Meteorological Society): still under force 2; from force 3
// "leaves and small twigs in constant motion"; from 5 "small trees in leaf
// begin to sway"; from 6 "large branches in motion"; from 7 "whole trees in
// motion". As Crysis bends its vegetation (Sousa, GPU Gems 3, ch. 16),
// the whole plant bends along the wind, leaning further the stronger it
// blows and the less stiff the plant, and swings about the lean at its
// own frequency; and its leaves move on their own. Each vertex carries how
// much it bends and whether it is leaf (art/flora/lib/plants.ts). The
// swing's phase runs downwind with the wind across the land, so a gust is
// seen passing over a wood. Everything is a function of world time and the
// plant's place, so every phone sways its woods alike.

import {
  type BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  attribute,
  cos,
  Fn,
  float,
  max,
  positionLocal,
  pow,
  sin,
  smoothstep,
  uniform,
  vec3,
  vertexColor,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { PlantKind, World } from '../catalog/types.gen';
import { PLANT_STRIDE } from '../workers/mesh/plants';
import { artUrl } from './boat';
import { headingToRotationY } from './coords';
import { horizonDistance, litMaterial } from './materials';

/** The forms drawn near only, as clumps. */
const NEAR_ONLY = ['shrub', 'tuft', 'krummholz'];

/** The triangles the plants may take a frame, on the high, medium and low rungs. */
export const PLANT_TRIANGLES = [40000, 24000, 12000] as const;

/** A knot's worth of the Beaufort scale: force = (v / 0.836)^(2/3), v in m/s. */
export function beaufortOf(speed: number): number {
  return (Math.max(speed, 0) / 0.836) ** (2 / 3);
}

/**
 * How far a plant leans with the wind, as a share of its height, and how
 * far its swing about the lean reaches, at a Beaufort force and a
 * stiffness: nothing below small trees' force, more at large branches',
 * whole trees' most; the stiffer the less. The shader's own rule, for the
 * tests.
 */
export function swayOf(
  force: number,
  stiffness: number,
  w: World['flora']['wind'],
): { lean: number; swing: number; leaves: number } {
  const ss = (a: number, b: number, x: number): number => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const flex = 1 - 0.8 * stiffness;
  const small = ss(w.small - 1, w.small, force);
  const large = ss(w.large - 1, w.large, force);
  const whole = ss(w.whole - 1, w.whole + 1, force);
  return {
    lean: (0.015 * small + 0.03 * large + 0.05 * whole) * flex,
    swing: (0.01 * small + 0.015 * large + 0.03 * whole) * flex,
    leaves: ss(w.leaves - 1, w.leaves, force),
  };
}

/** What a frame needs to draw the plants. */
export interface FloraFrame {
  /** The floating origin, the camera, m east and north, and its height, m. */
  origin: { x: number; y: number };
  cameraEast: number;
  cameraNorth: number;
  cameraHeight: number;
  /** The rung in use: 0 high, 1 medium, 2 low. */
  rung: number;
  /** World time, s; the true wind about the camera, m/s and the way it blows from, rad. */
  time: number;
  windSpeed: number;
  windFrom: number;
}

/** What the developer panel and the tests read of the plants. */
export interface FloraStats {
  held: number;
  near: number;
  far: number;
  draws: number;
  triangles: number;
}

/** A kind's models: near and, for a tree, far; and the size they were built at. */
interface Model {
  near: BufferGeometry;
  far: BufferGeometry | null;
  height: number;
  crown: number;
}

/** The floats of an instance's own attribute: its stiffness, its own number, its height, its turn. */
const INFO = 4;

/** An instanced draw of a kind's model. */
class Draw {
  readonly mesh: InstancedMesh;
  readonly info: InstancedBufferAttribute;
  constructor(
    geometry: BufferGeometry,
    material: ReturnType<typeof litMaterial>,
    capacity: number,
    name: string,
  ) {
    const g = geometry.clone();
    this.info = new InstancedBufferAttribute(new Float32Array(capacity * INFO), INFO);
    this.info.setUsage(DynamicDrawUsage);
    g.setAttribute('plantInfo', this.info);
    this.mesh = new InstancedMesh(g, material, capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
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

/** A plant picked for a frame: which, how far, near or far. */
interface Pick {
  chunk: Float32Array;
  at: number;
  d: number;
}

export class Flora {
  readonly root = new Group();
  readonly stats: FloraStats = { held: 0, near: 0, far: 0, draws: 0, triangles: 0 };
  /** The wind as the shader reads it: its speed, m/s; the way it blows to, in the scene (x east, z south); world time, s, reduced. */
  readonly speed = uniform(0);
  readonly toX = uniform(0);
  readonly toZ = uniform(1);
  readonly time = uniform(0);
  /** Called once the models are loaded (the tests). */
  onLoad: (() => void) | null = null;

  readonly #world: World;
  readonly #kinds: PlantKind[];
  readonly #chunks = new Map<number, Float32Array>();
  readonly #models = new Map<number, Model>();
  #loading: 'no' | 'loading' | 'done' | 'failed' = 'no';
  readonly #material: ReturnType<typeof litMaterial>;
  readonly #draws = new Map<string, Draw>();
  #version = 0;
  #placed = -1;
  #at = { east: Number.NaN, north: Number.NaN, height: Number.NaN, rung: -1 };

  constructor(world: World) {
    this.#world = world;
    this.#kinds = world.flora.kinds;
    this.root.name = 'flora';
    this.#material = this.#makeMaterial();
  }

  /** The material every plant's draw shares: its vertex colours, faceted, swaying. */
  #makeMaterial(): ReturnType<typeof litMaterial> {
    const w = this.#world.flora.wind;
    // uv: (how much it bends, whether it is leaf).
    const uv = attribute('uv', 'vec2') as unknown as Node<'vec2'>;
    const info = attribute('plantInfo', 'vec4') as unknown as Node<'vec4'>;
    const vertex = Fn(() => {
      const p = positionLocal.toVar();
      const stiffness = info.x;
      const seed = info.y;
      const height = info.z;
      const turn = info.w;
      const force = pow(max(this.speed.div(0.836), 0), 2 / 3);
      const flex = float(1).sub(stiffness.mul(0.8));
      const small = smoothstep(w.small - 1, w.small, force);
      const large = smoothstep(w.large - 1, w.large, force);
      const whole = smoothstep(w.whole - 1, w.whole + 1, force);
      const leaves = smoothstep(w.leaves - 1, w.leaves, force);
      const lean = small.mul(0.015).add(large.mul(0.03)).add(whole.mul(0.05)).mul(flex);
      const swing = small.mul(0.01).add(large.mul(0.015)).add(whole.mul(0.03)).mul(flex);
      // A tall plant swings slower: about 1/√height Hz.
      const frequency = float(1.6).div(height.max(1).sqrt());
      const phase = this.time
        .mul(frequency)
        .mul(2 * Math.PI)
        .add(seed.mul(0.0245));
      const main = lean
        .add(swing.mul(sin(phase)))
        .mul(uv.x)
        .mul(height);
      // The wind's way in the plant's own frame: turned back by its turn.
      const c = cos(turn);
      const s = sin(turn);
      const lx = this.toX.mul(c).sub(this.toZ.mul(s));
      const lz = this.toX.mul(s).add(this.toZ.mul(c));
      const detail = leaves
        .mul(uv.y)
        .mul(0.05)
        .mul(sin(this.time.mul(5.3).add(p.x.mul(2.1)).add(p.z.mul(1.7)).add(seed)));
      p.addAssign(
        vec3(
          lx.mul(main).add(detail),
          main.mul(main).mul(-0.3).div(height.max(1)),
          lz.mul(main).add(detail),
        ),
      );
      return p;
    })() as unknown as Node<'vec3'>;
    const m = litMaterial({ roughness: 0.95, metalness: 0, flatShading: true }, vertex);
    m.name = 'flora';
    m.colorNode = vertexColor() as unknown as Node<'vec3'>;
    return m;
  }

  /** A chunk's plants, handed with its land. */
  add(n: number, plants: Float32Array | null): void {
    if (plants === null || plants.length === 0) {
      return;
    }
    this.#chunks.set(n, plants);
    this.#version++;
    this.#load();
  }

  /** A chunk's land let go: its plants go with it. */
  drop(n: number): void {
    if (this.#chunks.delete(n)) {
      this.#version++;
    }
  }

  /** Lets every plant go: a new world. */
  clear(): void {
    this.#chunks.clear();
    this.#version++;
  }

  /** The plants held, each its floats (the tests). */
  *plants(): IterableIterator<{ chunk: Float32Array; at: number }> {
    for (const chunk of this.#chunks.values()) {
      for (let at = 0; at < chunk.length; at += PLANT_STRIDE) {
        yield { chunk, at };
      }
    }
  }

  /** Whether the models are loaded (the tests). */
  get loaded(): boolean {
    return this.#loading === 'done';
  }

  /** Loads the plants' models, once, when the first plants are held. */
  #load(): void {
    if (this.#loading !== 'no') {
      return;
    }
    this.#loading = 'loading';
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader
      .loadAsync(artUrl(this.#world.flora.art.model))
      .then((gltf) => {
        const near = new Map<string, Mesh>();
        gltf.scene.traverse((o) => {
          if (o instanceof Mesh) {
            near.set(o.name, o);
          }
        });
        this.#kinds.forEach((k, i) => {
          const n = near.get(k.id);
          if (n === undefined) {
            return;
          }
          const f = near.get(`${k.id}-far`);
          const extras = (n.userData ?? {}) as { height?: number; crown?: number };
          const geom = (o: Mesh): BufferGeometry => {
            const g = (o.geometry as BufferGeometry).clone();
            g.applyMatrix4(o.matrixWorld);
            return g;
          };
          this.#models.set(i, {
            near: geom(n),
            far: f === undefined || NEAR_ONLY.includes(k.form) ? null : geom(f),
            height: extras.height ?? 1,
            crown: extras.crown ?? 1,
          });
        });
        this.#loading = 'done';
        this.#version++;
        this.onLoad?.();
      })
      .catch(() => {
        this.#loading = 'failed';
      });
  }

  /** The draw for a kind's near or far model, made or grown to hold count. */
  #draw(key: string, geometry: BufferGeometry, count: number): Draw {
    let d = this.#draws.get(key);
    if (d === undefined || d.mesh.instanceMatrix.count < count) {
      if (d !== undefined) {
        this.root.remove(d.mesh);
        d.dispose();
      }
      d = new Draw(geometry, this.#material, Math.max(32, Math.ceil(count * 1.5)), `flora ${key}`);
      this.#draws.set(key, d);
      this.root.add(d.mesh);
    }
    return d;
  }

  /** Sets the wind and time each frame; places what is drawn when the camera has moved enough or the plants changed. */
  frame(f: FloraFrame): void {
    this.root.position.set(-f.origin.x, 0, f.origin.y);
    this.speed.value = f.windSpeed;
    // Blowing from f.windFrom, it blows toward the opposite bearing: in the
    // scene east is x and north is −z.
    this.toX.value = -Math.sin(f.windFrom);
    this.toZ.value = Math.cos(f.windFrom);
    this.time.value = f.time % 3600;
    if (this.#loading !== 'done') {
      return;
    }
    const moved = Math.hypot(f.cameraEast - this.#at.east, f.cameraNorth - this.#at.north);
    if (
      this.#placed === this.#version &&
      moved < 10 &&
      Math.abs(f.cameraHeight - this.#at.height) < 2 &&
      f.rung === this.#at.rung
    ) {
      return;
    }
    this.#placed = this.#version;
    this.#at = { east: f.cameraEast, north: f.cameraNorth, height: f.cameraHeight, rung: f.rung };
    this.#place(f);
  }

  #place(f: FloraFrame): void {
    const look = this.#world.flora.look;
    const nearReach = look.near[f.rung] ?? 60;
    const farReach = look.far;
    const sight = horizonDistance(f.cameraHeight);
    const near: Pick[] = [];
    const far: Pick[] = [];
    let held = 0;
    for (const chunk of this.#chunks.values()) {
      for (let at = 0; at < chunk.length; at += PLANT_STRIDE) {
        held++;
        const k = chunk[at + 6] ?? 0;
        const model = this.#models.get(k);
        if (model === undefined) {
          continue;
        }
        const d = Math.hypot((chunk[at] ?? 0) - f.cameraEast, (chunk[at + 1] ?? 0) - f.cameraNorth);
        const top = (chunk[at + 2] ?? 0) + (chunk[at + 3] ?? 0);
        if (d > sight + horizonDistance(Math.max(top, 0)) + 10) {
          continue;
        }
        const reach = model.far === null ? nearReach / 2 : nearReach;
        if (d <= reach) {
          near.push({ chunk, at, d });
        } else if (model.far !== null && d <= farReach) {
          far.push({ chunk, at, d });
        }
      }
    }
    near.sort((a, b) => a.d - b.d);
    far.sort((a, b) => a.d - b.d);
    // Spend the rung's triangles nearest first: the near, then the far.
    let budget: number = PLANT_TRIANGLES[f.rung] ?? PLANT_TRIANGLES[2];
    const byKey = new Map<string, Pick[]>();
    const take = (list: Pick[], which: 'near' | 'far'): number => {
      let n = 0;
      for (const p of list) {
        const k = p.chunk[p.at + 6] ?? 0;
        const model = this.#models.get(k) as Model;
        const g = which === 'near' ? model.near : (model.far as BufferGeometry);
        const tris = (g.index?.count ?? g.getAttribute('position').count) / 3;
        if (tris > budget) {
          break;
        }
        budget -= tris;
        const key = `${which}/${k}`;
        (byKey.get(key) ?? byKey.set(key, []).get(key) ?? []).push(p);
        n++;
      }
      return n;
    };
    const nearCount = take(near, 'near');
    const farCount = take(far, 'far');
    for (const [key, d] of this.#draws) {
      if (!byKey.has(key)) {
        d.mesh.count = 0;
        d.mesh.visible = false;
      }
    }
    let draws = 0;
    let triangles = 0;
    for (const [key, list] of byKey) {
      const [which, kindIndex] = key.split('/') as ['near' | 'far', string];
      const k = Number(kindIndex);
      const model = this.#models.get(k) as Model;
      const kind = this.#kinds[k] as PlantKind;
      const g = which === 'near' ? model.near : (model.far as BufferGeometry);
      const d = this.#draw(key, g, list.length);
      const info = d.info.array as Float32Array;
      list.forEach((p, i) => {
        const c = p.chunk;
        const h = c[p.at + 3] ?? model.height;
        const crown = c[p.at + 4] ?? model.crown;
        const turn = c[p.at + 5] ?? 0;
        Q.setFromAxisAngle(UP, headingToRotationY(turn));
        P.set(c[p.at] ?? 0, c[p.at + 2] ?? 0, -(c[p.at + 1] ?? 0));
        S.set(crown / model.crown, h / model.height, crown / model.crown);
        M.compose(P, Q, S);
        d.mesh.setMatrixAt(i, M);
        info[i * INFO] = kind.stiffness;
        info[i * INFO + 1] = c[p.at + 7] ?? 0;
        info[i * INFO + 2] = model.height;
        info[i * INFO + 3] = headingToRotationY(turn);
      });
      d.mesh.count = list.length;
      d.mesh.visible = list.length > 0;
      d.mesh.instanceMatrix.needsUpdate = true;
      d.info.needsUpdate = true;
      draws++;
      triangles += ((g.index?.count ?? 0) / 3) * list.length;
    }
    const s = this.stats;
    s.held = held;
    s.near = nearCount;
    s.far = farCount;
    s.draws = draws;
    s.triangles = triangles;
  }
}
