// SPDX-License-Identifier: AGPL-3.0-only

// The log, loaded the first time it is opened: the game's first download
// holds none of it. And the one way into a sailor's log from a name
// anywhere in the game (the sailor card, shipmates, the machine sailors'
// panel, the news): the chart screen's Log tab where the chart is, the
// same sheet on its own where it is not yet (the start screen).

import { useEffect, useState } from 'preact/hooks';
import type { LogWho } from '../chart/chart';

type LogModule = typeof import('./log');

let loading: Promise<LogModule> | null = null;

/** The log's module, loaded once; tried again after a failure. */
export function loadLog(): Promise<LogModule> {
  if (loading === null) {
    loading = import('./log').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The log's module once loaded, or null until then. */
export function useLog(need = true): LogModule | null {
  const [m, setM] = useState<LogModule | null>(null);
  useEffect(() => {
    if (!need || m !== null) {
      return;
    }
    let live = true;
    loadLog().then(
      (mod) => {
        if (live) {
          setM(mod);
        }
      },
      () => {
        // Not shown: asked for again when next opened.
      },
    );
    return () => {
      live = false;
    };
  }, [need, m]);
  return m;
}

let host: ((who: LogWho) => void) | null = null;

/** Sets where a log opens: the chart screen's Log tab once the chart is made; null for none. */
export function setLogHost(h: ((who: LogWho) => void) | null): void {
  host = h;
}

/** Opens a sailor's log, or the reader's own: on the chart screen's Log tab, or on its own where there is no chart yet. */
export function openLog(who: LogWho): void {
  if (host !== null) {
    host(who);
    return;
  }
  void loadLog().then((m) => m.showLogAlone(who));
}
