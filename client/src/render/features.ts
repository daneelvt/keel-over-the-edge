// SPDX-License-Identifier: AGPL-3.0-only

// The islands' features on the page, from the parts their chunks hold
// (the arches' and caves' roofs are the land's own, in its mesh):
//
// - A waterfall: a curtain from its lip to the sea, its width by what it
//   drains, falling as a free jet does, y = ½ g t² (Rouse 1936), so its
//   foot stands out from the cliff; foam streaming down it; spray at its
//   foot. Smyth's cascade is "a fall of water from a considerable height".
// - A blowhole: a spout of spray from its vent with each wave, as high as
//   the waves make it, "the stronger the waves, the more regular the
//   bursts" (Kiama, Spouting Horn). The waves' period is a fully
//   developed sea's of the waves' height (Pierson and Moskowitz 1964).
// - A fumarole: steam rising from its vent and drifting with the wind, the
//   town smoke's puffs, white.
// - A seabird colony: its birds wheeling over it by day, gliding and
//   flapping, settled at night (Smyth's booby "is fond of resting out of
//   the water at night").
//
// Each is a function of world time and its part's numbers, so every phone
// shows the same spouts, curtains and birds. All the curtains are one
// draw, the spray one, the steam one, the birds one.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
} from 'three';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  dot,
  exp,
  Fn,
  float,
  fract,
  instancedDynamicBufferAttribute,
  mix,
  positionLocal,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { FeatureKind, World } from '../catalog/types.gen';
import type { ChunkFeatures, ChunkPart } from '../workers/mesh/chunk';
import { headingToRotationY } from './coords';
import { basicMaterial, bendScene, horizonDistance, litMaterial } from './materials';
import { type Chimney, Smoke } from './smoke';

/** A fully developed sea's peak period, s, for waves of significant height h, m (Pierson and Moskowitz 1964). */
export function wavePeriod(h: number): number {
  return Math.min(Math.max(5.26 * Math.sqrt(Math.max(h, 0)), 3), 14);
}

/** How high a blowhole's spout stands, m, a share p of the way through its cycle: up fast, down slower, nothing between bursts. */
export function spoutHeight(p: number, most: number): number {
  if (p < 0.12) {
    return most * Math.sin((p / 0.12) * (Math.PI / 2));
  }
  if (p < 0.4) {
    return most * Math.cos(((p - 0.12) / 0.28) * (Math.PI / 2));
  }
  return 0;
}

/** Where a colony's bird is at world time t, s: its bearing round the colony, how far out and how high, m. */
export function birdAt(
  t: number,
  k: number,
  seed: number,
  wheel: number,
): { a: number; r: number; up: number } {
  const own = (x: number): number => {
    const v = Math.sin((seed + 1) * 12.9898 + k * 78.233 + x) * 43758.5453;
    return v - Math.floor(v);
  };
  const speed = 8 + 6 * own(1);
  const r = wheel * (0.35 + 0.65 * own(2));
  const dir = own(3) < 0.5 ? 1 : -1;
  const a = own(4) * 2 * Math.PI + dir * (speed / r) * t;
  return {
    a,
    r: r * (0.75 + 0.25 * Math.sin(a * 0.7 + own(5) * 6)),
    up: 6 + 30 * own(6) + 6 * Math.sin(a * 1.3 + own(7) * 6),
  };
}

/** What a frame needs to draw the features. */
export interface FeaturesFrame {
  origin: { x: number; y: number };
  cameraEast: number;
  cameraNorth: number;
  cameraHeight: number;
  /** World time, s; the daylight on them, 0 to 1; whether it is night; the waves' significant height, m; the wind, m/s and from. */
  time: number;
  light: number;
  night: boolean;
  seaHeight: number;
  windSpeed: number;
  windFrom: number;
}

/** What the tests and the panel read. */
export interface FeaturesStats {
  parts: number;
  falls: number;
  spouts: number;
  vents: number;
  birds: number;
  puffs: number;
  draws: number;
}

/** The capacities. */
const FALLS = 64;
const PUFFS = 1024;
const BIRDS = 1024;
/** The curtain's rows down and columns across. */
const ROWS = 10;
const COLS = 2;
/** The features drawn within this of the camera, m. */
const REACH = 2500;

