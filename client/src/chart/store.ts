// SPDX-License-Identifier: AGPL-3.0-only

// The world's chart as the page holds it: every subject charted, as the
// server tells of it, whole after each Welcome and then as each is charted;
// or, offline, as the sandbox charts it. The chart, its pocket, its list,
// the notices and the news read it. Where a boat is is told as the sky
// gives it: its latitude, the Hub Star's height over the pole above the
// main port, and its bearing and distance from the main port.

import { signal } from '@preact/signals';
import type { ChartEntry, ChartSubject } from '../net/messages';

/** A nautical mile, m. */
export const NM = 1852;

/** A subject's key: its kind and number. */
export function keyOf(subject: ChartSubject, number: number): string {
  return `${subject}:${number}`;
}

/** What the store needs of the catalog. */
export interface ChartWords {
  /** The kinds of place's and of feature's names, by their indices. */
  places: { name: string }[];
  features: { name: string; symbol?: string }[];
  /** The degrees the Hub Star sinks a nautical mile out from the centre. */
  scale: number;
  /** The lip, m from the centre. */
  lip: number;
  /** A discovery worth this or more is a great one. */
  great: number;
}

/** Told of entries charted since the chart was had whole. */
export type ChartedListener = (charted: ChartEntry[]) => void;

export class ChartStore {
  /** Rises at every change: what draws the chart redraws. */
  readonly version = signal(0);
  /** Rises each time the chart is had whole: a new connection's, perhaps another world's. */
  generation = 0;
  /** The sailor's name, whose chartings are theirs; null offline. */
  me: string | null = null;
  readonly words: ChartWords;
  readonly #entries: ChartEntry[] = [];
  readonly #byKey = new Map<string, ChartEntry>();
  readonly #listeners: ChartedListener[] = [];

  constructor(words: ChartWords) {
    this.words = words;
  }

  /** Every entry, in the order charted. */
  get entries(): readonly ChartEntry[] {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** The entry of a subject, if it is charted. */
  get(subject: ChartSubject, number: number): ChartEntry | undefined {
    return this.#byKey.get(keyOf(subject, number));
  }

  /** Listens for what is charted: never the chart had whole. */
  onCharted(l: ChartedListener): void {
    this.#listeners.push(l);
  }

  /**
   * Takes entries from the server: with whole, the chart in full, replacing
   * what was held (a new connection's, perhaps another world's).
   */
  receive(entries: readonly ChartEntry[], whole: boolean): void {
    if (whole) {
      this.#entries.length = 0;
      this.#byKey.clear();
      this.generation++;
    }
    const added: ChartEntry[] = [];
    for (const e of entries) {
      const k = keyOf(e.subject, e.number);
      if (this.#byKey.has(k)) {
        continue;
      }
      this.#byKey.set(k, e);
      this.#entries.push(e);
      added.push(e);
    }
    this.version.value++;
    if (!whole && added.length > 0) {
      for (const l of this.#listeners) {
        l(added);
      }
    }
  }

  /** Whether an entry is the sailor's own charting. */
  mine(e: ChartEntry): boolean {
    return this.me !== null && e.by !== '' && e.by === this.me;
  }

  /** Whether an entry is a great discovery. */
  great(e: ChartEntry): boolean {
    return e.worth >= this.words.great;
  }

  /** The island an entry is on or by, if it is charted. */
  islandOf(e: ChartEntry): ChartEntry | undefined {
    return e.island < 0 ? undefined : this.get('island', e.island);
  }

  /** The kind's word: "Lighthouse", "Sea arch", "Island". */
  kindName(e: ChartEntry): string {
    switch (e.subject) {
      case 'place':
        return this.words.places[e.sort]?.name ?? 'Place';
      case 'feature':
        return this.words.features[e.sort]?.name ?? 'Feature';
    }
    return e.group !== '' ? `One of ${e.group}` : 'Island';
  }

  /** How the chart names an entry: its name, or "a sea arch on Keyhole Rock". */
  title(e: ChartEntry): string {
    if (e.name !== '') {
      return e.name;
    }
    const kind = article(this.kindName(e));
    const island = this.islandOf(e)?.name ?? '';
    return island === '' ? kind : `${kind} on ${island}`;
  }

  /** The main port's island: the world's first. */
  home(): ChartEntry | undefined {
    return this.get('island', 0);
  }
}

/** A kind's name as a phrase: "a sea arch", "an anchorage". */
export function article(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}

/** Degrees and minutes, as "67°24′". */
function degreesMinutes(deg: number): string {
  const whole = Math.floor(deg);
  let minutes = Math.round((deg - whole) * 60);
  let d = whole;
  if (minutes === 60) {
    d++;
    minutes = 0;
  }
  return `${d}°${String(minutes).padStart(2, '0')}′`;
}

/** The latitude at r m from the centre, by the sky: 90° less scale degrees a nautical mile. */
export function latitude(r: number, scale: number): number {
  return 90 - (scale * r) / NM;
}

/** A latitude as charts print it: "67°24′ N". */
export function latitudeText(r: number, scale: number): string {
  return `${degreesMinutes(Math.max(latitude(r, scale), 0))} N`;
}

/** A bearing, radians clockwise from north, as three figures: "045°". */
export function bearingText(rad: number): string {
  const deg = ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;
  return `${String(deg).padStart(3, '0')}°`;
}

/** A distance as sailors give it: nautical miles to a tenth, metres under a tenth of a mile. */
export function distanceText(m: number): string {
  if (m < 0.1 * NM) {
    return `${Math.max(Math.round(m), 0)} m`;
  }
  return `${(m / NM).toFixed(1)} NM`;
}

/**
 * Where a boat is, as the sky and the chart give it: its latitude, and its
 * bearing and distance from the main port: "67°24′ N · Port Royal 045°, 2.3 NM".
 */
export function positionText(
  east: number,
  north: number,
  scale: number,
  home: ChartEntry | undefined,
): string {
  const lat = latitudeText(Math.hypot(east, north), scale);
  if (home === undefined) {
    return lat;
  }
  const dx = east - home.east;
  const dy = north - home.north;
  return `${lat} · ${home.name} ${bearingText(Math.atan2(dx, dy))}, ${distanceText(Math.hypot(dx, dy))}`;
}

/** The pocket chart's caption: "Chart · edge 4.3 NM". */
export function edgeCaption(east: number, north: number, lip: number): string {
  return `Chart · edge ${distanceText(lip - Math.hypot(east, north))}`;
}

/** The words for a zone, where a discovery is: "at the rim". */
export function zoneWhere(zone: number): string {
  switch (zone) {
    case 2:
      return 'at the rim';
    case 1:
      return 'in the middle waters';
  }
  return 'near the main port';
}

/** The day something was charted, in the viewer's own time zone: "today", "yesterday", or its weekday. */
export function dayText(at: number, now: number, locale?: string, timeZone?: string): string {
  const fmt = (t: number) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(t);
  const day = fmt(at);
  if (day === fmt(now)) {
    return 'today';
  }
  if (day === fmt(now - 86_400_000)) {
    return 'yesterday';
  }
  return new Intl.DateTimeFormat(locale ?? 'en-GB', { weekday: 'long', timeZone }).format(at);
}

/** When, in full, in the viewer's own time: for the box. */
export function whenText(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale ?? 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(at);
}

/** "Charted by Mira, Tuesday", or "Known" for what the world began with. */
export function creditText(e: ChartEntry, now: number, timeZone?: string): string {
  if (e.by === '') {
    return 'Known';
  }
  return `Charted by ${e.by}, ${dayText(e.at, now, undefined, timeZone)}`;
}
