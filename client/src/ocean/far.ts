// SPDX-License-Identifier: AGPL-3.0-only

// The far sea: a continuous surface without seams from just inside the tile
// field's edge out past the horizon, so the sea meets the sky. A polar grid
// centred on the centre tile, its rings closer near the inside; the outer
// radius follows the camera's height. It sits a little below the tiles so
// the two never fight where they overlap, and carries the same boat band
// and dome as the tiles, evaluated per vertex.

import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import { cos, positionGeometry, sin, uniform, varying, vec2, vec3 } from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { horizonDistance } from '../render/materials';
import { FIELD_RADIUS } from './hex';
import { type BandUniforms, seaPlaneAt } from './wave';

export const FAR_RINGS = 60;
export const FAR_SPOKES = 200;
/** The far sea starts this far inside the tile field's edge. */
export const FAR_OVERLAP = 10;
/** And this far below the tiles, in metres. */
export const FAR_DROP = 0.05;
/** It reaches at least this far, in metres. */
export const FAR_MIN = 400;

/** The far sea's outer radius for a camera h metres above the sea. */
export function farRadius(h: number): number {
  return Math.max(FAR_MIN, 1.1 * horizonDistance(h));
}

/**
 * The grid: each vertex holds (u, angle), u from 0 at the inner ring to 1
 * at the outer. Rings are spaced by u², closer near the inside.
 */
export function farGeometry(): BufferGeometry {
  const pos = new Float32Array(FAR_RINGS * FAR_SPOKES * 3);
  for (let i = 0; i < FAR_RINGS; i++) {
    for (let j = 0; j < FAR_SPOKES; j++) {
      const k = (i * FAR_SPOKES + j) * 3;
      pos[k] = i / (FAR_RINGS - 1);
      pos[k + 1] = (j / FAR_SPOKES) * 2 * Math.PI;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < FAR_RINGS - 1; i++) {
    for (let j = 0; j < FAR_SPOKES; j++) {
      const a = i * FAR_SPOKES + j;
      const b = i * FAR_SPOKES + ((j + 1) % FAR_SPOKES);
      const c = a + FAR_SPOKES;
      const d = b + FAR_SPOKES;
      // Counter-clockwise seen from above: the angle runs from +x toward -z.
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

export class FarSea {
  readonly mesh: Mesh;
  readonly outer: UniformNode<'float', number>;
  readonly position: Node<'vec3'>;
  readonly plane: Node<'vec4'>;

  /** centre is the centre tile's scene position, shared with the tiles. */
  constructor(band: BandUniforms, centre: Node<'vec2'>) {
    this.outer = uniform(FAR_MIN);
    const inner = FIELD_RADIUS - FAR_OVERLAP;
    const u = positionGeometry.x;
    const angle = positionGeometry.y;
    const r = this.outer.sub(inner).mul(u.mul(u)).add(inner);
    // The angle runs from east toward north: scene (cos, -sin).
    const p = centre.add(vec2(cos(angle), sin(angle).negate()).mul(r));
    const plane = seaPlaneAt(band)(p);
    this.position = vec3(p.x, plane.x.sub(FAR_DROP), p.y);
    this.plane = varying(plane);
    this.mesh = new Mesh(farGeometry());
    this.mesh.name = 'far sea';
    this.mesh.frustumCulled = false;
  }
}
