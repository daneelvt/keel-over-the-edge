// SPDX-License-Identifier: AGPL-3.0-only

// The player's boat changed in a port, as the game's page does it: the
// fleet read and changed through the server, which checks the place again;
// a look kept reaches the scene as the world tells it, and a boat swapped
// as a new Welcome. On the sandbox page, which has no server, a fleet of
// one boat of each kind is the page's own.

import { computed, signal } from '@preact/signals';
import { BoatChooser } from '../account/boatchooser';
import type { BoatCatalog, Fleet, FleetBoat, LookChange } from '../account/fleet';
import type { Fetch } from '../account/me';
import type { Online } from '../net/online';
import type { HarbourBoats } from '../ui/board';

/** The board's boats at sea: the player's own, not one watched. */
export function harbourBoats(cat: BoatCatalog, online: Online, fetcher?: Fetch): HarbourBoats {
  return {
    own: computed(() => !online.spectating.value),
    chooser: new BoatChooser(cat, fetcher),
  };
}

/** A JSON answer, as the server's. */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The fleet's routes answered on the page: one boat of each kind of the
 * catalog, the first the player's; a boat chosen is theirs, a look
 * changed is kept, a sail number another boat's of its kind refused.
 */
export function sandboxFleet(cat: BoatCatalog): Fetch {
  const paint = cat.boatLooks.paints[0]?.id ?? '';
  const cloth = cat.boatLooks.cloths[0]?.id ?? '';
  const boats: FleetBoat[] = cat.boats.map((b, i) => ({
    id: `sandbox-${i + 1}`,
    kind: b.id,
    number: i + 1,
    name: '',
    paint,
    cloth,
    sailor: i === 0 ? 'You' : '',
    machine: false,
    atSea: i === 0,
    yours: i === 0,
  }));
  const fleet: Fleet = { boat: boats[0]?.id ?? '', boats };
  const copy = (): Fleet => ({ boat: fleet.boat, boats: fleet.boats.map((b) => ({ ...b })) });
  return (input, init) => {
    const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as LookChange;
    const b = fleet.boats.find((x) => x.id === body.boat);
    switch (input) {
      case '/api/fleet':
        return Promise.resolve(answer(200, copy()));
      case '/api/boat': {
        if (b === undefined) {
          return Promise.resolve(answer(404, { error: 'boat' }));
        }
        for (const x of fleet.boats) {
          const mine = x.id === b.id;
          x.yours = mine;
          x.atSea = mine;
          x.sailor = mine ? 'You' : '';
        }
        fleet.boat = b.id;
        return Promise.resolve(answer(200, copy()));
      }
      case '/api/boat/look': {
        if (b === undefined) {
          return Promise.resolve(answer(404, { error: 'boat' }));
        }
        const n = body.number;
        if (
          n !== undefined &&
          fleet.boats.some((x) => x.id !== b.id && x.kind === b.kind && x.number === n)
        ) {
          return Promise.resolve(answer(409, { error: 'number' }));
        }
        Object.assign(b, {
          ...(body.paint === undefined ? {} : { paint: body.paint }),
          ...(body.cloth === undefined ? {} : { cloth: body.cloth }),
          ...(n === undefined ? {} : { number: n }),
          ...(body.name === undefined ? {} : { name: body.name }),
        });
        return Promise.resolve(answer(200, copy()));
      }
    }
    return Promise.resolve(answer(404, { error: 'not-found' }));
  };
}

/** The board's boats on the sandbox page: always the player's own. */
export function sandboxBoats(cat: BoatCatalog): HarbourBoats {
  return { own: signal(true), chooser: new BoatChooser(cat, sandboxFleet(cat)) };
}
