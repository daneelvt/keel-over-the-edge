// SPDX-License-Identifier: AGPL-3.0-only

// "Let others watch me sail": the player's choice for one voyage, on every
// screen whose Set sail goes to sea. Unticked whenever the player's boat is
// not in the water, so that nobody is watched by a choice made once and
// forgotten: it is never kept between voyages, here or on another device.
// With the boat in the water (a reload, another device) it shows that
// voyage's choice, and a change is sent at once. Ticked, Set sail first
// asks the server to let the voyage be watched, then goes to sea; if the
// server cannot be asked, the player sails anyway, unwatched, and is told
// so at sea. In the game's first download, with the panel it is on.

import { type Signal, signal } from '@preact/signals';
import type { Fetch, Me } from './me';
import { call } from './passkeys';

/** Told at sea when Set sail asked for the voyage to be watched and the server could not. */
export const NOT_WATCHED = 'Others cannot watch you this voyage';

/** Set sail asked for the voyage to be watched, and the server did not take it. */
export let watchRefused = false;

/** The box on one Set sail screen, and Set sail with it. */
export interface Voyage {
  /** Ticked. */
  on: Signal<boolean>;
  /** Ticks the box, or not, as the player did. */
  set(on: boolean): void;
  /** Sends the voyage's choice first where it must be, then goes, watched or not. */
  sail(go: () => void): Promise<void>;
}

/** POST /api/me/spectators: whether the server took it. */
const allow = async (f: Fetch, on: boolean) =>
  (await call(f, '/api/me/spectators', { allow: on ? 'voyage' : 'no' })).status === 200;

/** The box for me's next voyage, or for the one under way when its boat is in the water. */
export function voyage(me: Me, f: Fetch = fetch): Voyage {
  const atSea = me.atSea === true;
  const on = signal(atSea && me.spectators === 'voyage');
  let busy = false;
  let sent: Promise<unknown> = Promise.resolve();
  return {
    on,
    set(v) {
      on.value = v;
      if (atSea) {
        sent = allow(f, v).then((ok) => {
          if (!ok) {
            on.value = !v;
          }
        });
      }
    },
    async sail(go) {
      if (busy) {
        return;
      }
      busy = true;
      await sent;
      // Unticked, a choice made elsewhere for a boat that never sailed is
      // taken back: the box is what the player sees.
      if (!atSea && (on.value || me.spectators === 'voyage')) {
        watchRefused = !(await allow(f, on.value)) && on.value;
      }
      go();
    },
  };
}

/** The box, and its faint line. */
export function LetWatch({ voyage: v }: { voyage: Voyage }) {
  return (
    <div class="let-watch">
      <label>
        <input
          type="checkbox"
          checked={v.on.value}
          aria-describedby="let-watch-line"
          onChange={(e) => v.set(e.currentTarget.checked)}
        />
        Let others watch me sail
      </label>
      <p id="let-watch-line" class="start-text start-faint">
        This voyage only.
      </p>
    </div>
  );
}
