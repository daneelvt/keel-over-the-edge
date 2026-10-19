// SPDX-License-Identifier: AGPL-3.0-only

// The chart as the screen uses it: whether it is open, and as the chart,
// its list or the news; what is picked on it; and the notices its
// chartings raise: one for each place the player charts, and one for each
// great discovery anyone does.

import { signal } from '@preact/signals';
import type { ChartEntry } from '../net/messages';
import type { Notices } from '../ui/notices';
import type { ChartStore } from './store';
import { zoneWhere } from './store';
import type { ChartView } from './view';

export type ChartMode = 'chart' | 'list' | 'news';

export class Chart {
  readonly store: ChartStore;
  readonly view: ChartView;
  readonly notices: Notices;
  readonly open = signal(false);
  readonly mode = signal<ChartMode>('chart');
  /** The entry whose box is open, or null. */
  readonly picked = signal<ChartEntry | null>(null);
  /** The clock notices are raised by, ms. */
  now: () => number = () => performance.now();

  constructor(store: ChartStore, view: ChartView, notices: Notices) {
    this.store = store;
    this.view = view;
    this.notices = notices;
    view.onPick = (e) => {
      this.picked.value = e;
    };
    store.onCharted((es) => this.#told(es));
  }

  /** Opens it as the chart, the list or the news; or closes it. */
  show(mode: ChartMode | null): void {
    if (mode === null) {
      this.open.value = false;
      this.picked.value = null;
      this.view.show(false);
      return;
    }
    this.mode.value = mode;
    this.open.value = true;
    this.view.show(mode === 'chart');
  }

  /** Opens the chart at an entry, its box open. */
  showAt(e: ChartEntry): void {
    this.show('chart');
    // An island from where its name and its neighbours' show; a place or a
    // feature from where it is lettered too.
    this.view.lookAt(e.east, e.north, e.subject === 'island' ? 4500 : 2000);
    this.picked.value = e;
  }

  /** Opens the chart at a point. */
  showPoint(east: number, north: number): void {
    this.show('chart');
    this.view.lookAt(east, north, 4000);
  }

  #told(es: ChartEntry[]): void {
    const now = this.now();
    for (const e of es) {
      if (e.withSubject !== null) {
        continue;
      }
      const fill = {
        name: this.store.title(e),
        who: e.by,
        where: zoneWhere(e.zone),
        worth: String(Math.round(e.worth)),
      };
      if (this.store.mine(e)) {
        this.notices.raise('charted-own', fill, now);
      } else if (this.store.great(e) && e.by !== '') {
        this.notices.raise('charted-great', fill, now);
      }
    }
  }
}
