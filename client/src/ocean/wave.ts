// SPDX-License-Identifier: AGPL-3.0-only

// The boat band on the GPU: the same sum as BoatBand.sample in phases.ts,
// from the phases at the floating origin, and the sea's plane at a point
// with the dome's drop and slope added.

import { cos, dot, Fn, float, Loop, sin, uniformArray, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { DOME_RADIUS, domeCentre } from '../render/materials';
import { type BoatBand, COMPONENTS } from './phases';

export interface BandUniforms {
  waves: ReturnType<typeof uniformArray>;
  phases: ReturnType<typeof uniformArray>;
}

/** Uniforms reading the band's arrays: the values are updated in place each frame. */
export function bandUniforms(band: BoatBand): BandUniforms {
  return {
    waves: uniformArray(band.waves, 'vec4'),
    phases: uniformArray(band.phases, 'vec4'),
  };
}

const LANES = ['x', 'y', 'z', 'w'] as const;

/**
 * The boat band's height and slope at the scene point p (x, z relative to
 * the origin): vec3(h, ∂h/∂x, ∂h/∂z).
 */
export function boatBandAt(u: BandUniforms): (p: Node<'vec2'>) => Node<'vec3'> {
  const fn = Fn(([p]: [Node<'vec2'>]) => {
    const h = float(0).toVar();
    const g = vec2(0).toVar();
    Loop(COMPONENTS / 4, ({ i }: { i: Node<'int'> }) => {
      const ph = u.phases.element(i) as unknown as Node<'vec4'>;
      for (let j = 0; j < 4; j++) {
        const w = u.waves.element(i.mul(4).add(j)) as unknown as Node<'vec4'>;
        const a = ph[LANES[j] as 'x'].add(w.z.mul(dot(w.xy, p)));
        h.addAssign(w.w.mul(sin(a)));
        g.addAssign(w.xy.mul(w.w.mul(w.z).mul(cos(a))));
      }
    });
    return vec3(h, g);
  });
  return (p) => fn(p) as unknown as Node<'vec3'>;
}

const INV_2R = 1 / (2 * DOME_RADIUS);
const INV_R = 1 / DOME_RADIUS;

/**
 * The sea's plane at the scene point c: vec4(H, ∂H/∂x, ∂H/∂z, h), where H is
 * the boat band's height less the dome's drop and h the band's height alone.
 */
export function seaPlaneAt(u: BandUniforms): (c: Node<'vec2'>) => Node<'vec4'> {
  const band = boatBandAt(u);
  const fn = Fn(([c]: [Node<'vec2'>]) => {
    const b = band(c);
    const d = c.sub(domeCentre);
    return vec4(b.x.sub(dot(d, d).mul(INV_2R)), b.yz.sub(d.mul(INV_R)), b.x);
  });
  return (c) => fn(c) as unknown as Node<'vec4'>;
}
