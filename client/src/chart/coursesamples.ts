// SPDX-License-Identifier: AGPL-3.0-only

// A chart with a place, an island and a race course charted, and a phone's
// storage in memory, for the course's tests.

import { catalog } from '../catalog';
import type { ChartEntry, CourseOpen } from '../net/messages';
import { type NoticeKind, Notices } from '../ui/notices';
import { Chart } from './chart';
import type { CourseKeep } from './course';
import { ChartStore } from './store';
import type { ChartView } from './view';

const words = {
  places: [{ name: 'Port' }, { name: 'Lighthouse', site: 'light' }],
  features: [{ name: 'Sea arch' }],
  scale: 10,
  lip: 8334,
  great: 20,
};

export function entry(e: Partial<ChartEntry>): ChartEntry {
  return {
    subject: 'island',
    number: 0,
    sort: 0,
    name: '',
    east: 0,
    north: 0,
    by: '',
    ai: false,
    at: 0,
    worth: 1,
    island: -1,
    group: '',
    bounds: null,
    highest: 0,
    zone: 0,
    className: '',
    model: '',
    light: -1,
    character: 0,
    focal: 0,
    range: 0,
    ship: '',
    sunk: false,
    withSubject: null,
    withNumber: 0,
    ...e,
  };
}

export const GULL: ChartEntry = entry({
  subject: 'place',
  number: 4,
  sort: 1,
  name: 'Gull Rock',
  east: 1000,
  north: 1000,
  light: 2,
});

export const ISLE: ChartEntry = entry({
  subject: 'island',
  number: 3,
  name: 'Long Cay',
  east: 3000,
  north: 0,
  bounds: [2500, -400, 3500, 400],
});

export const ROUND: CourseOpen = {
  number: 2,
  kind: 'round',
  name: 'Round Long Cay',
  way: [
    [2000, 600],
    [3600, 0],
  ],
  length: 4000,
  rounds: [],
  boats: [],
};

/** A store with Gull Rock, Long Cay and a course round it charted. */
export function chartedStore(): ChartStore {
  return storeWith([GULL, ISLE], [ROUND]);
}

/** A store with these entries and courses charted. */
export function storeWith(entries: ChartEntry[], courses: CourseOpen[] = []): ChartStore {
  const s = new ChartStore(words);
  s.receive(entries, true, courses);
  return s;
}

/** A phone's storage, in memory. */
export function memoryKeep(): CourseKeep & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

/** A chart over the store, its view stood in for, its notices the catalog's. */
export function chartOf(store = chartedStore(), keep = memoryKeep()): Chart {
  const view = { onPick: null, show: () => {}, lookAt: () => {} } as unknown as ChartView;
  const notices = new Notices(catalog.notices.kinds as unknown as NoticeKind[], 3);
  const c = new Chart(store, view, notices);
  c.keep = keep;
  c.now = () => 1000;
  return c;
}
