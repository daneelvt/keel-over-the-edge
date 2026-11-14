// SPDX-License-Identifier: AGPL-3.0-only

// A race's replay as the game holds it: the replay open on the chart, if
// any, and its windows. What draws and works it (replay.ts, replayparts.tsx) is
// loaded the first time a replay is opened: the game's first download
// holds none of it.

import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Fetch } from '../account/me';
import type { ReplayModel } from './replay';

type ReplayModule = typeof import('./replayparts');

let loading: Promise<ReplayModule> | null = null;

/** The replay's module, loaded once; tried again after a failure. */
export function loadReplay(): Promise<ReplayModule> {
  if (loading === null) {
    loading = import('./replayparts').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The replay's module once loaded, or null until then; nothing is loaded until need. */
export function useReplayParts(need: boolean): ReplayModule | null {
  const [m, setM] = useState<ReplayModule | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadReplay().then(
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

export class ReplayHost {
  /** The replay open on the chart; null for none. */
  readonly model = signal<ReplayModel | null>(null);
  /** Whether the replay's results, or its standings, are open over the chart. */
  readonly results = signal(false);
  readonly standings = signal(false);
  /** The server, as races reach it. */
  fetch: Fetch = (input, init) => fetch(input, init);
  /** The game's address, for a race's link. */
  origin = '';

  /** Opens a race's replay by its link's code: on the chart, or its results alone; set by the game. */
  open: (code: string) => void = () => {};

  /** Every part of it closed. */
  close(): void {
    const m = this.model.peek();
    if (m !== null) {
      m.playing.value = false;
    }
    this.model.value = null;
    this.results.value = false;
    this.standings.value = false;
  }
}
