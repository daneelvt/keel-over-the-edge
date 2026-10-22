// SPDX-License-Identifier: AGPL-3.0-only

// Rain, drawn as plain falling lines. Thin quads, since a line is one pixel
// wide on WebGPU, each a streak as long as its drop falls in a thirtieth of
// a second, slanted by the wind, blended and writing no depth.
//
// At the boat the streaks fill a box about the camera, as many as the rain's
// rate asks: each drop's place is a hash, carried down at its terminal
// speed and along with the wind, and wrapped in the box; the phase that
// carries them is worked out here in double precision, so the shader works
// with the box's few metres. The drops' size and speed follow the rate:
// Marshall and Palmer's median-volume diameter, about 0.90 R^0.21 mm for R
// mm an hour, falling at Atlas's fit to Gunn and Kinzer, 9.65 − 10.3
// e^(−0.6 D) m/s.
//
// Under each cloud that rains, curtains: streaks from its base to the sea
// over the footprint where its rain passes a millimetre an hour, more as it
// rains harder, grey as its base, hazed as its puffs.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  Vector3,
} from 'three';
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  exp,
  float,
  fract,
  instancedBufferAttribute,
  instancedDynamicBufferAttribute,
  mix,
  normalize,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import { RECORDS, SIZES } from '../predict/layout.gen';
import { basicMaterial, bendScene } from './materials';
import { look, toLinear } from './sky';

/** The box of streaks about the camera, m: across, up, along. */
export const RAIN_BOX = { across: 70, up: 30 } as const;

/** The streaks at the boat at most, on the high tier. */
export const STREAKS_MOST = 2048;

/** The curtains' streaks at most, and under one cloud. */
export const CURTAIN_MOST = 2048;
export const CURTAIN_CLOUD = 600;

/** A streak's width, m, and how opaque it is; the curtains' streaks are wider, seen from afar. */
const STREAK_WIDTH = 0.012;
const STREAK_ALPHA = 0.32;
const CURTAIN_WIDTH = 2.5;
const CURTAIN_ALPHA = 0.18;

/** The median-volume diameter of rain of a rate, mm an hour, mm (Marshall and Palmer 1948). */
export function dropDiameter(rate: number): number {
  return 0.9 * Math.max(rate, 0.01) ** 0.21;
}

/** The terminal speed of a drop of a diameter, mm, m/s (Atlas and others 1973, fitting Gunn and Kinzer 1949). */
export function dropSpeed(diameter: number): number {
  return Math.max(9.65 - 10.3 * Math.exp(-0.6 * diameter), 0.5);
}

/** The share of the streaks at the boat that fall in rain of a rate, mm an hour: all of them in heavy rain. */
export function streakShare(rate: number): number {
  return rate <= 0.05 ? 0 : Math.min((rate / 20) ** 0.6, 1);
}

/** A streak quad: across its width (x) and along its length (y, 0 at its head). */
function quad(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('corner', new BufferAttribute(new Float32Array([-1, 0, 1, 0, 1, 1, -1, 1]), 2));
  g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/**
 * A streak's corner in clip space: from its head at p, along a (its
 * length's vector, m), widened across the view by w m.
 */
function streakVertex(p: Node<'vec3'>, a: Node<'vec3'>, w: Node<'float'>): Node<'vec4'> {
  const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
  const toCamera = normalize(cameraPosition.sub(p));
  const side = normalize(cross(a, toCamera)).mul(w.mul(0.5));
  const q = p.add(a.mul(corner.y)).add(side.mul(corner.x));
  return cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(bendScene(q), 1))) as Node<'vec4'>;
}

/** The streaks at the boat: one draw. */
export class Streaks {
  readonly mesh: InstancedMesh;
  /** The box's place in the drops' frame, 0 to 1 each way, and its centre in the scene. */
  readonly phase = uniform(new Vector3());
  readonly centre = uniform(new Vector3());
  /** A streak's length vector, m, in the scene. */
  readonly fall = uniform(new Vector3(0, -0.2, 0));
  /** How many the quality in use draws at most, and how many now. */
  capacity = STREAKS_MOST;
  count = 0;
  /** The rain they fall in, mm an hour. */
  rate = 0;
  #east = 0;
  #north = 0;
  #down = 0;

