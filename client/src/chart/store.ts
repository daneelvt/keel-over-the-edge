// SPDX-License-Identifier: AGPL-3.0-only

// The world's chart as the page holds it: every subject charted, as the
// server tells of it, whole after each Welcome and then as each is charted;
// or, offline, as the sandbox charts it. The chart, its pocket, its list,
// the notices and the news read it. Where a boat or a place is is told as
// its latitude and longitude (position.ts).

import { signal } from '@preact/signals';
import type { ChartEntry, ChartSubject, CourseOpen } from '../net/messages';
import { formatPosition } from './position';

/** A nautical mile, m. */
export const NM = 1852;

/** A subject's key: its kind and number. */
export function keyOf(subject: ChartSubject, number: number): string {
  return `${subject}:${number}`;
}

/** What the store needs of the catalog. */
export interface ChartWords {
  /** The kinds of place's names and sites, and of feature's names, by their indices. */
  places: { name: string; site?: string }[];
  features: { name: string; symbol?: string }[];
  /** The degrees the Hub Star sinks a nautical mile out from the centre. */
  scale: number;
  /** The lip, m from the centre. */
  lip: number;
  /** A discovery worth this or more is a great one. */
  great: number;
  /** The boats' names, by their kinds' indices: what a course suits. */
  boats?: readonly string[];
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
  readonly #courses: CourseOpen[] = [];
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

  /** The island courses open for racing, in the order they opened. */
  get courses(): readonly CourseOpen[] {
    return this.#courses;
  }

  /** The entry of a subject, if it is charted. */
  get(subject: ChartSubject, number: number): ChartEntry | undefined {
    return this.#byKey.get(keyOf(subject, number));
  }

  /** Listens for what is charted: never the chart had whole. Returns what stops it listening. */
  onCharted(l: ChartedListener): () => void {
    this.#listeners.push(l);
    return () => {
      const i = this.#listeners.indexOf(l);
      if (i >= 0) {
        this.#listeners.splice(i, 1);
      }
    };
  }

  /** How many listen for what is charted. */
  get listening(): number {
    return this.#listeners.length;
  }

