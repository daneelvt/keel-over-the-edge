// SPDX-License-Identifier: AGPL-3.0-only

// The chart as the screen uses it: whether it is open, and as the chart,
// its list or the news; what is picked on it, a charted thing or a weather
// system; the course steered for a system from its box; and the notices
// its chartings raise: one for each place the player charts, and one for
// each great discovery anyone does.

import { signal } from '@preact/signals';
import type { ChartEntry } from '../net/messages';
import type { Notices } from '../ui/notices';
import type { ChartStore } from './store';
import { zoneWhere } from './store';
import type { ChartView } from './view';
import { LAYERS_AT_FIRST, type Layer, type Layers, type TimeMode } from './weather';

export type ChartMode = 'chart' | 'list' | 'news';

/** A weather system or a front tapped on the chart: which, as the scene had it then. */
export type TappedWeather =
  | { kind: 'system'; slot: number; seed: number }
  | { kind: 'front'; sin: number; cos: number };

/**
 * The course the sailor steered for a tapped system, from its box: the
 * heading, and where and when the boat meets it, m and the world's tick.
 */
export interface SteeredCourse {
  heading: number;
  east: number;
  north: number;
  at: number;
}

export class Chart {
  readonly store: ChartStore;
  readonly view: ChartView;
  readonly notices: Notices;
  readonly open = signal(false);
  readonly mode = signal<ChartMode>('chart');
  /** The entry whose box is open, or null. */
  readonly picked = signal<ChartEntry | null>(null);
  /** The weather system or front whose box is open, or null. */
  readonly tapped = signal<TappedWeather | null>(null);
  /** The course last steered for a system from its box, or null. */
  readonly steered = signal<SteeredCourse | null>(null);
  /**
   * The slider: the forecast ahead, its minutes from now; or what
   * happened, its minutes back, negative; 0 is now. Play runs it on ahead.
   */
  readonly timeMode = signal<TimeMode>('forecast');
  readonly minutes = signal(0);
  readonly playing = signal(false);
  /** The weather's layers, each switched on or off. */
  readonly layers = signal<Layers>({ ...LAYERS_AT_FIRST });
  /** The clock notices are raised by, ms. */
  now: () => number = () => performance.now();

  constructor(store: ChartStore, view: ChartView, notices: Notices) {
    this.store = store;
    this.view = view;
    this.notices = notices;
    view.onPick = (e) => {
      this.picked.value = e;
      this.tapped.value = null;
    };
    store.onCharted((es) => this.#told(es));
  }

  /** Opens it as the chart, the list or the news; or closes it. */
  show(mode: ChartMode | null): void {
    if (mode === null) {
      this.open.value = false;
      this.picked.value = null;
      this.tapped.value = null;
      this.view.show(false);
      // Back to now for the next look.
      this.timeMode.value = 'forecast';
      this.minutes.value = 0;
      this.playing.value = false;
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

  /** Switches a layer of the weather on or off. */
  setLayer(layer: Layer, on: boolean): void {
    this.layers.value = { ...this.layers.value, [layer]: on };
  }

  /** The slider to the forecast ahead or what happened, at now. */
  setTimeMode(mode: TimeMode): void {
    this.timeMode.value = mode;
    this.minutes.value = 0;
    this.playing.value = false;
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
