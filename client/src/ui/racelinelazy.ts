// SPDX-License-Identifier: AGPL-3.0-only

// The racer's screen's parts (raceline.tsx), loaded the first time the
// boat is in a race: the game's first download holds none of them.

import { useEffect, useState } from 'preact/hooks';
import type { RaceSource } from './raceline';

export type { RaceSource };

type RaceLineModule = typeof import('./raceline');

let loading: Promise<RaceLineModule> | null = null;

/** The race's parts' module, loaded once; tried again after a failure. */
export function loadRaceLine(): Promise<RaceLineModule> {
  if (loading === null) {
    loading = import('./raceline').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** Whether any of the race's parts is on the screen. */
export function raceShown(src: RaceSource): boolean {
  const r = src.racing;
  return (
    r.told.value !== null ||
    (r.resultsOpen.value && r.ended.value !== null) ||
    (r.finishOpen.value && r.finish.value !== null)
  );
}

/** The race's parts' module once loaded, or null until then; nothing is loaded until need. */
export function useRaceLine(need: boolean): RaceLineModule | null {
  const [m, setM] = useState<RaceLineModule | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadRaceLine().then(
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