  constructor() {
    const seeds = new Float32Array(STREAKS_MOST * 3);
    let h = 0x2545f491;
    for (let i = 0; i < seeds.length; i++) {
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39;
      seeds[i] = ((h >>> 8) & 0xffffff) / 16777216;
    }
    const seed = instancedBufferAttribute(
      new InstancedBufferAttribute(seeds, 3),
      'vec3',
    ) as unknown as Node<'vec3'>;
    const box = vec3(RAIN_BOX.across, RAIN_BOX.up, RAIN_BOX.across);
    // The drop's place in the box about the camera, wrapped.
    const p = this.centre.add(fract(seed.add(this.phase)).sub(0.5).mul(box));
    const m = basicMaterial();
    m.name = 'streaks';
    m.transparent = true;
    m.depthWrite = false;
    m.vertexNode = streakVertex(
      p as Node<'vec3'>,
      this.fall as unknown as Node<'vec3'>,
      float(STREAK_WIDTH),
    );
    const corner = varying(attribute('corner', 'vec2') as unknown as Node<'vec2'>);
    // Fading toward its ends, and within a few metres of the eye, where a
    // drop is a blur too quick to see.
    const near = varying(smoothstep(1.5, 5, p.sub(cameraPosition).length()));
    const along = corner.y.mul(float(1).sub(corner.y)).mul(4).mul(near);
    const colour = mix(look.cloudTop, look.skyHorizon, 0.4);
    m.fragmentNode = vec4(toLinear(colour), along.mul(STREAK_ALPHA)) as unknown as Node<'vec4'>;
    this.mesh = new InstancedMesh(quad(), m, STREAKS_MOST);
    this.mesh.name = 'streaks';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * The streaks for a frame: in rain of a rate, mm an hour, about the
   * camera (scene, and the world's east and north), in a wind blowing
   * toward (east, north) at so many m/s, dt seconds after the last.
   */
  frame(
    rate: number,
    camera: Vector3,
    cameraEast: number,
    cameraNorth: number,
    windEast: number,
    windNorth: number,
    dt: number,
  ): void {
    this.rate = rate;
    const n = Math.floor(streakShare(rate) * Math.min(this.capacity, STREAKS_MOST));
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) {
      return;
    }
    const v = dropSpeed(dropDiameter(rate));
    // The drops move with the air and fall; the box stays about the
    // camera, so the drops' frame is their travel less the camera's.
    this.#east = (this.#east + windEast * dt) % 1e6;
    this.#north = (this.#north + windNorth * dt) % 1e6;
    this.#down = (this.#down + v * dt) % 1e6;
    const wrap = (x: number): number => x - Math.floor(x);
    this.phase.value.set(
      wrap((this.#east - cameraEast) / RAIN_BOX.across),
      wrap(-this.#down / RAIN_BOX.up),
      wrap((-this.#north + cameraNorth) / RAIN_BOX.across),
    );
    this.centre.value.copy(camera);
    // Each as long as it falls in a thirtieth of a second, slanted by the wind.
    this.fall.value.set(-windEast / 30, v / 30, windNorth / 30);
  }
}

/** The curtains under the clouds that rain: one draw. */
export class Curtains {
  readonly mesh: InstancedMesh;
  /** The world's time, s, which carries the streaks down; and the anchor from the floating origin. */
  readonly time = uniform(0);
  readonly anchor = uniform(new Vector3());
  count = 0;
  anchorEast = 0;
  anchorNorth = 0;
  readonly #place: InstancedInterleavedBuffer;
  readonly #fall: InstancedInterleavedBuffer;

  constructor() {
    this.#place = new InstancedInterleavedBuffer(new Float32Array(CURTAIN_MOST * 4), 4, 1);
    this.#fall = new InstancedInterleavedBuffer(new Float32Array(CURTAIN_MOST * 4), 4, 1);
    this.#place.setUsage(DynamicDrawUsage);
    this.#fall.setUsage(DynamicDrawUsage);
    const place = instancedDynamicBufferAttribute(
      this.#place,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    const fall = instancedDynamicBufferAttribute(
      this.#fall,
      'vec4',
      4,
      0,
    ) as unknown as Node<'vec4'>;
    // place: x, z from the anchor, the cloud's base, a phase; fall: the
    // drop's speed, its slant east and south over its fall, its length.
    const base = place.z;
    const length = fall.w;
    const drop = fract(place.w.add(this.time.mul(fall.x).div(base)));
    const y = base.sub(drop.mul(base));
    const slant = vec3(fall.y, 0, fall.z).mul(drop);
    const head = vec3(place.x, y, place.y).add(this.anchor).add(slant);
    // Up and back from its head, against the way it falls.
    const along = vec3(
      fall.y.mul(length).div(base).negate(),
      length,
      fall.z.mul(length).div(base).negate(),
    );
    const m = basicMaterial();
    m.name = 'curtains';
    m.transparent = true;
    m.depthWrite = false;
    m.vertexNode = streakVertex(head as Node<'vec3'>, along as Node<'vec3'>, float(CURTAIN_WIDTH));
    const corner = varying(attribute('corner', 'vec2') as unknown as Node<'vec2'>);
    const away = varying(head.sub(cameraPosition).length());
    const ends = corner.y.mul(float(1).sub(corner.y)).mul(4);
    // Grey as the clouds' bases, hazed with distance as they are.
    const colour = mix(
      look.cloudBase,
      look.skyHorizon,
      float(1)
        .sub(exp(away.div(4300).negate()))
        .mul(0.8),
    );
    m.fragmentNode = vec4(toLinear(colour), ends.mul(CURTAIN_ALPHA)) as unknown as Node<'vec4'>;
    this.mesh = new InstancedMesh(quad(), m, CURTAIN_MOST);
    this.mesh.name = 'curtains';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Lays the curtains out again from the module's cloud records, about
   * (east, north), in a wind toward (east, north) m/s: under each cloud
   * that rains, streaks over its rain's footprint, as many as its rate
   * asks, placed from its seed.
   */
  lay(
    clouds: Float64Array,
    cameraEast: number,
    cameraNorth: number,
    windEast: number,
    windNorth: number,
  ): void {
    const C = RECORDS.cloud;
    const place = this.#place.array as Float32Array;
    const fall = this.#fall.array as Float32Array;
    this.anchorEast = cameraEast;
    this.anchorNorth = cameraNorth;
    let n = 0;
    const nc = Math.floor(clouds.length / SIZES.cloud);
    for (let i = 0; i < nc && n < CURTAIN_MOST; i++) {
      const o = i * SIZES.cloud;
      const rate = clouds[o + C.rain] ?? 0;
      const reach = clouds[o + C.rainReach] ?? 0;
      if (rate < 1 || reach <= 0) {
        continue;
      }
      const count = Math.min(
        Math.round(CURTAIN_CLOUD * Math.min(rate / 40, 1) ** 0.7),
        CURTAIN_MOST - n,
      );
      const east = (clouds[o + C.east] ?? 0) - cameraEast;
      const north = (clouds[o + C.north] ?? 0) - cameraNorth;
      const base = Math.max(clouds[o + C.base] ?? 400, 50);
      const v = dropSpeed(dropDiameter(rate));
      // Over its fall the wind carries a drop this far.
      const time = base / v;
      let h = (clouds[o + C.seed] ?? 0) >>> 0;
      const next = (): number => {
        h = (h + 0x9e3779b9) >>> 0;
        let x = h;
        x ^= x >>> 16;
        x = Math.imul(x, 0x7feb352d);
        x ^= x >>> 15;
        x = Math.imul(x, 0x846ca68b);
        x ^= x >>> 16;
        return (x >>> 0) / 4294967296;
      };
      for (let k = 0; k < count; k++, n++) {
        const a = 2 * Math.PI * next();
        const d = reach * Math.sqrt(next());
        place[4 * n] = east + d * Math.cos(a);
        place[4 * n + 1] = -(north + d * Math.sin(a));
        place[4 * n + 2] = base * (0.85 + 0.15 * next());
        place[4 * n + 3] = next();
        fall[4 * n] = v;
        fall[4 * n + 1] = windEast * time;
        fall[4 * n + 2] = -windNorth * time;
        fall[4 * n + 3] = 50 + 80 * next();
      }
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#place.needsUpdate = true;
    this.#fall.needsUpdate = true;
  }

  /** Places the curtains for a frame: the anchor from the floating origin, and world time, s. */
  frame(originEast: number, originNorth: number, seconds: number): void {
    this.anchor.value.set(this.anchorEast - originEast, 0, -(this.anchorNorth - originNorth));
    this.time.value = seconds % 100_000;
  }
}
