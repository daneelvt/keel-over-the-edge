// SPDX-License-Identifier: AGPL-3.0-only

// The player's look changed in Port Royal's harbour, as the game's page
// does it: the boat's place in the harbour the Welcome named, checked once
// a second; the player's own sailor drawn in each look tapped, the camera
// close; the look kept by the server, which checks the place again and
// tells the world, and every screen that sees the boat.

import { computed, signal } from '@preact/signals';
import { LOOK_AWAY, LOOK_FAILED } from '../account/chooser';
import { catalog } from '../catalog';
import { codeOf, type Look, lookOf } from '../catalog/looks';
import type { Online } from '../net/online';
import type { SeaScene } from '../render/scene';
import { type HarbourLook, inHarbour } from '../ui/harbourlook';

/** The camera close to the player's own sailor while a look is chosen at sea. */
const CLOSE = { azimuth: 2.2, elevation: 0.28, distance: 5 };

/**
 * The look the board changes: in Port Royal's harbour, the player's own
 * boat, not one watched. A look sent to keep is the player's own once the
 * server has said so; until then the one tapped is drawn.
 */
export function harbourLook(
  world: SeaScene,
  online: Online,
  fetcher: typeof fetch = fetch,
): HarbourLook {
  const here = signal(false);
  setInterval(() => {
    here.value = inHarbour(online.harbour, world.pose.east, world.pose.north);
  }, 1000);
  const royal = computed(() => here.value && !online.spectating.value);
  const current = (): Look =>
    lookOf(catalog, online.look.value ?? 0) ?? (lookOf(catalog, 0) as Look);
  const back = () => {
    void world.showLook(online.look.value ?? 0);
    world.placeCamera(world.camera.rest);
  };
  return {
    royal,
    looks: catalog,
    current,
    preview(l) {
      if (l === null) {
        back();
        return;
      }
      void world.showLook(codeOf(catalog, l));
      world.placeCamera(CLOSE);
    },
    async done(l) {
      try {
        const res = await fetcher('/api/sailor/look', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(l),
        });
        if (res.status === 200) {
          // The server's LookChanged draws it from here on.
          online.look.value = codeOf(catalog, l);
          back();
          return null;
        }
        back();
        return res.status === 409 ? LOOK_AWAY : LOOK_FAILED;
      } catch {
        back();
        return LOOK_FAILED;
      }
    },
  };
}

/**
 * The same on the sandbox page, which has no server: Port Royal's harbour
 * is the harbour disc nearest the world's centre, and a look kept is the
 * page's own.
 */
export function sandboxHarbourLook(world: SeaScene, code: number): HarbourLook {
  const royal = signal(false);
  let own = code;
  setInterval(() => {
    const land = world.land;
    let disc: { east: number; north: number; radius: number } | null = null;
    for (const d of land?.towns.harbour() ?? []) {
      if (disc === null || Math.hypot(d.east, d.north) < Math.hypot(disc.east, disc.north)) {
        disc = d;
      }
    }
    const p = world.pose;
    royal.value =
      disc !== null && Math.hypot(p.east - disc.east, p.north - disc.north) <= disc.radius;
  }, 1000);
  const back = () => {
    void world.showLook(own);
    world.placeCamera(world.camera.rest);
  };
  return {
    royal,
    looks: catalog,
    current: () => lookOf(catalog, own) ?? (lookOf(catalog, 0) as Look),
    preview(l) {
      if (l === null) {
        back();
        return;
      }
      void world.showLook(codeOf(catalog, l));
      world.placeCamera(CLOSE);
    },
    done(l) {
      own = codeOf(catalog, l);
      back();
      return Promise.resolve(null);
    },
  };
}
