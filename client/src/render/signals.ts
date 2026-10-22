// SPDX-License-Identifier: AGPL-3.0-only

// The storm signal: while a gale warning is in force, a black cone hangs
// from the flagstaff of every harbourmaster's house, as FitzRoy's signals
// were hoisted (The Weather Book, 1863): "A cone, with the point upwards,
// shows that a gale is probable; at first from the northward … point
// downwards … from the southward", the north's from west-north-west round
// by the north to east-south-east; "a canvas Cone, which has the appearance
// of a black triangle" (The London Gazette, 1895), "in view of seafaring
// persons". All of them are one instanced draw, bent with the dome as the
// flags are; by night the cone is seen in the lanterns' light alone.

import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
} from 'three';
import { attribute, positionLocal, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { STAFF } from './flags';
import { litMaterial } from './materials';

/** The cones drawn at most. */
export const CONE_CAPACITY = 16;
/** A cone's height and its base's radius, m; how far below the staff's top it hangs, m. */
const HEIGHT = 1.6;
const RADIUS = 0.8;
const BELOW = 1.2;

/**
 * Whether a gale first blowing from a direction, rad clockwise from north,
 * hoists the cone point up: from west-north-west by the north to
 * east-south-east.
 */
export function pointUp(from: number): boolean {
  const d = ((((from * 180) / Math.PI) % 360) + 360) % 360;
  return d >= 292.5 || d <= 112.5;
}

/** A cone, its apex up, about its middle: a ring of sides and its base. */
function coneGeometry(): BufferGeometry {
  const sides = 12;
  const pos: number[] = [];
  const top = [0, HEIGHT / 2, 0];
  const bottom = -HEIGHT / 2;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * 2 * Math.PI;
    const a1 = ((i + 1) / sides) * 2 * Math.PI;
    const p0 = [RADIUS * Math.sin(a0), bottom, RADIUS * Math.cos(a0)];
    const p1 = [RADIUS * Math.sin(a1), bottom, RADIUS * Math.cos(a1)];
    pos.push(...top, ...p0, ...p1);
    pos.push(0, bottom, 0, ...p1, ...p0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A harbourmaster's flagstaff: its building's top, m east, north and up. */
export interface Staff {
  east: number;
  north: number;
  top: number;
}

export class StormCones {
  readonly mesh: InstancedMesh;
  count = 0;
  readonly #buffer: InstancedInterleavedBuffer;

  constructor() {
    const g = coneGeometry();
    this.#buffer = new InstancedInterleavedBuffer(new Float32Array(CONE_CAPACITY * 4), 4, 1);
    this.#buffer.setUsage(DynamicDrawUsage);
    g.setAttribute('coneAt', new InterleavedBufferAttribute(this.#buffer, 4, 0));
    const at = attribute('coneAt', 'vec4') as unknown as Node<'vec4'>;
    // Point up or down: the cone's own height turned over by the sign.
    const local = at.xyz.add(vec3(positionLocal.x, positionLocal.y.mul(at.w), positionLocal.z));
    const m = litMaterial(
      { color: 0x111111, roughness: 0.9, metalness: 0 },
      local as unknown as Node<'vec3'>,
    );
    m.name = 'storm cone';
    this.mesh = new InstancedMesh(g, m, CONE_CAPACITY);
    this.mesh.name = 'storm cones';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * The cones this frame, from the floating origin: one on each staff while
   * a gale warning is in force, point up or down; none without one.
   */
  frame(staffs: readonly Staff[], origin: { x: number; y: number }, up: boolean | null): void {
    const a = this.#buffer.array as Float32Array;
    let n = 0;
    if (up !== null) {
      for (const s of staffs) {
        if (n >= CONE_CAPACITY) {
          break;
        }
        const o = n * 4;
        a[o] = s.east - origin.x + 0.6;
        a[o + 1] = s.top + STAFF - BELOW - HEIGHT / 2;
        a[o + 2] = -(s.north - origin.y);
        a[o + 3] = up ? 1 : -1;
        n++;
      }
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.#buffer.needsUpdate = true;
  }
}
