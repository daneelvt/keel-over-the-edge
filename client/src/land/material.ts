// SPDX-License-Identifier: AGPL-3.0-only

// The land's look, in the tile style of the sea: each column's top in its
// surface's colour with the tiles' dark seam and faint lit bevel at its
// edges, its sides darker toward the foot. Lit by the hour's light, with
// the dome's bend and the haze every solid thing has, and no textures to
// download. The seam and bevel are found in the fragment from the column's
// own coordinates: the chunk's are laid from a hexagon's centre, so the
// hexagon a point lies in is found by rounding, as the lattice is drawn.

import {
  abs,
  attribute,
  cameraPosition,
  float,
  length,
  max,
  mix,
  positionLocal,
  positionWorld,
  round,
  select,
  smoothstep,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import type { MeshStandardNodeMaterial, Node } from 'three/webgpu';
import { litMaterial } from '../render/materials';
import { toLinear } from '../render/sky';

/** The look's starting values, as the sea's tiles have them. */
export const LAND_LOOK = {
  /** Seam: darkening by this much over this span of the distance from a top's centre to its edge. */
  seam: [0.92, 0.99, 0.35],
  /** Bevel: a faint lit band over this span, and its strength. */
  bevel: [0.84, 0.91, 0.95, 0.12],
  /** Seams and bevels fade out between these distances, m. */
  fade: [80, 320],
};

const HEX_STEP = 1.5 * (4 / Math.sqrt(3));
const APOTHEM = 2;

/** How far a point of a column's top is from its centre toward its nearest edge: 1 on the edge. */
function rimOf(local: Node<'vec2'>): Node<'float'> {
  // Axial coordinates from the chunk's origin hexagon, x east and z south.
  const qf = local.x.mul(1 / HEX_STEP);
  const rf = local.y.negate().mul(0.25).sub(qf.mul(0.5));
  const sf = qf.add(rf).negate();
  const q = round(qf);
  const r = round(rf);
  const s = round(sf);
  const dq = abs(q.sub(qf));
  const dr = abs(r.sub(rf));
  const ds = abs(s.sub(sf));
  const qq = select(dq.greaterThan(dr).and(dq.greaterThan(ds)), r.add(s).negate(), q);
  const rr = select(
    dq.greaterThan(dr).and(dq.greaterThan(ds)),
    r,
    select(dr.greaterThan(ds), qq.add(s).negate(), r),
  );
  const centre = vec2(qq.mul(HEX_STEP), rr.add(qq.mul(0.5)).mul(-4));
  const e = abs(local.sub(centre));
  // Corners point east and west.
  return max(e.y, e.x.mul(Math.sqrt(3) / 2).add(e.y.mul(0.5))).div(
    APOTHEM,
  ) as unknown as Node<'float'>;
}

/** The land's material: one for every chunk. */
export function landMaterial(): MeshStandardNodeMaterial {
  const m = litMaterial({ roughness: 0.92, metalness: 0, flatShading: true });
  m.name = 'land';
  const colour = attribute<'vec4'>('colour', 'vec4');
  const local = varying(positionLocal.xz);
  const top = colour.w.greaterThan(0.5);
  const rim = rimOf(local);
  const dist = length(cameraPosition.sub(positionWorld));
  const near = float(1).sub(
    smoothstep(LAND_LOOK.fade[0] as number, LAND_LOOK.fade[1] as number, dist),
  );
  const [s0, s1, sk] = LAND_LOOK.seam as [number, number, number];
  const [b0, b1, b2, bk] = LAND_LOOK.bevel as [number, number, number, number];
  const seam = float(1).sub(smoothstep(s0, s1, rim).mul(sk).mul(near));
  const bevel = smoothstep(b0, b1, rim)
    .mul(float(1).sub(smoothstep(b1, b2, rim)))
    .mul(bk)
    .mul(near);
  const display = colour.xyz;
  const styled = select(top, mix(display.mul(seam), display.add(0.5).min(1), bevel), display);
  m.colorNode = vec4(toLinear(styled), 1) as unknown as Node<'vec4'>;
  return m;
}
