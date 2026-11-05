// SPDX-License-Identifier: AGPL-3.0-only

// The player's look changed at sea, in Port Royal's harbour: the harbour
// board's "Your sailor" opens the picker over the sea, the camera brought
// close to the player's own sailor, who changes on deck as the swatches
// are tapped; Done keeps the look and the world sees it at once, Cancel
// puts the one kept back. The server checks the place again: a boat that
// has sailed out of the harbour meanwhile keeps its look, and is told why.

import type { ReadonlySignal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { chosen, Picker, type PickerState, shuffled, undone } from '../account/picker';
import type { Look, Looks } from '../catalog/looks';
import type { Harbour } from '../predict/physics';

/** What the board needs to change the player's look in Port Royal's harbour. */
export interface HarbourLook {
  /** Whether the boat is in Port Royal's harbour now. */
  royal: ReadonlySignal<boolean>;
  looks: Looks;
  /** The player's look as kept. */
  current(): Look;
  /** Draws the player's sailor in a look, the camera close; null puts the kept look and the camera back. */
  preview(l: Look | null): void;
  /** Keeps the look: null once kept, else why not, in words. */
  done(l: Look): Promise<string | null>;
}

/**
 * Whether (east, north) is in a harbour: within its basin, or its narrows
 * out to the mouth, as the server tells it (internal/physics InHarbour).
 */
export function inHarbour(h: Harbour | null, east: number, north: number): boolean {
  if (h === null) {
    return false;
  }
  const dx = east - h.x;
  const dy = north - h.y;
  if (Math.hypot(dx, dy) <= h.radius) {
    return true;
  }
  const mx = h.mouthX - h.x;
  const my = h.mouthY - h.y;
  const length = Math.hypot(mx, my);
  if (length === 0) {
    return false;
  }
  const along = Math.min(Math.max((dx * mx + dy * my) / length, 0), length);
  const ax = dx - (along * mx) / length;
  const ay = dy - (along * my) / length;
  return Math.hypot(ax, ay) <= h.narrows / 2;
}

/** The picker over the sea, in the board's place: Cancel and Done. */
export function HarbourPicker({ look: h, close }: { look: HarbourLook; close: () => void }) {
  const [pick, setPick] = useState<PickerState>(() => chosen(h.current()));
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (p: PickerState) => {
    setPick(p);
    setProblem('');
    h.preview(p.look);
  };
  return (
    <section class="panel board harbour-look" aria-labelledby="harbour-look-title">
      <h2 id="harbour-look-title">Your sailor</h2>
      <Picker
        looks={h.looks}
        look={pick.look}
        choose={(l) => set(chosen(l))}
        shuffle={() => set(shuffled(h.looks, pick))}
        undo={pick.before === null ? null : () => set(undone(pick))}
        figure
      />
      <p class="harbour-look-problem" aria-live="polite">
        {problem}
      </p>
      <div class="harbour-look-actions">
        <button
          type="button"
          class="board-close"
          disabled={busy}
          onClick={() => {
            h.preview(null);
            close();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          class="board-close harbour-look-done"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void h.done(pick.look).then((why) => {
              setBusy(false);
              if (why === null) {
                close();
              } else {
                setProblem(why);
              }
            });
          }}
        >
          Done
        </button>
      </div>
    </section>
  );
}
