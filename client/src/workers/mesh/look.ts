// SPDX-License-Identifier: AGPL-3.0-only

// The land's look as the mesh worker builds it, from the catalog's world:
// the terraces, the shore, and each surface's colours as sRGB bytes.

import type { World } from '../../catalog/types.gen';
import { GROUND } from '../../predict/layout.gen';
import type { LandLook } from './build';

/** A colour written #rrggbb, as its three bytes. */
export function colourBytes(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The catalog's world as the mesh worker draws its land. */
export function landLook(world: World): LandLook {
  const top = new Uint8Array(GROUND.surfaces * 3);
  const side = new Uint8Array(GROUND.surfaces * 3);
  world.surfaces.forEach((s, i) => {
    if (i < GROUND.surfaces) {
      top.set(colourBytes(s.look.top), i * 3);
      side.set(colourBytes(s.look.side), i * 3);
    }
  });
  return { terrace: world.look.terrace, shore: world.look.shore, top, side };
}
