// SPDX-License-Identifier: AGPL-3.0-only

// Spray: drops thrown into the air, drawn as sprites in one instanced draw.
// A boat's bow throws them when the sea rises against it, faster than a
// walking pace, so a boat that slams into a crest throws a burst and one
// that rides it throws none; more the faster it sails and the more the sea
// breaks. In a gale, from force 8, where the Beaufort scale has spray
// blown from the crests, the wind also tears a thin drift off the breaking
// crests near the camera. A
// drop is blown down the wind and falls under gravity for about a second.
//
// The drops are stepped here, on the CPU, by a seeded generator, so the same
// sail throws the same spray (the pictures). Nothing is allocated once made.

import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
} from 'three';
import {
  attribute,
  cameraWorldMatrix,
  dot,
  Fn,
  float,
  positionGeometry,
  smoothstep,
  varying,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { beaufort, KNOT, SPRAY } from '../ocean/look';
import type { FloatingOrigin } from './coords';
import { basicMaterial } from './materials';

const GRAVITY = 9.81;
/** A drop takes on the wind's speed over this long, in seconds. */
const DRAG = 0.4;
/** Fields a drop: east, north, up (m), their rates (m/s), its age and life (s), its size (m). */
const FIELDS = 9;

/** A generator of numbers in [0, 1) from a seed (Tommy Ettinger's mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A boat that may throw spray, this frame. */
export interface SpraySource {
  /** The bow, in the world: east, north, and its height above the still water, m. */
  east: number;
  north: number;
  height: number;
  /** The sea's height there, m. */
  sea: number;
  /** Heading, clockwise from north, and speed through the water, m/s. */
  heading: number;
  speed: number;
}

/** The weather the spray is thrown in. */
export interface SprayWeather {
  /** The wind 10 m up, m/s, and the direction it blows toward: east and north. */
  speed: number;
  east: number;
  north: number;
  /** The whitecaps' strength, 0 to 1. */
  whitecaps: number;
}

/** A place near the camera a crest may throw spray from: where it is, and how high the crest stands for its sea. */
export interface CrestSample {
  east: number;
  north: number;
  height: number;
  /** The boat band's height in half significant heights there. */
  crest: number;
}

export class SprayDrops {
  /** The most drops at once. */
  capacity: number;
  /** Drops alive: data[0 … count). */
  count = 0;
  readonly data: Float64Array;
  /** Each source's last rise: its sea less its bow, m, by its place among the sources. */
  readonly #last: Float64Array;
  readonly #had: Uint8Array;
  #rand: () => number;
  /** Drops owed but not yet thrown: fractions carry from frame to frame. */
  #owed = 0;

  constructor(capacity: number, seed = 1, sources = 8) {
    this.capacity = capacity;
    this.data = new Float64Array(2048 * FIELDS);
    this.#last = new Float64Array(sources);
    this.#had = new Uint8Array(sources);
    this.#rand = seeded(seed);
  }

  /** Starts again from no drops, with a seed. */
  reset(seed: number): void {
    this.count = 0;
    this.#had.fill(0);
    this.#owed = 0;
    this.#rand = seeded(seed);
  }

  /** Throws a drop at a place with a velocity, if there is room. */
  #throw(e: number, n: number, h: number, ve: number, vn: number, vh: number, size: number): void {
    if (this.count >= this.capacity) {
      return;
    }
    const at = this.count * FIELDS;
    const d = this.data;
    d[at] = e;
    d[at + 1] = n;
    d[at + 2] = h;
    d[at + 3] = ve;
    d[at + 4] = vn;
    d[at + 5] = vh;
    d[at + 6] = 0;
    d[at + 7] = SPRAY.life * (0.6 + 0.8 * this.#rand());
    d[at + 8] = size;
    this.count++;
  }

  /**
   * One frame of dt seconds: the drops move and age, the bows throw, and in
   * a gale so do the crests.
   */
  step(
    dt: number,
    sources: readonly SpraySource[],
    weather: SprayWeather,
    crests: readonly CrestSample[] = [],
    sourceCount = sources.length,
    crestCount = crests.length,
  ): void {
    if (!(dt > 0)) {
      return;
    }
    const d = this.data;
    const k = 1 - Math.exp(-dt / DRAG);
    const we = weather.east * weather.speed;
    const wn = weather.north * weather.speed;
    // Move and age, keeping the living together at the front.
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      const at = i * FIELDS;
      const age = (d[at + 6] as number) + dt;
      if (age >= (d[at + 7] as number) || (d[at + 2] as number) < -0.3) {
        continue;
      }
      const to = alive * FIELDS;
      for (let f = 0; f < FIELDS; f++) {
        d[to + f] = d[at + f] as number;
      }
      d[to + 3] = (d[to + 3] as number) + (we - (d[to + 3] as number)) * k;
      d[to + 4] = (d[to + 4] as number) + (wn - (d[to + 4] as number)) * k;
      d[to + 5] = (d[to + 5] as number) - GRAVITY * dt;
      d[to] = (d[to] as number) + (d[to + 3] as number) * dt;
      d[to + 1] = (d[to + 1] as number) + (d[to + 4] as number) * dt;
      d[to + 2] = (d[to + 2] as number) + (d[to + 5] as number) * dt;
      d[to + 6] = age;
      alive++;
    }
    this.count = alive;

    for (let s = 0; s < sourceCount && s < this.#last.length; s++) {
      const src = sources[s] as SpraySource;
      const gap = src.sea - src.height;
      const had = this.#had[s] === 1;
      const was = this.#last[s] as number;
      this.#last[s] = gap;
      this.#had[s] = 1;
      if (!had || src.speed < SPRAY.minSpeed) {
        continue;
      }
      // How fast the sea rises against the bow.
      const rise = (gap - was) / dt;
      if (rise <= SPRAY.rise) {
        continue;
      }
      this.#owed += (rise - SPRAY.rise) * src.speed * (10 + 30 * weather.whitecaps) * dt * 4;
      const fe = Math.sin(src.heading);
      const fn = Math.cos(src.heading);
      while (this.#owed >= 1) {
        this.#owed -= 1;
        const side = this.#rand() < 0.5 ? -1 : 1;
        const out = 0.6 + 1.6 * this.#rand();
        const up = 1.2 + 2.2 * this.#rand() * Math.min(rise, 2);
        const ahead = src.speed * (0.3 + 0.4 * this.#rand());
        this.#throw(
          src.east + fe * 0.2 * this.#rand(),
          src.north + fn * 0.2 * this.#rand(),
          Math.max(src.sea, src.height) + 0.05,
          fe * ahead - fn * side * out,
          fn * ahead + fe * side * out,
          up,
          0.05 + 0.08 * this.#rand(),
        );
      }
    }

    if (beaufort(weather.speed / KNOT) >= SPRAY.crestForce) {
      for (let i = 0; i < crestCount; i++) {
        const c = crests[i] as CrestSample;
        if (c.crest < 0.9) {
          continue;
        }
        // A thin drift: a drop or so a crest a second, blown off its top.
        if (this.#rand() < dt * 3 * Math.min(c.crest - 0.9, 1)) {
          this.#throw(
            c.east + (this.#rand() - 0.5) * 2,
            c.north + (this.#rand() - 0.5) * 2,
            c.height + 0.1,
            we * 0.5,
            wn * 0.5,
            0.8 + this.#rand(),
            0.08 + 0.1 * this.#rand(),
          );
        }
      }
    }
  }
}

/** The spray as it is drawn: one instanced mesh of camera-facing sprites. */
export class SprayView {
  readonly mesh: Mesh;
  readonly #data: Float32Array;
  readonly #attr: InstancedBufferAttribute;
  readonly #geometry: InstancedBufferGeometry;

  constructor(capacity = 2048) {
    const g = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    g.setAttribute('position', plane.getAttribute('position'));
    g.setIndex(plane.getIndex());
    this.#data = new Float32Array(capacity * 4);
    this.#attr = new InstancedBufferAttribute(this.#data, 4);
    this.#attr.setUsage(DynamicDrawUsage);
    g.setAttribute('drop', this.#attr);
    g.instanceCount = 0;
    this.#geometry = g;
    const drop = attribute<'vec4'>('drop', 'vec4');
    // The sprite's corner, along the camera's right and up.
    const columns = cameraWorldMatrix as unknown as { element(i: number): Node<'vec4'> };
    const right = columns.element(0).xyz;
    const up = columns.element(1).xyz;
    const size = drop.w.abs();
    const vertex = drop.xyz
      .add(right.mul(positionGeometry.x.mul(size)))
      .add(up.mul(positionGeometry.y.mul(size))) as unknown as Node<'vec3'>;
    const m = basicMaterial({ transparent: true, depthWrite: false }, vertex);
    const corner = varying(positionGeometry.xy);
    // A drop's sign carries its fading: a fresh drop is whole, an old one thin.
    const fade = varying(drop.w.sign().mul(0.5).add(0.5));
    m.colorNode = vec3(0.95, 0.97, 0.97);
    m.opacityNode = Fn(() => {
      const r = dot(corner, corner).mul(4);
      return float(1)
        .sub(smoothstep(0.3, 1, r))
        .mul(fade.mul(0.45).add(0.4));
    })() as unknown as Node<'float'>;
    m.name = 'spray';
    this.mesh = new Mesh(g, m);
    this.mesh.name = 'spray';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Puts the drops in the scene about the floating origin. */
  draw(drops: SprayDrops, origin: FloatingOrigin): void {
    const n = Math.min(drops.count, this.#data.length / 4);
    const d = drops.data;
    const o = origin.world;
    for (let i = 0; i < n; i++) {
      const at = i * FIELDS;
      const young = (d[at + 6] as number) < 0.5 * (d[at + 7] as number);
      this.#data[i * 4] = (d[at] as number) - o.x;
      this.#data[i * 4 + 1] = d[at + 2] as number;
      this.#data[i * 4 + 2] = -((d[at + 1] as number) - o.y);
      this.#data[i * 4 + 3] = (young ? 1 : -1) * (d[at + 8] as number);
    }
    this.#geometry.instanceCount = n;
    this.#attr.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}
