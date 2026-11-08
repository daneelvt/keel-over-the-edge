// SPDX-License-Identifier: AGPL-3.0-only

// The clear view: every part of the screen at sea hidden but its own key
// and the way back to the boat, so the sea and the boat are all there is
// to see; the overlays on the sea go with them. Tapped again, everything
// returns. It comes back by itself when the player is needed: their boat
// capsized or its sailor in the water, the boat taken by another device or
// returned to port, a watch ended or turned into a queue, a change of boat,
// a new knock on the own boat or the controls offered.
// Never for the weather, a notice or a connection that sails on under
// prediction. It is not remembered: every voyage starts with everything
// shown.

import { signal } from '@preact/signals';
import type { WatchEnd } from '../net/online';

export class ClearView {
  /** Whether the screen is cleared. */
  readonly on = signal(false);
  /** Told of each change: the scene hides its overlays with the screen. */
  onChange: ((on: boolean) => void) | null = null;

  toggle(): void {
    this.set(!this.on.value);
  }

  /** Everything shown again. */
  show(): void {
    this.set(false);
  }

  set(on: boolean): void {
    if (on !== this.on.value) {
      this.on.value = on;
      this.onChange?.(on);
    }
  }
}

/** What says the player is needed. */
export interface Needed {
  /** The own boat capsized, or its sailor out of it. */
  overboard: boolean;
  /** Another device has the boat: Take over. */
  takeover: boolean;
  /** How many times the boat has been returned to port. */
  returned: number;
  /** The last watch ended or refused. */
  ended: WatchEnd | null;
  /** In a queue: for a boat, or to watch. */
  queued: boolean;
  /** How many knocks wait on the own boat; none when absent. */
  knocks?: number;
  /** The controls are offered to the player. */
  handed?: boolean;
}

/** Whether, from was to now, something came that needs the player. */
export function needed(was: Needed, now: Needed): boolean {
  return (
    (now.overboard && !was.overboard) ||
    (now.takeover && !was.takeover) ||
    now.returned !== was.returned ||
    (now.ended !== null && now.ended !== was.ended) ||
    (now.queued && !was.queued) ||
    (now.knocks ?? 0) > (was.knocks ?? 0) ||
    (now.handed === true && was.handed !== true)
  );
}
