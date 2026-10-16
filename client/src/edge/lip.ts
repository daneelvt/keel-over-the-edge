// SPDX-License-Identifier: AGPL-3.0-only

// The sea at the lip. The sea's lattice stays fixed in the world: a tile
// whose centre is at or beyond the lip is not drawn, as a tile over land
// is not; the tiles within a tile's width of it sag and tip outward over
// the brink, more the nearer they lie; and the far sea is cut at the lip.
// Beyond it the water pours over as the falls (falls.ts).

import { clamp, Discard, If, length, max, tan, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { TILE_ACROSS } from '../ocean/hex';
import { centreDistance, edgeLook } from './mist';

/** A tile's centre in the scene, (x, z), as metres east and north of the disk's centre. */
const worldOf = (c: Node<'vec2'>): Node<'vec2'> =>
  vec2(c.x.add(edgeLook.origin.x), c.y.negate().add(edgeLook.origin.y));

/** Whether a tile centred at c, in the scene's (x, z), lies at or beyond the lip. */
export const beyondLip = (c: Node<'vec2'>): Node<'bool'> =>
  length(worldOf(c)).greaterThanEqual(edgeLook.lip).and(edgeLook.on.greaterThan(0.5));

/**
 * How far over the brink a tile centred at c leans: 0 a tile's width or
 * more inside the lip, 1 at it.
 */
export const atLip = (c: Node<'vec2'>): Node<'float'> =>
  clamp(length(worldOf(c)).sub(edgeLook.lip.sub(TILE_ACROSS)).div(TILE_ACROSS), 0, 1).mul(
    edgeLook.on,
  );

/**
 * A tile's plane (H, ∂H/∂x, ∂H/∂z, h) at the lip: dropped by the sag and
 * tipped outward by the tip, as far as the tile leans.
 */
export const lipPlane = (c: Node<'vec2'>, plane: Node<'vec4'>): Node<'vec4'> => {
  const w = worldOf(c);
  const r = max(length(w), 1);
  // Outward, in the scene's (x, z): east, and south as −north.
  const out = vec2(w.x, w.y.negate()).div(r);
  const lean = atLip(c);
  const slope = tan(edgeLook.tip.mul(lean));
  return vec4(plane.x.sub(edgeLook.sag.mul(lean)), plane.yz.sub(out.mul(slope)), plane.w);
};

/** Cuts a fragment of the far sea at or beyond the lip. */
export const cutAtLip = (p: Node<'vec3'>): void => {
  If(centreDistance(p).greaterThanEqual(edgeLook.lip).and(edgeLook.on.greaterThan(0.5)), () => {
    Discard();
  });
};
