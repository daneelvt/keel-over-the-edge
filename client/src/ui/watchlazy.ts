// SPDX-License-Identifier: AGPL-3.0-only

// Watching another sailor's boat, as the screens see it, and its parts
// (the list of sailors to watch, the bar over a boat watched, the "Allow
// spectators" choice), loaded the first time one is needed: the game's
// first download holds none of them.

import type { ReadonlySignal, Signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Status, WatchingTold } from '../net/messages';
import type { Place, WatchEnd } from '../net/online';

/** What the screens show of watching, and what they ask of it. */
export interface WatchView {
  /** The boat watched, or null. */
  watching: ReadonlySignal<WatchingTold | null>;
  /** The boat drawn is not the own: watched, or held while none is. Nothing steers it. */
  spectating: ReadonlySignal<boolean>;
  /** Where the connection stands. */
  status: ReadonlySignal<Status>;
  /** The last watch ended or refused, until the next Welcome. */
  ended: ReadonlySignal<WatchEnd | null>;
  /** The place in the spectators' queue, or null. */
  place: ReadonlySignal<Place | null>;
  /** The place in the queue for a boat, or null. */
  boatPlace: ReadonlySignal<Place | null>;
  /** How many watch the own boat. */
  watchers: ReadonlySignal<number>;
  /** Whether the list of sailors to watch is open. */
  list: Signal<boolean>;
  watch(sailor: string): void;
  sail(): void;
  unwatch(): void;
  /** The camera back behind the boat watched. */
  behind(): void;
}

/** Whether the own boat sails on this connection: watching takes it out of the water. */
export function sailsOwn(view: WatchView): boolean {
  return !view.spectating.value && view.status.value === 'sailing';
}

type Watch = typeof import('./watch');

let loading: Promise<Watch> | null = null;

/** The watching parts' module, loaded once; tried again after a failure. */
export function loadWatch(): Promise<Watch> {
  if (loading === null) {
    loading = import('./watch').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The watching parts' module once loaded, or null until then; nothing is loaded until need. */
export function useWatch(need = true): Watch | null {
  const [m, setM] = useState<Watch | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadWatch().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Not shown: asked for again when next needed.
      },
    );
    return () => {
      live = false;
    };
  }, [need, m]);
  return m;
}
