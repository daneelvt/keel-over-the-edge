// SPDX-License-Identifier: AGPL-3.0-only

// A gale warning's notice: raised once a warning, the first issue it is in
// force in, its words the Met Office's, "Gale warning: southwesterly gale 8
// expected soon, south-west of Gannet Holm", where it blows named from the
// shared chart, so everyone's notice names the same place. What it tells
// is in the news and on the chart too.

import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import type { Notices } from '../ui/notices';
import { warningOf } from './placeweather';
import type { ChartStore } from './store';
import { warningParts, wordsOf } from './words';

export class GaleNotices {
  readonly #store: ChartStore;
  readonly #notices: Notices;
  readonly #now: () => number;
  /** The warnings told of, by their keys. */
  readonly #told = new Set<number>();

  constructor(store: ChartStore, notices: Notices, now: () => number = () => performance.now()) {
    this.#store = store;
    this.#notices = notices;
    this.#now = now;
  }

  /** Takes an issue: a warning not told of yet raises its notice. */
  issued(f: ForecastTold): void {
    const g = f.gale;
    if (g === null || this.#told.has(g.key)) {
      return;
    }
    this.#told.add(g.key);
    const p = warningParts(warningOf(g, this.#store), wordsOf(catalog.weather));
    this.#notices.raise('gale-warned', { wind: p.wind, when: p.when, where: p.where }, this.#now());
  }

  /** Forgets the warnings told of: a new world's. */
  reset(): void {
    this.#told.clear();
  }
}
