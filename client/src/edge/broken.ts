// SPDX-License-Identifier: AGPL-3.0-only

// The sea broken away at the world's end (taken.ts): beyond a radius about
// the boat that shrinks to nothing at the end, the sea's tiles are not
// drawn, as a tile over land is not; the slabs breaking off show it go.

import { Vector2 } from 'three';
import { length, uniform, vec2 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { edgeLook } from './mist';

/** The end's uniforms the sea's tiles read: whether the sea breaks away, about where, and how far it still stands. */
export const endLook = {
  on: uniform(0),
  /** The boat, m east and north of the disk's centre. */
  centre: uniform(new Vector2()),
  cut: uniform(1e9),
};

/** Whether a tile centred at c, in the scene's (x, z), has broken away. */
export const brokenOff = (c: Node<'vec2'>): Node<'bool'> =>
  length(vec2(c.x.add(edgeLook.origin.x), c.y.negate().add(edgeLook.origin.y)).sub(endLook.centre))
    .greaterThan(endLook.cut)
    .and(endLook.on.greaterThan(0.5));
