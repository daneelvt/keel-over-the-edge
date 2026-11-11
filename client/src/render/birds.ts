// SPDX-License-Identifier: AGPL-3.0-only

// Every bird in the picture, one draw: a colony's wheeling over its
// island, the sea's life met on the water, the gulls over a town. Each is
// a body and two wings of two panels each, eight triangles, flapped in
// the vertex stage at its kind's wingbeat, gliding a share of the time;
// its place, heading, pitch and bank are written on the CPU each frame by
// whoever draws it, between begin and end. The scene owns it, so the birds
// at sea are drawn where no land is.

import {
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
} from 'three';
import {
  attribute,
  cos,
  Fn,
  float,
  fract,
  positionLocal,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { BirdLook } from '../catalog/types.gen';
import type { BirdSink } from '../life/draw';
import { headingToRotationY } from './coords';
import { basicMaterial } from './materials';

/** The birds drawn at most in a frame. */
export const BIRDS = 1024;
/** Floats a bird: at (x, y, z, turn), fly (flap Hz, glide share, phase, span), body (rgb, pitch), wing (rgb, tip's grey), pose (bank, ·, ·, ·). */
const STRIDE = 20;

/** A kind's look as the draw takes it: its wingbeat, glide share and span, and its colours in linear values. */
export interface BirdPaint {
  flap: number;
  glide: number;
  span: number;
  body: readonly [number, number, number];
  wing: readonly [number, number, number];
  tip: number;
}

/** A colour #rrggbb as linear values. */
export function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

const paints = new WeakMap<BirdLook, BirdPaint>();

/** A look's paint, made once for each look. */
export function paintOf(look: BirdLook): BirdPaint {
  let p = paints.get(look);
  if (p === undefined) {
    p = {
      flap: look.flap,
      glide: look.glide,
      span: look.span,
      body: hexRgb(look.body),
      wing: hexRgb(look.wing),
      tip: hexRgb(look.tip)[0],
    };
    paints.set(look, p);
  }
  return p;
}

/** What the tests and the panel read: the birds drawn this frame, and the draws (0 or 1). */
export interface BirdsStats {
  birds: number;
  draws: number;
}

export class Birds implements BirdSink {
  readonly mesh: InstancedMesh;
  /** World time, s, within the hour: the wings' beat. */
  readonly time = uniform(0);
  /** The daylight on them, 0 to 1. */
  readonly light = uniform(1);
  readonly stats: BirdsStats = { birds: 0, draws: 0 };

  readonly #data: InstancedInterleavedBuffer;
  readonly #array: Float32Array;
  #count = 0;
  #ox = 0;
  #oy = 0;

  constructor() {
    [this.mesh, this.#data] = this.#make();
    this.#array = this.#data.array as Float32Array;
  }

  /** The birds written so far this frame. */
  get count(): number {
    return this.#count;
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
   * A bird of a look at m east, north and up, heading radians clockwise
   * from north, its own phase 0 to 1 in its wingbeat and glides, its size
   * a share of its span (the far ones shrink to nothing), its pitch nose
   * down and bank right wing down, radians; held, its wings are held
   * still, as a bird's in a plunge or soaring. False once the draw is full.
   */
  add(
    look: BirdLook,
    east: number,
    north: number,
    up: number,
    heading: number,
    phase: number,
    size = 1,
    pitch = 0,
    bank = 0,
    held = false,
  ): boolean {
    if (this.#count >= BIRDS) {
      return false;
    }
    const paint = paintOf(look);
    const d = this.#array;
    const o = this.#count * STRIDE;
    d[o] = east - this.#ox;
    d[o + 1] = up;
    d[o + 2] = -(north - this.#oy);
    d[o + 3] = headingToRotationY(heading);
    d[o + 4] = paint.flap;
    d[o + 5] = held ? 1 : paint.glide;
    d[o + 6] = phase;
    d[o + 7] = paint.span * size;
    d[o + 8] = paint.body[0];
    d[o + 9] = paint.body[1];
    d[o + 10] = paint.body[2];
    d[o + 11] = pitch;
    d[o + 12] = paint.wing[0];
    d[o + 13] = paint.wing[1];
    d[o + 14] = paint.wing[2];
    d[o + 15] = paint.tip;
    d[o + 16] = bank;
    this.#count++;
    return true;
  }

  /** Ends the frame: what was written is drawn. */
  end(): void {
    const n = this.#count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#data.needsUpdate = true;
    this.stats.birds = n;
    this.stats.draws = n > 0 ? 1 : 0;
  }

  /** The written bird i's place in the scene and its parts, as the draw holds it (the tests). */
  written(i: number): Float32Array {
    return this.#array.subarray(i * STRIDE, (i + 1) * STRIDE);
  }

  /** The birds: a body and two wings of two panels each, flapping on the GPU. */
  #make(): [InstancedMesh, InstancedInterleavedBuffer] {
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
    const data = new InstancedInterleavedBuffer(new Float32Array(BIRDS * STRIDE), STRIDE, 1);
    data.setUsage(DynamicDrawUsage);
    ['birdAt', 'birdFly', 'birdBody', 'birdWing', 'birdPose'].forEach((name, k) => {
      g.setAttribute(name, new InterleavedBufferAttribute(data, 4, k * 4));
    });
    const at = attribute('birdAt', 'vec4') as unknown as Node<'vec4'>;
    const fly = attribute('birdFly', 'vec4') as unknown as Node<'vec4'>;
    const body = attribute('birdBody', 'vec4') as unknown as Node<'vec4'>;
    const wing = attribute('birdWing', 'vec4') as unknown as Node<'vec4'>;
    const pose = attribute('birdPose', 'vec4') as unknown as Node<'vec4'>;
    const tag = attribute('uv', 'vec2') as unknown as Node<'vec2'>;
    const vertex = Fn(() => {
      const p = positionLocal.mul(fly.w).toVar();
      // In a steep dive the wings fold back along the body, as a booby's
      // and a pelican's do before they strike the water.
      const fold = float(1).sub(smoothstep(0.7, 1.3, body.w).mul(0.65));
      p.x.assign(select(tag.y.greaterThan(0.5), p.x.mul(fold), p.x));
      const cycle = fract(this.time.mul(0.12).add(fly.z));
      const flapping = select(cycle.greaterThan(fly.y), float(1), float(0.08));
      const beat = sin(
        this.time
          .mul(fly.x)
          .mul(2 * Math.PI)
          .add(fly.z.mul(40)),
      );
      p.y.addAssign(beat.mul(tag.x).mul(fly.w).mul(0.35).mul(flapping));
      // Banked about its length, the right wing down for a positive bank;
      // then pitched about its wings, the bill down for a positive pitch;
      // then turned to its heading.
      const cb = cos(pose.x);
      const sb = sin(pose.x);
      const banked = vec3(p.x.mul(cb).add(p.y.mul(sb)), p.y.mul(cb).sub(p.x.mul(sb)), p.z);
      const cp = cos(body.w);
      const sp = sin(body.w);
      const pitched = vec3(
        banked.x,
        banked.y.mul(cp).add(banked.z.mul(sp)),
        banked.z.mul(cp).sub(banked.y.mul(sp)),
      );
      const c = cos(at.w);
      const s = sin(at.w);
      return vec3(
        pitched.x.mul(c).add(pitched.z.mul(s)),
        pitched.y,
        pitched.z.mul(c).sub(pitched.x.mul(s)),
      ).add(at.xyz);
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
    mesh.visible = false;
    mesh.frustumCulled = false;
    return [mesh, data];
  }
}
