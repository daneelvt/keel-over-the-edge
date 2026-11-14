// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore, as the screens see them: the board of the races ahead,
// read when the game opens and at most once a minute while it is open;
// the panel that makes a race, a race's card, and the share of a race
// made, each open or not. Their parts (races.tsx) are loaded the first
// time one opens: the game's first download holds none of them. The
// notices of races are raised here, from the board, at their minutes.

import { type Signal, signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Fetch } from '../account/me';
import type { Notices } from './notices';
import {
  forgetWatchedRace,
  type RaceCard,
  type RacesBoard,
  raceAct,
  readBoard,
  readCard,
  watchedRaces,
} from './raceapi';
import {
  dueNotices,
  dueWatches,
  RACE_SOON,
  type RaceNoticeKind,
  type WatchedRace,
} from './racenotices';
import { ENTER, WATCH } from './racewords';

/** Races ashore as the screens see them, and what they ask of them. */
export interface RacesView {
  /** The board, as last read; null before it is. */
  board: Signal<RacesBoard | null>;
  /** Whether the panel that makes a race is open. */
  make: Signal<boolean>;
  /** The race whose card is open, by its code; null for none. */
  card: Signal<string | null>;
  /** The race just made, its share open; null for none. */
  shared: Signal<RaceCard | null>;
  /** The world clock as UTC, ms. */
  now: () => number;
  /** Whether the player skippers a boat with others aboard: Enter with my crew is offered. */
  crew: () => boolean;
  /** The server, as races reach it. */
  fetch: Fetch;
  /** Reads the board again now. */
  refresh: () => Promise<void>;
  /** Opens a race's replay by its code, its card closed; null where none may be. */
  replay: ((code: string) => void) | null;
}

/** Makes the view: nothing open, the board unread. */
export function racesOf({
  now = () => Date.now(),
  crew = () => false,
  fetch: f = (input, init) => fetch(input, init),
}: {
  now?: () => number;
  crew?: () => boolean;
  fetch?: Fetch;
} = {}): RacesView {
  const view: RacesView = {
    board: signal(null),
    make: signal(false),
    card: signal(null),
    shared: signal(null),
    now,
    crew,
    fetch: f,
    replay: null,
    refresh: async () => {
      const a = await readBoard(f);
      if (a.ok) {
        view.board.value = a.value;
      }
    },
  };
  return view;
}

/** Whether any of races' windows is open. */
export function racesShown(v: RacesView): boolean {
  return v.make.value || v.card.value !== null || v.shared.value !== null;
}

/** How often the board is read while the game is open, ms: at most once a minute. */
export const BOARD_EVERY = 60_000;

/** How often the notices due are looked for, ms: well within their minute. */
const NOTICE_EVERY = 5_000;

/**
 * Reads the board now and once a minute after, and raises the notices of
 * races at their minutes: the harbour's with Enter, which enters in one
 * tap and opens the card to say how it went (or why not). The result
 * stops it.
 */
export function pollRaces(
  view: RacesView,
  notices: Notices,
  kinds: readonly RaceNoticeKind[],
  watch: ((code: string) => void) | null = null,
): () => void {
  const shown = new Set<string>();
  // The races asked to be watched when they start, as their cards say.
  let watched: WatchedRace[] = [];
  const readWatched = async () => {
    if (watch === null) {
      return;
    }
    const out: WatchedRace[] = [];
    for (const code of watchedRaces()) {
      const a = await readCard(code, view.fetch);
      if (!a.ok) {
        if (a.refusal.status === 404) {
          forgetWatchedRace(code);
        }
        continue;
      }
      const c = a.value;
      if (
        c.phase === 'finished' ||
        c.phase === 'cancelled' ||
        c.phase === 'ended' ||
        c.mine.entered
      ) {
        forgetWatchedRace(code);
        continue;
      }
      out.push({ code, name: c.name, startsAt: c.startsAt });
    }
    watched = out;
  };
  void view.refresh();
  void readWatched();
  const read = setInterval(() => {
    void view.refresh();
    void readWatched();
  }, BOARD_EVERY);
  const look = setInterval(() => {
    const board = view.board.value;
    const now = view.now();
    if (board === null || !Number.isFinite(now)) {
      return;
    }
    if (watch !== null) {
      for (const d of dueWatches(watched, now, shown)) {
        const code = d.race.code;
        notices.raise(RACE_SOON, d.fill, performance.now(), {
          label: WATCH,
          act: () => {
            forgetWatchedRace(code);
            watch(code);
          },
        });
      }
    }
    for (const d of dueNotices(board, kinds, now, shown)) {
      const code = d.race.code;
      notices.raise(
        d.on,
        d.fill,
        performance.now(),
        d.enter
          ? {
              label: ENTER,
              act: () => {
                void raceAct(code, 'enter', { crew: false }, view.fetch).then(() => {
                  view.card.value = code;
                  void view.refresh();
                });
              },
            }
          : undefined,
      );
    }
  }, NOTICE_EVERY);
  return () => {
    clearInterval(read);
    clearInterval(look);
  };
}

type Races = typeof import('./races');

let loading: Promise<Races> | null = null;

/** The races' parts' module, loaded once; tried again after a failure. */
export function loadRaces(): Promise<Races> {
  if (loading === null) {
    loading = import('./races').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The races' parts' module once loaded, or null until then; nothing is loaded until need. */
export function useRaces(need: boolean): Races | null {
  const [m, setM] = useState<Races | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadRaces().then(
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
