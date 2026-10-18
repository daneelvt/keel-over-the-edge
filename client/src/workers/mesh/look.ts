// SPDX-License-Identifier: AGPL-3.0-only

// The land's look as the mesh worker builds it, from the catalog's world:
// the terraces, the shore, and each surface's colours as sRGB bytes.

import type { World } from '../../catalog/types.gen';
import { GROUND } from '../../predict/layout.gen';
import type { LandLook } from './build';
import { CLUMP_CELL, type FloraLook } from './plants';

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
  // Read by its part in a town, never its name.
  const deck = world.surfaces.findIndex((s) => s.town === 'deck');
  return {
    terrace: world.look.terrace,
    shore: world.look.shore,
    top,
    side,
    deck,
    flora: floraLook(world),
  };
}

/** The forms of plant that grow as clumps, placed a clump's cell apart at least. */
const CLUMPS = ['shrub', 'tuft', 'krummholz'];

/** The catalog's flora as the worker places it: plants and covers by their indices. */
export function floraLook(world: World): FloraLook {
  const kinds = world.flora.kinds;
  const index = new Map(kinds.map((k, i) => [k.id, i]));
  return {
    plants: kinds.map((k) => ({
      height: [k.height[0] ?? 1, k.height[1] ?? 1],
      crown: [k.crown[0] ?? 1, k.crown[1] ?? 1],
      cell: CLUMPS.includes(k.form) ? CLUMP_CELL : 0,
    })),
    cover: world.surfaces.map((s) =>
      (s.cover ?? []).flatMap((c) => {
        const plant = index.get(c.plant);
        if (plant === undefined) {
          return [];
        }
        return [
          {
            plant,
            share: c.share,
            height: [c.height?.[0] ?? -1, c.height?.[1] ?? 1e9],
            shore: [c.shore?.[0] ?? 0, c.shore?.[1] ?? 1e9],
            slope: c.slope ?? 90,
            hollow: c.hollow ?? false,
          },
        ];
      }),
    ),
    garden: world.towns.kits.map((k) =>
      k.garden === undefined ? -1 : (index.get(k.garden) ?? -1),
    ),
  };
}