/** A part, with its feature's kind. */
interface Held {
  part: ChunkPart;
  kind: FeatureKind;
}

export class Features {
  readonly root = new Group();
  /** What is placed in scene coordinates already: the spray and the steam. */
  readonly scene = new Group();
  readonly stats: FeaturesStats = {
    parts: 0,
    falls: 0,
    spouts: 0,
    vents: 0,
    birds: 0,
    puffs: 0,
    draws: 0,
  };
  readonly time = uniform(0);
  readonly light = uniform(1);
  readonly steam: Smoke;

  readonly #world: World;
  readonly #chunks = new Map<number, ChunkPart[]>();
  readonly #falls: InstancedMesh;
  readonly #fallData: InstancedInterleavedBuffer;
  readonly #puffs: InstancedMesh;
  readonly #puffPlace: InstancedInterleavedBuffer;
  readonly #puffShade: InstancedInterleavedBuffer;
  readonly #birds: InstancedMesh;
  readonly #birdData: InstancedInterleavedBuffer;

  constructor(world: World) {
    this.#world = world;
    this.root.name = 'features';
    this.scene.name = 'features in the scene';
    const smoke = world.towns.smoke;
    this.steam = new Smoke({
      ...smoke,
      day: 1,
      night: 1,
      rise: world.features.look.steam,
      life: 12,
      puffs: 8,
      size: [1.5, 7],
      reach: REACH,
    });
    this.steam.mesh.name = 'steam';
    this.scene.add(this.steam.mesh);
    [this.#falls, this.#fallData] = this.#makeFalls();
    [this.#puffs, this.#puffPlace, this.#puffShade] = this.#makePuffs();
    [this.#birds, this.#birdData] = this.#makeBirds();
    this.root.add(this.#falls, this.#birds);
    this.scene.add(this.#puffs);
  }

  /** The curtains: a strip ROWS long and COLS across, a unit wide and deep, bent and sized by each fall's data. */
  #makeFalls(): [InstancedMesh, InstancedInterleavedBuffer] {
    const pos: number[] = [];
    const idx: number[] = [];
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        pos.push(c / COLS - 0.5, r / ROWS, 0);
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = r * (COLS + 1) + c;
        idx.push(a, a + 1, a + COLS + 1, a + 1, a + COLS + 2, a + COLS + 1);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const data = new InstancedInterleavedBuffer(new Float32Array(FALLS * 8), 8, 1);
    data.setUsage(DynamicDrawUsage);
    g.setAttribute('fallAt', new InterleavedBufferAttribute(data, 4, 0));
    g.setAttribute('fallShape', new InterleavedBufferAttribute(data, 4, 4));
    const at = attribute('fallAt', 'vec4') as unknown as Node<'vec4'>;
    const shape = attribute('fallShape', 'vec4') as unknown as Node<'vec4'>;
    // shape: (heading as a turn about y, drop, seed, ·); at: (x, y, z, width).
    const across = positionLocal.x;
    const down = positionLocal.y;
    const vertex = Fn(() => {
      const drop = shape.y;
      // A free jet: it leaves the lip at a few m/s and falls as ½ g t².
      const t = down.mul(drop.mul(2 / 9.8).sqrt());
      const out = t.mul(2.2);
      const local = vec3(across.mul(at.w), down.mul(drop).negate(), out.negate());
      const c = cos(shape.x);
      const s = sin(shape.x);
      return vec3(
        local.x.mul(c).add(local.z.mul(s)),
        local.y,
        local.z.mul(c).sub(local.x.mul(s)),
      ).add(at.xyz);
    })() as unknown as Node<'vec3'>;
    const m = basicMaterial({ transparent: true, depthWrite: false, side: DoubleSide }, vertex);
    m.name = 'falls';
    const vDown = varying(down);
    const vAcross = varying(across);
    const vSeed = varying(shape.z);
    // Foam streaming down, in streaks across.
    const streak = fract(
      vAcross
        .mul(5.3)
        .add(vSeed)
        .add(sin(vAcross.mul(17)).mul(0.2)),
    );
    const flow = fract(vDown.mul(3).sub(this.time.mul(1.4)).add(streak.mul(0.6)));
    const alpha = smoothstep(0, 0.08, vDown)
      .mul(float(1).sub(smoothstep(0.85, 1, vDown).mul(0.4)))
      .mul(mix(float(0.55), float(0.9), smoothstep(0.3, 0.7, flow)));
    m.colorNode = vec3(0.9, 0.93, 0.95).mul(this.light) as unknown as Node<'vec3'>;
    m.opacityNode = alpha as unknown as Node<'float'>;
    const mesh = new InstancedMesh(g, m, FALLS);
    mesh.name = 'falls';
    mesh.count = 0;
    mesh.frustumCulled = false;
    return [mesh, data];
  }

  /** The spray and the spouts: soft billboards, placed on the CPU each frame. */
  #makePuffs(): [InstancedMesh, InstancedInterleavedBuffer, InstancedInterleavedBuffer] {
    const g = new BufferGeometry();
    g.setAttribute(
      'corner',
      new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
    );
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (): InstancedInterleavedBuffer => {
      const b = new InstancedInterleavedBuffer(new Float32Array(PUFFS * 4), 4, 1);
      b.setUsage(DynamicDrawUsage);
      return b;
    };
    const placeBuf = mk();
    const shadeBuf = mk();
    const place = instancedDynamicBufferAttribute(
      placeBuf,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const shade = instancedDynamicBufferAttribute(
      shadeBuf,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    const m = basicMaterial();
    m.name = 'spray';
    m.transparent = true;
    m.depthWrite = false;
    const view = cameraViewMatrix.mul(vec4(bendScene(place.xyz), 1));
    m.vertexNode = cameraProjectionMatrix.mul(
      vec4(view.xy.add(corner.mul(place.w.mul(0.5))), view.z, 1),
    );
    const vCorner = varying(corner);
    const vShade = varying(shade);
    const soft = exp(dot(vCorner, vCorner).mul(-3)).sub(0.05).max(0);
    m.fragmentNode = vec4(
      vec3(0.92, 0.94, 0.95).mul(this.light),
      soft.mul(vShade.x).mul(0.8),
    ) as unknown as Node<'vec4'>;
    const mesh = new InstancedMesh(g, m, PUFFS);
    mesh.name = 'spray';
    mesh.count = 0;
    mesh.frustumCulled = false;
    return [mesh, placeBuf, shadeBuf];
  }

  /** The birds: a body and two wings of two panels each, flapping on the GPU. */
  #makeBirds(): [InstancedMesh, InstancedInterleavedBuffer] {
    // x across the wings (a unit span), z from tail (+) to bill (−); uv.x
    // the wing's share out, uv.y the part: 0 body, 1 wing, 2 tip.
    const v: number[] = [];
    const uv: number[] = [];
    const tri = (a: number[], b: number[], c: number[], out: number[], part: number) => {
      v.push(...a, ...b, ...c);
      uv.push(out[0] ?? 0, part, out[1] ?? 0, part, out[2] ?? 0, part);
    };
    tri([0, 0, -0.35], [0.06, 0, 0.1], [-0.06, 0, 0.1], [0, 0, 0], 0);
    tri([-0.06, 0, 0.1], [0.06, 0, 0.1], [0, 0, 0.3], [0, 0, 0], 0);
    for (const side of [1, -1]) {
      tri(
        [0.05 * side, 0, -0.1],
        [0.3 * side, 0, -0.06],
        [0.05 * side, 0, 0.08],
        [0.1, 0.6, 0.1],
        1,
      );
      tri(
        [0.3 * side, 0, -0.06],
        [0.3 * side, 0, 0.06],
        [0.05 * side, 0, 0.08],
        [0.6, 0.6, 0.1],
        1,
      );
      tri([0.3 * side, 0, -0.06], [0.5 * side, 0, 0.02], [0.3 * side, 0, 0.06], [0.6, 1, 0.6], 2);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(v, 3));
    g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const data = new InstancedInterleavedBuffer(new Float32Array(BIRDS * 16), 16, 1);
    data.setUsage(DynamicDrawUsage);
    ['birdAt', 'birdFly', 'birdBody', 'birdWing'].forEach((name, k) => {
      g.setAttribute(name, new InterleavedBufferAttribute(data, 4, k * 4));
    });
    const at = attribute('birdAt', 'vec4') as unknown as Node<'vec4'>;
    const fly = attribute('birdFly', 'vec4') as unknown as Node<'vec4'>;
    const body = attribute('birdBody', 'vec4') as unknown as Node<'vec4'>;
    const wing = attribute('birdWing', 'vec4') as unknown as Node<'vec4'>;
    const tag = attribute('uv', 'vec2') as unknown as Node<'vec2'>;
    // at: (x, y, z, heading as a turn about y); fly: (flap Hz, glide share, phase, span); body: (rgb, ·); wing: (rgb of the wing, tip's grey).
    const vertex = Fn(() => {
      const p = positionLocal.mul(fly.w).toVar();
      const cycle = fract(this.time.mul(0.12).add(fly.z));
      const flapping = select(cycle.greaterThan(fly.y), float(1), float(0.08));
      const beat = sin(
        this.time
          .mul(fly.x)
          .mul(2 * Math.PI)
          .add(fly.z.mul(40)),
      );
      p.y.addAssign(beat.mul(tag.x).mul(fly.w).mul(0.35).mul(flapping));
      const c = cos(at.w);
      const s = sin(at.w);
      return vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s))).add(at.xyz);
    })() as unknown as Node<'vec3'>;
    // In their own colours by the daylight, so a gannet shows white against
    // the sky as it does.
    const m = basicMaterial({ side: DoubleSide }, vertex);
    m.name = 'birds';
    const vPart = varying(tag.y);
    const vBody = varying(body.xyz);
    const vWing = varying(wing.xyz);
    const vTip = varying(wing.w);
    m.colorNode = select(
      vPart.lessThan(0.5),
      vBody,
      select(vPart.lessThan(1.5), vWing, vec3(vTip, vTip, vTip)),
    ).mul(this.light) as unknown as Node<'vec3'>;
    const mesh = new InstancedMesh(g, m, BIRDS);
    mesh.name = 'birds';
    mesh.count = 0;
    mesh.frustumCulled = false;
    return [mesh, data];
  }

  /** A chunk's features, handed with its land. */
  add(n: number, f: ChunkFeatures | null): void {
    if (f === null || f.parts.length === 0) {
      return;
    }
    this.#chunks.set(n, f.parts);
  }

  /** A chunk's land let go. */
  drop(n: number): void {
    this.#chunks.delete(n);
  }

  /** Lets every feature go: a new world. */
  clear(): void {
    this.#chunks.clear();
  }

  /** The parts held, with their kinds. */
  *held(): IterableIterator<Held> {
    const kinds = this.#world.features.kinds;
    for (const parts of this.#chunks.values()) {
      for (const part of parts) {
        const kind = kinds[part.kind];
        if (kind !== undefined) {
          yield { part, kind };
        }
      }
    }
  }

  /** Places every feature near enough for this frame. */
  frame(f: FeaturesFrame): void {
    this.root.position.set(-f.origin.x, 0, f.origin.y);
    this.time.value = f.time % 3600;
    this.light.value = f.light;
    const look = this.#world.features.look;
    const sight = horizonDistance(f.cameraHeight);
    const fallData = this.#fallData.array as Float32Array;
    const place = this.#puffPlace.array as Float32Array;
    const shade = this.#puffShade.array as Float32Array;
    const birdData = this.#birdData.array as Float32Array;
    let falls = 0;
    let puffs = 0;
    let birds = 0;
    let spouts = 0;
    let parts = 0;
    const vents: Chimney[] = [];
    const puff = (e: number, y: number, n: number, w: number, a: number) => {
      if (puffs >= PUFFS) {
        return;
      }
      const i = puffs * 4;
      place[i] = e - f.origin.x;
      place[i + 1] = y;
      place[i + 2] = -(n - f.origin.y);
      place[i + 3] = w;
      shade[i] = a;
      puffs++;
    };
    const period = wavePeriod(f.seaHeight);
    for (const { part: p, kind } of this.held()) {
      parts++;
      const d = Math.hypot(p.east - f.cameraEast, p.north - f.cameraNorth);
      if (d > REACH || d > sight + horizonDistance(Math.max(p.level, 0) + 40) + 50) {
        continue;
      }
      const own = (x: number): number => {
        const v = Math.sin(p.seed * 12.9898 + x * 78.233 + p.east * 0.01) * 43758.5453;
        return v - Math.floor(v);
      };
      switch (kind.site) {
        case 'waterfall': {
          if (falls >= FALLS) {
            break;
          }
          const o = falls * 8;
          fallData[o] = p.east;
          fallData[o + 1] = p.level;
          fallData[o + 2] = -p.north;
          fallData[o + 3] = p.size;
          fallData[o + 4] = headingToRotationY(p.heading);
          fallData[o + 5] = p.level;
          fallData[o + 6] = own(1);
          falls++;
          // Spray at its foot, out from the cliff.
          const foot = Math.sqrt((2 * p.level) / 9.8) * 2.2;
          const fe = p.east + Math.sin(p.heading) * foot;
          const fn = p.north + Math.cos(p.heading) * foot;
          for (let k = 0; k < 4; k++) {
            const cycle = (f.time / 3 + k / 4 + own(2 + k)) % 1;
            puff(
              fe + (own(9 + k) - 0.5) * p.size,
              cycle * p.level * look.spray,
              fn,
              p.size * (0.8 + cycle),
              0.6 * (1 - cycle),
            );
          }
          break;
        }
        case 'blowhole': {
          spouts++;
          const most = look.spout * Math.max(f.seaHeight, 0.3);
          const phase = (f.time / period + own(1)) % 1;
          const h = spoutHeight(phase, most);
          if (h <= 0.1) {
            break;
          }
          for (let k = 0; k < 6; k++) {
            const t = (k + 0.5) / 6;
            puff(p.east, p.level + h * t, p.north, 1.2 + 2.4 * t, 0.9 - 0.4 * t);
          }
          break;
        }
        case 'fumarole':
          vents.push({
            east: p.east,
            north: p.north,
            top: p.level,
            speed: f.windSpeed,
            from: f.windFrom,
            seed: p.seed,
          });
          break;
        case 'colony': {
          if (f.night || kind.birds === undefined) {
            break;
          }
          const b = kind.birds;
          const body = hexRgb(b.body);
          const wingC = hexRgb(b.wing);
          const tip = hexRgb(b.tip)[0];
          for (let k = 0; k < p.count && birds < BIRDS; k++) {
            const at = birdAt(f.time, k, p.seed, p.size);
            const o = birds * 16;
            birdData[o] = p.east + at.r * Math.sin(at.a);
            birdData[o + 1] = p.level + at.up;
            birdData[o + 2] = -(p.north + at.r * Math.cos(at.a));
            // Flying round: along the tangent of its circle.
            birdData[o + 3] = headingToRotationY(at.a + Math.PI / 2);
            birdData[o + 4] = b.flap;
            birdData[o + 5] = b.glide;
            birdData[o + 6] = own(20 + k);
            birdData[o + 7] = b.span;
            birdData.set(body, o + 8);
            birdData.set(wingC, o + 12);
            birdData[o + 15] = tip;
            birds++;
          }
          break;
        }
      }
    }
    this.#falls.count = falls;
    this.#falls.visible = falls > 0;
    this.#fallData.needsUpdate = true;
    this.#puffs.count = puffs;
    this.#puffs.visible = puffs > 0;
    this.#puffPlace.needsUpdate = true;
    this.#puffShade.needsUpdate = true;
    this.#birds.count = birds;
    this.#birds.visible = birds > 0;
    this.#birdData.needsUpdate = true;
    this.steam.frame(vents, f.origin, f.time, f.light);
    const s = this.stats;
    s.parts = parts;
    s.falls = falls;
    s.spouts = spouts;
    s.vents = vents.length;
    s.birds = birds;
    s.puffs = puffs;
    s.draws =
      (falls > 0 ? 1 : 0) +
      (puffs > 0 ? 1 : 0) +
      (birds > 0 ? 1 : 0) +
      (this.steam.count > 0 ? 1 : 0);
  }
}

/** A colour #rrggbb as linear values. */
function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}
