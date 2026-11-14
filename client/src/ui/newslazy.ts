// SPDX-License-Identifier: AGPL-3.0-only

// The news sheet, loaded the first time it is opened: the game's first
// download holds none of it. And the one way to the news from anywhere in
// the game (a sailor card's last story, the view waiting to watch): the
// chart screen's News tab where the chart is shown, the same sheet on its
// own where it is not yet.

import { useEffect, useState } from 'preact/hooks';

/** The sheet's words while its code loads. */
export const OPENING = 'Opening the news…';

type NewsModule = typeof import('./news');

let loading: Promise<NewsModule> | null = null;

/** The news's module, loaded once; tried again after a failure. */
export function loadNews(): Promise<NewsModule> {
  if (loading === null) {
    loading = import('./news').catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** The news's module once loaded, or null until then. */
export function useNews(): NewsModule | null {
  const [m, setM] = useState<NewsModule | null>(null);
  useEffect(() => {
    if (m !== null) {
      return;
    }
    let live = true;
    loadNews().then(
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
  }, [m]);
  return m;
}

let host: ((day: string | null) => void) | null = null;

/** Sets where the news opens: the chart screen's News tab once it can be shown; null for none. */
export function setNewsHost(h: ((day: string | null) => void) | null): void {
  host = h;
}

/** Opens the news on a day's edition (2006-01-02), today's for null: on the chart screen's News tab, or on its own. */
export function openNews(day: string | null = null): void {
  if (host !== null) {
    host(day);
    return;
  }
  void loadNews().then((m) => m.showNewsAlone(day));
}
