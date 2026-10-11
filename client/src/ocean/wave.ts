// SPDX-License-Identifier: AGPL-3.0-only

// The boat band on the GPU: the sum the physics module makes for the boats,
// from the phases at the floating origin, and the sea's plane at a point
// with the dome's drop and slope added.
//
// Three things keep it the module's sum. Each wave's amplitude is blended
// between the four sea areas about the point, with the weights the module
// uses, so the sea is one surface across the areas. Only the waves with an
// amplitude in the window are summed, as the module skips the rest. And the
// sine's argument is brought into [−π, π] here before the sine is taken: a
// tile 650 m from the floating origin has k d·(p − O) up to 510 rad for the
// shortest wave, and WGSL promises its sine and cosine only within 2⁻¹¹ and
// only on [−π, π] (WebGPU Shading Language, 15.7.4, Numeric built-in
// functions).

import {
  clamp,
  cos,
  dot,
  Fn,
  float,
  floor,
  If,
  int,
  ivec2,
  Loop,
  mix,
  sin,
  textureLoad,
  uniform,
  uniformArray,
  vec2,
  vec4,
} from 'three/tsl';
import type { Node, UniformNode } from 'three/webgpu';
import { SEA } from '../predict/layout.gen';
import { DOME_RADIUS, domeCentre } from '../render/materials';
import type { SeaBand } from './phases';

export interface BandUniforms {
  readonly band: SeaBand;
  readonly phases: ReturnType<typeof uniformArray>;
  readonly hs: ReturnType<typeof uniformArray>;
  /** The fours of waves to sum. */
  readonly groups: UniformNode<'float', number>;
  /** Areas a side of the window, and whether its areas differ. */
  readonly size: UniformNode<'float', number>;
  readonly blended: UniformNode<'float', number>;
  readonly areaOrigin: Node<'vec2'>;
  /** Brings the uniforms to the band as it is now; the arrays follow by themselves. */
  sync(): void;
}

/** Uniforms reading the band: its arrays are updated in place each frame. */
export function bandUniforms(band: SeaBand): BandUniforms {
  const groups = uniform(0);
  const size = uniform(SEA.window as number);
  const blended = uniform(0);
  return {
    band,
    phases: uniformArray(band.phases, 'vec4'),
    hs: uniformArray(band.hs, 'float'),
    groups,
    size,
    blended,
    areaOrigin: uniform(band.areaOrigin) as unknown as Node<'vec2'>,
    sync: () => {
      groups.value = band.groups;
      size.value = band.size;
      blended.value = band.blended ? 1 : 0;
    },
  };
}

const LANES = ['x', 'y', 'z', 'w'] as const;
const INV_AREA = 1 / SEA.areaSize;
const TWO_PI = 2 * Math.PI;

/** The four areas about a point, as rows of the amplitudes, and the weights of the eastern and northern pairs. */
interface Corners {
  sw: Node<'int'>;
  se: Node<'int'>;
  nw: Node<'int'>;
  ne: Node<'int'>;
  w: Node<'vec2'>;
}

/**
 * The areas whose centres surround the scene point p, clamped to the
 * window, and how far p is between them: the fraction of the way, smoothed
 * so that the blend's slope is continuous across every line of centres.
 */
function cornersAt(u: BandUniforms, p: Node<'vec2'>): Corners {
  const at = u.areaOrigin.add(vec2(p.x, p.y.negate()).mul(INV_AREA));
  const c = floor(at).toVar();
  const t = at.sub(c);
  const last = u.size.sub(1);
  const c0 = clamp(c, 0, last).toVar();
  const c1 = clamp(c.add(1), 0, last).toVar();
  return {
    sw: int(c0.y.mul(u.size).add(c0.x)).toVar(),
    se: int(c0.y.mul(u.size).add(c1.x)).toVar(),
    nw: int(c1.y.mul(u.size).add(c0.x)).toVar(),
    ne: int(c1.y.mul(u.size).add(c1.x)).toVar(),
    w: t
      .mul(t)
      .mul(float(3).sub(t.mul(2)))
      .toVar(),
  };
}

/** A value of each area, blended between the four about a point. */
function blend(c: Corners, of: (area: Node<'int'>) => Node<'float'>): Node<'float'> {
  return mix(mix(of(c.sw), of(c.se), c.w.x), mix(of(c.nw), of(c.ne), c.w.x), c.w.y);
}

/**
 * The boat band at the scene point p (x, z relative to the origin):
 * vec4(h, ∂h/∂x, ∂h/∂z, Hs), the waves' height and slope and the significant
 * height of the sea there.
 */
export function boatBandAt(u: BandUniforms): (p: Node<'vec2'>) => Node<'vec4'> {
  const waves = u.band.waves;
  const amplitudes = u.band.amplitudes;
  const fn = Fn(([p]: [Node<'vec2'>]) => {
    const h = float(0).toVar();
    const g = vec2(0).toVar();
    const c = cornersAt(u, p);
    Loop(int(u.groups), ({ i }: { i: Node<'int'> }) => {
      const ph = u.phases.element(i) as unknown as Node<'vec4'>;
      for (let j = 0; j < 4; j++) {
        const n = i.mul(4).add(j);
        // Direction, wavenumber, and the amplitude where the sea is one.
        const w = textureLoad(waves, ivec2(n, 0));
        const a = float(w.w).toVar();
        If(u.blended.greaterThan(0.5), () => {
          a.assign(blend(c, (area) => textureLoad(amplitudes, ivec2(n, area)).x));
        });
        const whole = ph[LANES[j] as 'x'].add(w.z.mul(dot(w.xy, p)));
        const arg = whole.sub(floor(whole.mul(1 / TWO_PI).add(0.5)).mul(TWO_PI));
        h.addAssign(a.mul(sin(arg)));
        g.addAssign(w.xy.mul(a.mul(w.z).mul(cos(arg))));
      }
    });
    const hs = blend(c, (area) => u.hs.element(area) as unknown as Node<'float'>);
    return vec4(h, g, hs);
  });
  return (p) => fn(p) as unknown as Node<'vec4'>;
}

/** The significant height of the sea at the scene point p, without the waves. */
export function seaHeightAt(u: BandUniforms): (p: Node<'vec2'>) => Node<'float'> {
  const fn = Fn(([p]: [Node<'vec2'>]) =>
    blend(cornersAt(u, p), (area) => u.hs.element(area) as unknown as Node<'float'>),
  );
  return (p) => fn(p) as unknown as Node<'float'>;
}

const INV_2R = 1 / (2 * DOME_RADIUS);
const INV_R = 1 / DOME_RADIUS;

/**
 * The sea's plane at the scene point c, from the band there: vec4(H, ∂H/∂x,
 * ∂H/∂z, h), where H is the boat band's height less the dome's drop and h the
 * band's height alone.
 */
export function seaPlaneOf(band: Node<'vec4'>, c: Node<'vec2'>): Node<'vec4'> {
  const d = c.sub(domeCentre);
  return vec4(band.x.sub(dot(d, d).mul(INV_2R)), band.yz.sub(d.mul(INV_R)), band.x);
}

/** The sea's plane at the scene point c. */
export function seaPlaneAt(u: BandUniforms): (c: Node<'vec2'>) => Node<'vec4'> {
  const band = boatBandAt(u);
  const fn = Fn(([c]: [Node<'vec2'>]) => seaPlaneOf(band(c), c));
  return (c) => fn(c) as unknown as Node<'vec4'>;
}
