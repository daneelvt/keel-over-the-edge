// SPDX-License-Identifier: AGPL-3.0-only

// The player's own sailor on the start screen with machine sailors: its
// name, whether its boat is in the water, Set sail as it, and Watch
// another sailor. It is the screen's only gold button, as setting sail is
// the only thing there the player does as themselves; their machine
// sailors stand apart beside it. In the game's first download, so the
// screen shows it while the machine sailors' module loads.
//
// The name is shown, never asked for or changed here: every account is
// made with its named sailor on the first form, so none reaches this
// screen without one.

import { STILL_AT_SEA, WATCH_ANOTHER_SAILOR } from '../ui/watchwords';
import type { Me } from './me';

/** The button that sails the player's own sailor, by its name. */
export function setSailAs(name: string): string {
  return `Set sail as ${name}`;
}

/**
 * The player's panel: sail sets their own sailor to sea; watch opens the
 * list of sailors to watch, null while it cannot yet.
 */
export function YourSailor({
  me,
  sail,
  watch,
}: {
  me: Me;
  sail: () => void;
  watch: (() => void) | null;
}) {
  const atSea = me.atSea === true;
  return (
    <section class="start-panel your-sailor" aria-labelledby="start-title">
      <h1 id="start-title">Keel Over the Edge</h1>
      <h2 id="your-sailor-title">Your sailor</h2>
      <p class="your-sailor-name">
        <bdi>{me.name}</bdi>
      </p>
      <p class="start-text start-faint" data-readout="at-sea">
        {atSea ? 'at sea' : 'not at sea'}
      </p>
      {atSea ? (
        <p class="start-warning" role="note">
          {STILL_AT_SEA}
        </p>
      ) : null}
      <button type="button" class="start-go your-sailor-go" onClick={sail}>
        {setSailAs(me.name)}
      </button>
      <button
        type="button"
        class="start-sign-in"
        disabled={watch === null}
        onClick={watch ?? undefined}
      >
        {WATCH_ANOTHER_SAILOR}
      </button>
    </section>
  );
}
