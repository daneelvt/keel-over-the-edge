// SPDX-License-Identifier: AGPL-3.0-only

// What the page has fetched over HTTP, as the bytes came over the wire: the
// page itself, its code, models, portraits and fonts, from Resource
// Timing's transferSize, which is 0 for a file the browser's cache or the
// service worker served; and the land's chunks, which the mesh worker
// fetches and counts itself (a worker's fetches are not in the page's
// timeline). The Pings tell the server how much since the last; the
// start-up report how much to the reveal. An observer, not the timeline's
// buffer, so no entry is lost once the buffer is full.

/** A Resource Timing entry, as far as it is read here. */
export interface Fetch {
  transferSize?: number;
}

export class Fetched {
  /** The land's chunks fetched, bytes: read when asked, as the land counts them. */
  land: () => number = () => 0;
  #page = 0;
  #told = 0;

  /** Counts entries the observer gave. */
  add(entries: readonly Fetch[]): void {
    for (const e of entries) {
      const n = e.transferSize ?? 0;
      if (Number.isFinite(n) && n > 0) {
        this.#page += n;
      }
    }
  }

  /** Every byte fetched so far. */
  get total(): number {
    return this.#page + this.land();
  }

  /** The bytes fetched since the last time this was asked. */
  take(): number {
    const t = this.total;
    const n = Math.max(0, t - this.#told);
    this.#told = t;
    return n;
  }
}

/**
 * The page's count, from its navigation and every resource it fetches, the
 * ones before it was made among them; none where the browser has no
 * observer for them.
 */
export function watchFetched(): Fetched {
  const f = new Fetched();
  if (typeof PerformanceObserver === 'undefined') {
    return f;
  }
  for (const type of ['navigation', 'resource']) {
    try {
      new PerformanceObserver((list) => f.add(list.getEntries() as Fetch[])).observe({
        type,
        buffered: true,
      });
    } catch {
      // A type this browser does not time.
    }
  }
  return f;
}
