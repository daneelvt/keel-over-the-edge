// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { catalog } from '../../catalog';
import { GROUND } from '../../predict/layout.gen';
import { cellHex, chunkCorner, hexCentre } from './build';
import type { ChunkTown } from './chunk';
import { floraLook } from './look';
import { PLANT_STRIDE, placePlants } from './plants';

const world = catalog.world;
const flora = floraLook(world);
const n = 7 * GROUND.chunkSide + 8;
const [c0, j0] = chunkCorner(n);

/** A chunk whose every hexagon within r of (east, north) is land of the surface given, 6 m up. */
function island(
  surface: number,
  east: number,
  north: number,
  r: number,
): { e: Int16Array; s: Uint8Array } {
  const e = new Int16Array(GROUND.chunkHexes).fill(-30);
  const s = new Uint8Array(GROUND.chunkHexes);
  for (let i = 0; i < e.length; i++) {
    const [q, rr] = cellHex(c0 + Math.floor(i / GROUND.chunkRows), j0 + (i % GROUND.chunkRows));
    const [x, y] = hexCentre(q, rr);
    if (Math.hypot(x - east, y - north) < r) {
      e[i] = 60;
      s[i] = surface;
    }
  }
  return { e, s };
}

/** The chunk's middle, m east and north. */
const [mx, my] = hexCentre(...cellHex(c0 + GROUND.chunkColumns / 2, j0 + GROUND.chunkRows / 2));

/** The index of the first surface whose cover holds a tree's, read by its canopy. */
const wood = world.surfaces.findIndex((s) => s.canopy >= 10);

describe('the plants', () => {
  test('are placed the same every time, only on the ground that grows them', () => {
    const { e, s } = island(wood, mx, my, 200);
    const a = placePlants(n, e, s, null, flora, world.look.terrace);
    const b = placePlants(n, e, s, null, flora, world.look.terrace);
    expect(a.length).toBeGreaterThan(0);
    expect(Array.from(a)).toEqual(Array.from(b));
    const grows = new Set(
      (world.surfaces[wood]?.cover ?? []).map((c) =>
        world.flora.kinds.findIndex((k) => k.id === c.plant),
      ),
    );
    for (let i = 0; i < a.length; i += PLANT_STRIDE) {
      expect(Math.hypot((a[i] ?? 0) - mx, (a[i + 1] ?? 0) - my)).toBeLessThan(203);
      expect(grows.has(a[i + 6] ?? -1)).toBe(true);
      const kind = world.flora.kinds[a[i + 6] ?? 0];
      expect(a[i + 3]).toBeGreaterThanOrEqual((kind?.height[0] ?? 0) - 1e-3);
      expect(a[i + 3]).toBeLessThanOrEqual((kind?.height[1] ?? 0) + 1e-3);
    }
    // Bare ground grows nothing.
    const bare = island(
      world.surfaces.findIndex((x) => (x.cover ?? []).length === 0),
      mx,
      my,
      200,
    );
    expect(placePlants(n, bare.e, bare.s, null, flora, world.look.terrace).length).toBe(0);
  });

  test('cover about their share of their ground', () => {
    const { e, s } = island(wood, mx, my, 300);
    const a = placePlants(n, e, s, null, flora, world.look.terrace);
    const area = Math.PI * 300 * 300;
    for (const c of world.surfaces[wood]?.cover ?? []) {
      const k = world.flora.kinds.findIndex((x) => x.id === c.plant);
      let crowns = 0;
      for (let i = 0; i < a.length; i += PLANT_STRIDE) {
        if (a[i + 6] === k) {
          crowns += (Math.PI * (a[i + 4] ?? 0) ** 2) / 4;
        }
      }
      // A shrub's clumps, a cell wide at least, may fall short of a dense share.
      expect(crowns / area, c.plant).toBeLessThan(c.share * 1.25);
      expect(crowns / area, c.plant).toBeGreaterThan(c.share * 0.4);
    }
  });

  test('stand on no building', () => {
    const { e, s } = island(wood, mx, my, 200);
    const town: ChunkTown = {
      buildings: [
        {
          kind: 0,
          kit: 0,
          east: mx,
          north: my,
          heading: 0.7,
          level: 6,
          top: 12,
          storeys: 2,
          seed: 3,
          wall: 0,
          roof: 0,
          shutter: 0,
          flag: 0,
          frontage: 60,
          depth: 40,
          town: 0,
        },
      ],
      harbour: [],
    };
    const a = placePlants(n, e, s, town, flora, world.look.terrace);
    const sh = Math.sin(0.7);
    const ch = Math.cos(0.7);
    for (let i = 0; i < a.length; i += PLANT_STRIDE) {
      const dx = (a[i] ?? 0) - mx;
      const dy = (a[i + 1] ?? 0) - my;
      const inside = Math.abs(dx * sh + dy * ch) < 20 - 2 && Math.abs(dx * ch - dy * sh) < 30 - 2;
      expect(inside).toBe(false);
    }
  });
});
