// SPDX-License-Identifier: AGPL-3.0-only

// Every animal in the water in the picture, one draw: dolphins, turtles,
// flying fish, tarpon, each a body of the life's model (art/life) scaled
// to its kind's length and painted in its back's and belly's colours. All
// the bodies are in one float texture, a row of corners each, padded to
// the largest, and each instance reads its own body's corners by the
// vertex's number, so any number of kinds of body take one draw. The
// spine bends in a wave running to the tail, as fish and dolphins swim,
// in the vertex stage with no skeleton (as ABZÛ swims its schools): up and
// down for a dolphin's flukes, side to side for a fish's tail; flippers
// and pectoral fins stroke about their roots, and a flying fish folds its
// wings to swim. Its place, heading, pitch, roll and beat are written on
// the CPU each frame between begin and end.
//
// Seen through the water: what is under the surface but within two metres
// of it is drawn through the sea, as clear tropical water shows a dolphin
// riding a bow, tinted toward the water's colour and fading as it goes
// deeper. Each corner under the surface is moved along the line from the
// camera to where that line meets the surface, so it is drawn at the same
// place on the screen in front of the sea, and the sea's crests, the
// boats and the land still hide it where they stand before it. A tier
// without the tint draws the bodies solid, and the sea hides what is
// under it: only what breaks the surface is seen.

