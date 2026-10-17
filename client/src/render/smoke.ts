// SPDX-License-Identifier: AGPL-3.0-only

// Chimney smoke: from a share of the towns' chimneys, more by day than by
// night, puffs that show the true wind as the Beaufort scale's land
// specifications read smoke: at force 0 "smoke rises vertically", at force
// 1 its "direction shown by smoke drift but not by wind vanes", and in more
// wind it is bent over and carried away low (Royal Meteorological
// Society). A buoyant plume bent over by a wind u rises Δh = 1.6 F^(1/3)
// x^(2/3) / u at x downwind (Briggs's two-thirds law, Plume Rise, 1969):
// the stronger the wind, the less it rises and the further it leans. Each
// puff is where world time puts it, so every phone shows the same smoke.
//
// The puffs are worked out here and drawn as soft billboards, one
// instanced draw, each a place the dome bends.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedInterleavedBuffer,
  InstancedMesh,
} from 'three';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dot,
  exp,
  instancedDynamicBufferAttribute,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { TownSmoke } from '../catalog/types.gen';
import { basicMaterial, bendScene } from './materials';

/** The puffs drawn at most. */
export const PUFF_CAPACITY = 1024;

/** A chimney that smokes: its pot, m east, north and up; the wind there, m/s and from; its own number. */
export interface Chimney {
  east: number;
  north: number;
  top: number;
  speed: number;
  from: number;
  seed: number;
}

/** A puff's place, m downwind, across and up from its pot, its width, m, and how thick it is still, 0 to 1. */
export interface Puff {
  down: number;
  up: number;
  width: number;
  thick: number;
}

/**
 * Where a puff of age seconds is, from a pot in a wind of speed m/s: rising
 * straight in a calm at the puff's own rise, and in a wind carried at its
 * speed and bent over as Briggs's law has it.
 */
export function puffAt(age: number, speed: number, cat: TownSmoke): Puff {
  const t = Math.min(Math.max(age / cat.life, 0), 1);
  const down = speed * age;
  const calm = cat.rise * age;
  const bent = (cat.buoyancy * down ** (2 / 3)) / Math.max(speed, 0.3);
  // Between a calm and force 1 the plume turns from the one to the other.
  const w = Math.min(Math.max((speed - 0.2) / 0.6, 0), 1);
  const up = calm * (1 - w) + Math.min(bent, calm) * w;
  const [s0, s1] = cat.size as [number, number];
  return { down, up, width: s0 + (s1 - s0) * t, thick: (1 - t) ** 1.5 };
}

/** Whether a chimney of this number smokes, by day or by night. */
export function smokes(seed: number, night: boolean, cat: TownSmoke): boolean {
  const x = Math.sin(seed * 91.17 + 3.1) * 43758.5453;
  return x - Math.floor(x) < (night ? cat.night : cat.day);
}

export class Smoke {
  readonly mesh: InstancedMesh;
  /** Each puff: its scene position and width; its strength and the light on it. */
  readonly place = attr();
  readonly shade = attr();
  /** How much daylight falls on the smoke: dim by night. */
  readonly light = uniform(1);
  count = 0;
  readonly #cat: TownSmoke;

  constructor(cat: TownSmoke) {
    this.#cat = cat;
    const corners = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const g = new BufferGeometry();
    g.setAttribute('corner', new BufferAttribute(corners, 2));
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const place = instancedDynamicBufferAttribute(this.place, 'vec4', 4, 0) as unknown as Node<'vec4'>;
    const shade = instancedDynamicBufferAttribute(this.shade, 'vec4', 4, 0) as unknown as Node<'vec4'>;
    const corner = attribute('corner', 'vec2') as unknown as Node<'vec2'>;
    const m = basicMaterial();
    m.name = 'smoke';
    m.transparent = true;
    m.depthWrite = false;
    const view = cameraViewMatrix.mul(vec4(bendScene(place.xyz), 1));
    m.vertexNode = cameraProjectionMatrix.mul(vec4(view.xy.add(corner.mul(place.w.mul(0.5))), view.z, 1));
    const vCorner = varying(corner);
    const vShade = varying(shade);
    const r2 = dot(vCorner, vCorner);
    const soft = exp(r2.mul(-3)).sub(0.05).max(0);
    m.fragmentNode = vec4(
      vec3(0.78, 0.77, 0.75).mul(this.light).mul(vShade.y),
      soft.mul(vShade.x).mul(0.85),
    ) as unknown as Node<'vec4'>;
    this.mesh = new InstancedMesh(g, m, PUFF_CAPACITY);
    this.mesh.name = 'smoke';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** The chimneys smoking this frame, placed from the floating origin; time is world time, s; light the daylight on them. */
  frame(chimneys: readonly Chimney[], origin: { x: number; y: number }, time: number, light: number): void {
    const c = this.#cat;
    this.light.value = light;
    const place = this.place.array as Float32Array;
    const shade = this.shade.array as Float32Array;
    let n = 0;
    for (const ch of chimneys) {
      // Downwind in the world: east and north.
      const dx = -Math.sin(ch.from);
      const dy = -Math.cos(ch.from);
      for (let k = 0; k < c.puffs && n < PUFF_CAPACITY; k++) {
        // Each puff its own phase of the chimney's cycle: a steady stream.
        const cycle = time / c.life + k / c.puffs + ch.seed * 0.6180339;
        const age = (cycle - Math.floor(cycle)) * c.life;
        const p = puffAt(age, ch.speed, c);
        const i = n * 4;
        place[i] = ch.east + dx * p.down - origin.x;
        place[i + 1] = ch.top + p.up;
        place[i + 2] = -(ch.north + dy * p.down - origin.y);
        place[i + 3] = p.width;
        shade[i] = p.thick;
        shade[i + 1] = 1 - 0.15 * (age / c.life);
        n++;
      }
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.place.needsUpdate = true;
    this.shade.needsUpdate = true;
  }
}

function attr(): InstancedInterleavedBuffer {
  const b = new InstancedInterleavedBuffer(new Float32Array(PUFF_CAPACITY * 4), 4, 1);
  b.setUsage(DynamicDrawUsage);
  return b;
}
