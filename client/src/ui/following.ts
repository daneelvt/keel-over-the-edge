// SPDX-License-Identifier: AGPL-3.0-only

// The sailors the player follows setting sail: while the game is open, the
// phone asks the list of sailors to watch for those it follows every 30
// seconds, and one on it now that was not on the last answer has become
// watchable, a machine sailor put to sea or a human who set sail letting
// others watch: the notice says so. The list never names a human who does
// not allow it, so neither does the notice. The first answer only learns
// who is already sailing, and nothing is asked while the page is hidden:
// a sailor who set sail meanwhile is told on the next answer. Loaded after
// the sea is shown, apart from the game's first download.

import type { Fetch } from '../account/me';

/** How often the follows are asked for, ms. */
export const ASK_EVERY = 30_000;

/** The most pages of the follows asked for: an account follows 100 at most. */
const PAGES = 3;

/** A row of GET /api/watch?who=following, as far as this reads it. */
interface Row {
  name: string;
  gone?: string;
}

/** The names of the sailors followed that may be watched now; null if the list cannot be read. */
export async function sailingNow(f: Fetch): Promise<Set<string> | null> {
  const out = new Set<string>();
  for (let page = 0; page < PAGES; page++) {
    const q = new URLSearchParams({ who: 'following', sort: 'name', page: String(page) });
    let body: { sailors?: Row[]; more?: boolean };
    try {
      const res = await f(`/api/watch?${q}`, { cache: 'no-store', credentials: 'same-origin' });
      if (res.status !== 200) {
        return null;
      }
      body = await res.json();
    } catch {
      return null;
    }
    for (const r of body.sailors ?? []) {
      if (typeof r.name === 'string' && r.gone === undefined) {
        out.add(r.name);
      }
    }
    if (body.more !== true) {
      break;
    }
  }
  return out;
}

/** The sailors in now that were not in was; none for the first answer. */
export function setSail(was: ReadonlySet<string> | null, now: ReadonlySet<string>): string[] {
  return was === null ? [] : [...now].filter((n) => !was.has(n));
}

/**
 * Asks after the sailors followed every ASK_EVERY, telling raise of each
 * that has set sail since the last answer; returns a stop.
 */
export function followSailing(
  raise: (name: string) => void,
  f: Fetch = (input, init) => fetch(input, init),
  hidden: () => boolean = () => document.hidden,
): () => void {
  let was: Set<string> | null = null;
  let asking = false;
  const ask = async () => {
    if (asking || hidden()) {
      return;
    }
    asking = true;
    const now = await sailingNow(f);
    asking = false;
    if (now === null) {
      return;
    }
    for (const name of setSail(was, now)) {
      raise(name);
    }
    was = now;
  };
  void ask();
  const t = setInterval(() => void ask(), ASK_EVERY);
  return () => clearInterval(t);
}