  /**
   * Takes entries from the server, and the courses opened: with whole, the
   * chart in full, replacing what was held (a new connection's, perhaps
   * another world's).
   */
  receive(
    entries: readonly ChartEntry[],
    whole: boolean,
    courses: readonly CourseOpen[] = [],
  ): void {
    if (whole) {
      this.#entries.length = 0;
      this.#byKey.clear();
      this.#courses.length = 0;
      this.generation++;
    }
    for (const c of courses) {
      if (!this.#courses.some((h) => h.number === c.number)) {
        this.#courses.push(c);
      }
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

  /** Whether an entry has weather of its own in its box: an island, a port or a lighthouse. */
  weathered(e: ChartEntry): boolean {
    if (e.subject === 'island') {
      return true;
    }
    const site = e.subject === 'place' ? this.words.places[e.sort]?.site : undefined;
    return site === 'harbour' || site === 'light';
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

  /** The charted island or place with a name nearest a point, or undefined: a feature is named by its island. */
  nearestNamed(east: number, north: number): ChartEntry | undefined {
    let best: ChartEntry | undefined;
    let d = Number.POSITIVE_INFINITY;
    for (const e of this.#entries) {
      if (e.subject === 'feature' || e.name === '') {
        continue;
      }
      const x = Math.hypot(e.east - east, e.north - north);
      if (x < d) {
        best = e;
        d = x;
      }
    }
    return best;
  }
}

/** A kind's name as a phrase: "a sea arch", "an anchorage". */
export function article(name: string): string {
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
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

/** A line of the chart's list: an entry, how far it is from the boat, m, and where it is, as written. */
export interface ListLine {
  entry: ChartEntry;
  distance: number;
  where: string;
}

/**
 * The chart's list for a boat at (east, north): the islands, the places
 * and the features, each nearest first, and where each is from the boat and
 * on the chart, "045° 1.2 NM · 67°24′N 045°12′". A group may be empty.
 */
export function chartList(
  entries: readonly ChartEntry[],
  east: number,
  north: number,
): { title: string; lines: ListLine[] }[] {
  const groups: { title: string; lines: ListLine[] }[] = [
    { title: 'Islands', lines: [] },
    { title: 'Places', lines: [] },
    { title: 'Features', lines: [] },
  ];
  for (const e of entries) {
    const d = Math.hypot(e.east - east, e.north - north);
    groups[e.subject === 'island' ? 0 : e.subject === 'place' ? 1 : 2]?.lines.push({
      entry: e,
      distance: d,
      where: `${bearingText(Math.atan2(e.east - east, e.north - north))} ${distanceText(d)} · ${formatPosition(e.east, e.north)}`,
    });
  }
  for (const g of groups) {
    g.lines.sort((x, y) => x.distance - y.distance);
  }
  return groups;
}

/** The kinds of course as the list names them. */
const COURSE_KINDS: Record<CourseOpen['kind'], string> = {
  round: 'Round an island',
  tour: 'Round islands',
  passage: 'Port to port',
  light: 'Round a light',
};

/** A line of the list's courses: a course open, how far its start is from the boat, m, and its words. */
export interface CourseLine {
  course: CourseOpen;
  distance: number;
  kind: string;
  /** Where its start is from the boat, and its length: "045° 1.2 NM · 2.4 NM long". */
  where: string;
  /** The boats it suits, each with her expected time: "Jolly boat 37 min · Skiff 26 min". */
  boats: string;
}

/** The courses open for a boat at (east, north), nearest start first, the boats named from boats. */
export function courseLines(
  courses: readonly CourseOpen[],
  east: number,
  north: number,
  boats: readonly string[] = [],
): CourseLine[] {
  const out: CourseLine[] = [];
  for (const c of courses) {
    const start = c.way[0] ?? [0, 0];
    const d = Math.hypot(start[0] - east, start[1] - north);
    out.push({
      course: c,
      distance: d,
      kind: COURSE_KINDS[c.kind],
      where: `${bearingText(Math.atan2(start[0] - east, start[1] - north))} ${distanceText(d)} · ${distanceText(c.length)} long`,
      boats: c.boats
        .map((b) => `${boats[b.kind] ?? 'Boat'} ${Math.max(Math.round(b.seconds / 60), 1)} min`)
        .join(' · '),
    });
  }
  return out.sort((x, y) => x.distance - y.distance);
}

/** The middle of a course's way and how far a camera stands back to see it whole, m. */
export function courseFrame(c: CourseOpen): { east: number; north: number; distance: number } {
  let w = Number.POSITIVE_INFINITY;
  let s = Number.POSITIVE_INFINITY;
  let e = Number.NEGATIVE_INFINITY;
  let n = Number.NEGATIVE_INFINITY;
  for (const [x, y] of c.way) {
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
  }
  if (!Number.isFinite(w)) {
    return { east: 0, north: 0, distance: 4000 };
  }
  return { east: (w + e) / 2, north: (s + n) / 2, distance: Math.max(e - w, n - s) * 2.4 + 1500 };
}

/** How far the edge is, as the pocket chart's caption says it: "edge 4.3 NM". */
export function edgeCaption(east: number, north: number, lip: number): string {
  return `edge ${distanceText(lip - Math.hypot(east, north))}`;
}

/**
 * The pocket chart's caption, its lines each within the chart, and the
 * name its button says: how far the edge is ("" before the boat's first
 * position, when the line is kept empty), and beneath it the time until
 * the new world ("" with no end known, when there is no second line). The
 * chart's own name is said, never shown.
 */
export function pocketCaption(edge: string, left: string): { lines: string[]; name: string } {
  const until = left === '' ? '' : `new world ${left}`;
  return {
    lines: until === '' ? [edge] : [edge, until],
    name: `${['Chart', edge, until].filter((l) => l !== '').join(', ')}: open the chart`,
  };
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