import {
  BufferGeometry,
  DataTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  FloatType,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  attribute,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  int,
  ivec2,
  max,
  mix,
  normalize,
  select,
  sin,
  smoothstep,
  textureLoad,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import type { MeshBasicNodeMaterial, Node } from 'three/webgpu';
import type { SwimLook } from '../catalog/types.gen';
import { hexRgb } from './birds';
import { artUrl } from './boat';
import { headingToRotationY } from './coords';
import { basicMaterial } from './materials';

/** The animals drawn at most in a frame. */
export const SWIMMERS = 96;
/** Floats an animal: at (x, y, z, turn), pose (pitch, roll, wave, beat), look (body, scale, fold, bend), back (rgb, length), belly (rgb, ·), more (stroke, surface, ·, ·). */
const STRIDE = 24;
/** Rows of the bodies' texture a body: its corners' places and spine shares, normals and paddle shares, colours. */
const ROWS = 3;
/** How the spine bends: up and down (a dolphin's flukes), side to side (a fish's tail), or not at all (a turtle's shell). */
const BEND_UPRIGHT = 0;
const BEND_SIDEWAYS = 1;
const BEND_NONE = 2;
/** How deep an animal is drawn through the water at most, m. */
export const SEEN_DOWN = 2;

/** A body as the draw holds it: its row in the texture and the length it was built at, m. */
interface Body {
  row: number;
  length: number;
  bend: number;
}

/** A look's paint, made once for each look. */
interface SwimPaint {
  back: readonly [number, number, number];
  belly: readonly [number, number, number];
}

const paints = new WeakMap<SwimLook, SwimPaint>();

function paintOf(look: SwimLook): SwimPaint {
  let p = paints.get(look);
  if (p === undefined) {
    p = { back: hexRgb(look.back), belly: hexRgb(look.belly) };
    paints.set(look, p);
  }
  return p;
}

/** How a body's spine bends, by its model's word: a dolphin's up and down, a fish's sideways, a turtle's shell not at all. */
function bendOf(word: string | undefined): number {
  switch (word) {
    case 'sideways':
      return BEND_SIDEWAYS;
    case 'none':
      return BEND_NONE;
  }
  return BEND_UPRIGHT;
}

/** What the tests and the panel read: the animals drawn this frame, and the draws (0 or 1). */
export interface SwimmersStats {
  swimmers: number;
  draws: number;
  /** Whether the bodies are loaded, and the triangles an animal is drawn with. */
  loaded: boolean;
  triangles: number;
}

export class Swimmers {
  readonly mesh: InstancedMesh;
  /** World time, s, within the hour. */
  readonly time = uniform(0);
  /** The daylight on them, 0 to 1; the sun's direction in the scene; the water's colour they are seen through. */
  readonly light = uniform(1);
  readonly sun = uniform(new Vector3(0, 1, 0));
  readonly water = uniform(new Vector3(0.02, 0.12, 0.16));
  readonly stats: SwimmersStats = { swimmers: 0, draws: 0, loaded: false, triangles: 0 };

  readonly #data: InstancedInterleavedBuffer;
  readonly #array: Float32Array;
  readonly #bodies = new Map<string, Body>();
  #tinted: MeshBasicNodeMaterial | null = null;
  #solid: MeshBasicNodeMaterial | null = null;
  #tint = true;
  #count = 0;
  #ox = 0;
  #oy = 0;
  #loading: 'no' | 'loading' | 'done' | 'failed' = 'no';
  /** Called once the bodies are loaded. */
  onLoad: (() => void) | null = null;

  constructor() {
    this.#data = new InstancedInterleavedBuffer(new Float32Array(SWIMMERS * STRIDE), STRIDE, 1);
    this.#data.setUsage(DynamicDrawUsage);
    this.#array = this.#data.array as Float32Array;
    // A stand-in until the bodies are loaded: nothing drawn.
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(9), 3));
    this.mesh = new InstancedMesh(g, basicMaterial(), SWIMMERS);
    this.mesh.name = 'swimmers';
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Whether the bodies are loaded and can be drawn. */
  get loaded(): boolean {
    return this.#loading === 'done';
  }

  /** The animals written so far this frame. */
  get count(): number {
    return this.#count;
  }

  /** Draws them through the water, or solid, only what breaks the surface seen. */
  setTint(on: boolean): void {
    this.#tint = on;
    const m = on ? this.#tinted : this.#solid;
    if (m !== null) {
      this.mesh.material = m;
    }
  }

  /** Whether they are drawn through the water. */
  get tinted(): boolean {
    return this.#tint;
  }

  /** Loads the bodies, once, the first time an animal in the water is near. */
  load(): void {
    if (this.#loading !== 'no') {
      return;
    }
    this.#loading = 'loading';
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    import('../catalog')
      .then(({ catalog }) => loader.loadAsync(artUrl(catalog.life.art.model)))
      .then((gltf) => {
        const meshes: Mesh[] = [];
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (o instanceof Mesh) {
            meshes.push(o);
          }
        });
        this.#build(meshes);
        this.#loading = 'done';
        this.onLoad?.();
      })
      .catch((e: unknown) => {
        this.#loading = 'failed';
        console.error('the swimmers did not load', e);
      });
  }

  /** Lays the bodies in the texture, and makes the draw's geometry and materials. */
  #build(meshes: readonly Mesh[]): void {
    const flat = meshes.map((m) => {
      const g =
        (m.geometry as BufferGeometry).index === null
          ? (m.geometry as BufferGeometry)
          : (m.geometry as BufferGeometry).toNonIndexed();
      g.applyMatrix4(m.matrixWorld);
      const extras = (m.userData ?? {}) as { length?: number; bend?: string };
      return { name: m.name, g, length: extras.length ?? 1, bend: bendOf(extras.bend) };
    });
    let corners = 3;
    for (const f of flat) {
      corners = Math.max(corners, f.g.getAttribute('position').count);
    }
    const width = corners;
    const data = new Float32Array(width * flat.length * ROWS * 4);
    flat.forEach((f, b) => {
      const pos = f.g.getAttribute('position');
      const nor = f.g.getAttribute('normal');
      const uv = f.g.getAttribute('uv');
      const col = f.g.getAttribute('color');
      const row = b * ROWS;
      for (let i = 0; i < width; i++) {
        // Corners past a body's own are its first, again: nothing drawn.
        const j = i < pos.count ? i : 0;
        const o0 = (row * width + i) * 4;
        const o1 = ((row + 1) * width + i) * 4;
        const o2 = ((row + 2) * width + i) * 4;
        data[o0] = pos.getX(j);
        data[o0 + 1] = pos.getY(j);
        data[o0 + 2] = pos.getZ(j);
        data[o0 + 3] = uv?.getX(j) ?? 0;
        data[o1] = nor?.getX(j) ?? 0;
        data[o1 + 1] = nor?.getY(j) ?? 1;
        data[o1 + 2] = nor?.getZ(j) ?? 0;
        data[o1 + 3] = uv?.getY(j) ?? 0;
        data[o2] = col?.getX(j) ?? 1;
        data[o2 + 1] = col?.getY(j) ?? 0;
        data[o2 + 2] = col?.getZ(j) ?? 0;
        data[o2 + 3] = 1;
      }
      this.#bodies.set(f.name, { row, length: f.length, bend: f.bend });
    });
    const tex = new DataTexture(data, width, flat.length * ROWS, RGBAFormat, FloatType);
    tex.minFilter = NearestFilter;
    tex.magFilter = NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(width * 3), 3));
    const corner = new Float32Array(width);
    for (let i = 0; i < width; i++) {
      corner[i] = i;
    }
    g.setAttribute('corner', new Float32BufferAttribute(corner, 1));
    ['swimAt', 'swimPose', 'swimLook', 'swimBack', 'swimBelly', 'swimMore'].forEach((name, k) => {
      g.setAttribute(name, new InterleavedBufferAttribute(this.#data, 4, k * 4));
    });
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.#tinted = this.#material(tex, true);
    this.#solid = this.#material(tex, false);
    this.mesh.material = this.#tint ? this.#tinted : this.#solid;
    this.stats.loaded = true;
    this.stats.triangles = width / 3;
  }

  /** Whether a body of the name is held. */
  has(body: string): boolean {
    return this.#bodies.has(body);
  }

  /** Begins a frame: the floating origin's place in the world, m, world time, s, and the daylight, 0 to 1. */
  begin(origin: { x: number; y: number }, time: number, light: number): void {
    this.#count = 0;
    this.#ox = origin.x;
    this.#oy = origin.y;
    this.time.value = time % 3600;
    this.light.value = light;
  }

  /**
   * An animal of a look at m east and north, up m from the scene's level
   * (the water's surface there plus its own height), the surface there at
   * surface m; heading radians clockwise from north, its pitch nose up and
   * roll right side down, radians; its tail's wave 0 to 1 and beat's
   * phase, radians; its wings' fold and its paddles' stroke, 0 to 1; size
   * a share of its length; and the body drawn, if not the look's own (a
   * bird asleep), at the look's body's scale. False once the draw is full
   * or its body is not held.
   */
  add(
    look: SwimLook,
    east: number,
    north: number,
    up: number,
    surface: number,
    heading: number,
    pitch: number,
    roll: number,
    wave: number,
    beat: number,
    fold: number,
    stroke: number,
    size = 1,
    body: string = look.body,
  ): boolean {
    const own = this.#bodies.get(look.body);
    const b = body === look.body ? own : this.#bodies.get(body);
    if (this.#count >= SWIMMERS || b === undefined || own === undefined) {
      return false;
    }
    const paint = paintOf(look);
    const scale = (look.length / own.length) * size;
    const d = this.#array;
    const o = this.#count * STRIDE;
    d[o] = east - this.#ox;
    d[o + 1] = up;
    d[o + 2] = -(north - this.#oy);
    d[o + 3] = headingToRotationY(heading);
    d[o + 4] = pitch;
    d[o + 5] = roll;
    d[o + 6] = wave;
    d[o + 7] = beat;
    d[o + 8] = b.row;
    d[o + 9] = scale;
    d[o + 10] = fold;
    d[o + 11] = b.bend;
    d[o + 12] = paint.back[0];
    d[o + 13] = paint.back[1];
    d[o + 14] = paint.back[2];
    d[o + 15] = look.length * size;
    d[o + 16] = paint.belly[0];
    d[o + 17] = paint.belly[1];
    d[o + 18] = paint.belly[2];
    d[o + 19] = 0;
    d[o + 20] = stroke;
    d[o + 21] = surface;
    d[o + 22] = 0;
    d[o + 23] = 0;
    this.#count++;
    return true;
  }

  /** Ends the frame: what was written is drawn. */
  end(): void {
    const n = this.loaded ? this.#count : 0;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#data.needsUpdate = true;
    this.stats.swimmers = n;
    this.stats.draws = n > 0 ? 1 : 0;
  }

  /** The written animal i's floats (the tests). */
  written(i: number): Float32Array {
    return this.#array.subarray(i * STRIDE, (i + 1) * STRIDE);
  }

  /** The draw's material: through the water, or solid. */
  #material(tex: DataTexture, tinted: boolean): MeshBasicNodeMaterial {
    const at = attribute('swimAt', 'vec4') as unknown as Node<'vec4'>;
    const pose = attribute('swimPose', 'vec4') as unknown as Node<'vec4'>;
    const look = attribute('swimLook', 'vec4') as unknown as Node<'vec4'>;
    const back = attribute('swimBack', 'vec4') as unknown as Node<'vec4'>;
    const belly = attribute('swimBelly', 'vec4') as unknown as Node<'vec4'>;
    const more = attribute('swimMore', 'vec4') as unknown as Node<'vec4'>;
    const corner = int(attribute('corner', 'float') as unknown as Node<'float'>);
    const row = int(look.x);
    const p4 = textureLoad(tex, ivec2(corner, row)) as unknown as Node<'vec4'>;
    const n4 = textureLoad(tex, ivec2(corner, row.add(1))) as unknown as Node<'vec4'>;
    const c4 = textureLoad(tex, ivec2(corner, row.add(2))) as unknown as Node<'vec4'>;
    const along = p4.w;
    const out = n4.w;
    const length = back.w;
    // The wave along the spine, running to the tail, stronger toward it:
    // up and down for flukes, side to side for a fish's tail.
    const phase = pose.w.sub(along.mul(2 * Math.PI * 0.9));
    const bend = sin(phase).mul(pose.z).mul(length).mul(0.07);
    const up = select(look.w.lessThan(0.5), bend.mul(smoothstep(0.35, 1, along)), float(0));
    const side = select(
      look.w.greaterThan(0.5).and(look.w.lessThan(1.5)),
      bend.mul(along.mul(along).mul(0.85).add(0.15)),
      float(0),
    );
    // Paddles stroke about their roots, and a glider's wings fold back.
    const paddle = smoothstep(0.4, 0.6, c4.z);
    const fold = look.z.mul(paddle);
    const stroke = sin(pose.w).mul(more.x).mul(out).mul(length).mul(0.12).mul(paddle);
    const p0 = p4.xyz.mul(look.y);
    const p = vec3(
      p0.x.mul(mix(float(1), float(0.18), fold)).add(side),
      p0.y.add(up).add(stroke),
      p0.z.add(fold.mul(out).mul(length).mul(0.12)),
    );
    // Rolled about its length, pitched nose up, turned to its heading.
    const cr = cos(pose.y);
    const sr = sin(pose.y);
    const cp = cos(pose.x);
    const sp = sin(pose.x);
    const c = cos(at.w);
    const s = sin(at.w);
    const turn = (v: Node<'vec3'>): Node<'vec3'> => {
      const r = vec3(v.x.mul(cr).add(v.y.mul(sr)), v.y.mul(cr).sub(v.x.mul(sr)), v.z);
      const q = vec3(r.x, r.y.mul(cp).sub(r.z.mul(sp)), r.y.mul(sp).add(r.z.mul(cp)));
      return vec3(
        q.x.mul(c).add(q.z.mul(s)),
        q.y,
        q.z.mul(c).sub(q.x.mul(s)),
      ) as unknown as Node<'vec3'>;
    };
    const world = turn(p as unknown as Node<'vec3'>).add(at.xyz) as unknown as Node<'vec3'>;
    const depth = more.y.sub(world.y);
    const lit = max(dot(normalize(turn(n4.xyz as unknown as Node<'vec3'>)), this.sun), 0)
      .mul(0.65)
      .add(0.35);
    let position: Node<'vec3'> = world;
    if (tinted) {
      // Under the surface: along the camera's line to where it meets the
      // surface, the deeper a little further, so the drawn body keeps its
      // order and stands in front of the sea.
      const level = more.y.add(0.02).add(clamp(float(1).sub(depth.div(2.5)), 0, 1).mul(0.03));
      const k = level.sub(cameraPosition.y).div(world.y.sub(cameraPosition.y));
      const moved = cameraPosition.add(world.sub(cameraPosition).mul(k));
      const under = depth.greaterThan(0).and(cameraPosition.y.greaterThan(level.add(0.05)));
      position = select(under, moved, world) as unknown as Node<'vec3'>;
    }
    const m = basicMaterial(tinted ? { transparent: true } : {}, position);
    m.name = tinted ? 'swimmers through the water' : 'swimmers';
    const vColour = varying(c4.xy);
    const vDepth = varying(depth);
    const vLit = varying(lit);
    const vBack = varying(back.xyz);
    const vBelly = varying(belly.xyz);
    const base = mix(vBelly, vBack, vColour.x).mul(float(1).sub(vColour.y.mul(0.65)));
    const shaded = base.mul(vLit).mul(this.light);
    if (tinted) {
      // Under at all, it takes the water's colour at once, and more of it
      // and less of itself the deeper it is.
      const under = smoothstep(0, 0.15, vDepth)
        .mul(0.35)
        .add(smoothstep(0.15, SEEN_DOWN, vDepth).mul(0.55));
      m.colorNode = mix(shaded, this.water.mul(this.light), under) as unknown as Node<'vec3'>;
      m.opacityNode = float(1).sub(
        smoothstep(0.3, SEEN_DOWN * 1.1, vDepth).mul(0.95),
      ) as unknown as Node<'float'>;
    } else {
      m.colorNode = shaded as unknown as Node<'vec3'>;
    }
    return m;
  }
}
