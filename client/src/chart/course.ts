// SPDX-License-Identifier: AGPL-3.0-only

// The course: one point the sailor sails for, set on the chart. It is
// anything charted (an island, a place, a feature), a race course's start,
// or a pin on open water; or, set from the shipmates' panel or the machine
// sailors', a sailor's boat: a shipmate at sea, or one of the player's own
// machine sailors. Setting one replaces the last. It is a bearing
// and a distance from the boat, never a steering order: the boat is sailed
// to it, upwind by tacking, as every other way is. Its point is where the
// charted thing is, or for an island the nearest of its land's bounds, so
// a large island is reached at its shore, not its middle. Within a tenth
// of a mile of its point it is reached, and clears. It is kept on the
// phone for the week's world it was set in: a reload or a new voyage keeps
// it, another world drops it, since its places are not yet charted there.
//
// Each kind of course says where its point is now from what the phone
// holds. A boat's is where the server last said it was, every two
// seconds, moved on between by the way it made from the one before; until
// the server first says, it is nowhere, and nothing shows.

import type { ChartSubject, CourseOpen } from '../net/messages';
import { PIN, startName, startReached, YOUR_PIN } from './coursewords';
import { type ChartStore, NM } from './store';

/** A course set: what it is, by its kind. */
export type Course =
  | { kind: 'entry'; subject: ChartSubject; number: number }
  | { kind: 'start'; course: number }
  | { kind: 'pin'; east: number; north: number }
  /** A sailor's boat, by their account: a shipmate's, or (machine) the player's own machine sailor's. */
  | { kind: 'boat'; sailor: string; name: string; machine: boolean };

/** A boat's place as the server told it, m, and when it was told, ms. */
interface Fix {
  east: number;
  north: number;
  at: number;
}

/** How far ahead of the last fix a boat is moved on, ms: past it, it is held where it was last told. */
const AHEAD = 4000;

/** Fixes further apart than this, ms, give no way to move on by. */
const APART = 6000;

/** Faster than this between two fixes, m/s, a boat has not sailed but moved (back to port, swapped): held. */
const FASTEST = 25;

/**
 * Where the boat a course is set to was told to be, the last two times:
 * between the server's two-second fixes, the pin moves on by the way the
 * boat made from one to the next.
 */
export class BoatFixes {
  #sailor = '';
  #last: Fix | null = null;
  #before: Fix | null = null;
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** The boat of sailor was told at (east, north) now. */
  take(sailor: string, east: number, north: number): void {
    if (sailor !== this.#sailor) {
      this.forget();
      this.#sailor = sailor;
    }
    this.#before = this.#last;
    this.#last = { east, north, at: this.#now() };
  }

  /** Forgets every fix: a course to another, or none. */
  forget(): void {
    this.#sailor = '';
    this.#last = null;
    this.#before = null;
  }

  /** Where sailor's boat is now, as the fixes have it; null before the first. */
  where(sailor: string): { east: number; north: number } | null {
    const l = this.#last;
    if (l === null || sailor !== this.#sailor) {
      return null;
    }
    const b = this.#before;
    const gap = b === null ? 0 : l.at - b.at;
    if (
      b === null ||
      gap <= 0 ||
      gap > APART ||
      (Math.hypot(l.east - b.east, l.north - b.north) * 1000) / gap > FASTEST
    ) {
      return { east: l.east, north: l.north };
    }
    const ahead = Math.min(Math.max(this.#now() - l.at, 0), AHEAD) / gap;
    return {
      east: l.east + (l.east - b.east) * ahead,
      north: l.north + (l.north - b.north) * ahead,
    };
  }
}

/** Within this of its point, m, a course is reached: inside the sight of every place, short of a reef. */
export const ARRIVE = 0.1 * NM;

/** A course's point as the phone has it now. */
export interface CoursePoint {
  /** Where it is, m east and north of the centre. */
  east: number;
  north: number;
  /** An island's land's bounds, m (west, south, east, north): reached at their nearest; null for a point. */
  bounds: readonly [number, number, number, number] | null;
  /** Its name on the chart and in the sea: "Gull Rock", "Pin". */
  name: string;
  /** Its name as an arrival says it: "Gull Rock", "your pin". */
  reached: string;
}

/** A course from the boat: where it points, how far, and its names. */
export interface CourseAim {
  /** The point aimed at, m: the course's, or the nearest of an island's bounds. */
  east: number;
  north: number;
  /** How far, m, and its bearing, rad clockwise from north. */
  distance: number;
  bearing: number;
  name: string;
  reached: string;
}

/** The race course open by its number, if the chart has it. */
function courseOf(store: ChartStore, n: number): CourseOpen | undefined {
  return store.courses.find((c) => c.number === n);
}

/**
 * A course's point now, from the chart held and, for a boat, its fixes:
 * null while what it names is not charted, or a boat not yet told.
 */
export function coursePoint(
  c: Course,
  store: ChartStore,
  boats: BoatFixes | null = null,
): CoursePoint | null {
  switch (c.kind) {
    case 'entry': {
      const e = store.get(c.subject, c.number);
      if (e === undefined) {
        return null;
      }
      const name = store.title(e);
      return { east: e.east, north: e.north, bounds: e.bounds, name, reached: name };
    }
    case 'start': {
      const k = courseOf(store, c.course);
      const at = k?.way[0];
      if (k === undefined || at === undefined) {
        return null;
      }
      return {
        east: at[0],
        north: at[1],
        bounds: null,
        name: startName(k),
        reached: startReached(k),
      };
    }
    case 'pin':
      return { east: c.east, north: c.north, bounds: null, name: PIN, reached: YOUR_PIN };
    case 'boat': {
      const at = boats?.where(c.sailor) ?? null;
      return at === null ? null : { ...at, bounds: null, name: c.name, reached: c.name };
    }
  }
}

/** The point to aim at from (east, north): the course's own, or the nearest of an island's bounds. */
export function aimPoint(
  p: CoursePoint,
  east: number,
  north: number,
): { east: number; north: number } {
  if (p.bounds === null) {
    return { east: p.east, north: p.north };
  }
  const [w, s, e, n] = p.bounds;
  return { east: Math.min(Math.max(east, w), e), north: Math.min(Math.max(north, s), n) };
}

/** A course from a boat at (east, north): null while its point is not charted. */
export function courseAim(
  c: Course,
  store: ChartStore,
  east: number,
  north: number,
  boats: BoatFixes | null = null,
): CourseAim | null {
  const p = coursePoint(c, store, boats);
  if (p === null) {
    return null;
  }
  const at = aimPoint(p, east, north);
  const dx = at.east - east;
  const dy = at.north - north;
  return {
    east: at.east,
    north: at.north,
    distance: Math.hypot(dx, dy),
    bearing: Math.atan2(dx, dy),
    name: p.name,
    reached: p.reached,
  };
}

/** The turn from a heading to a bearing, both rad: degrees, −180 (to port) to 180 (to starboard). */
export function turnOf(bearing: number, heading: number): number {
  const d = ((bearing - heading) * 180) / Math.PI;
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Whether a course from the boat is reached. */
export function reached(a: CourseAim): boolean {
  return a.distance <= ARRIVE;
}

/** Whether two courses are the same. */
export function sameCourse(a: Course | null, b: Course | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  switch (a.kind) {
    case 'entry':
      return b.kind === 'entry' && a.subject === b.subject && a.number === b.number;
    case 'start':
      return b.kind === 'start' && a.course === b.course;
    case 'pin':
      return b.kind === 'pin' && a.east === b.east && a.north === b.north;
    case 'boat':
      return b.kind === 'boat' && a.sailor === b.sailor;
  }
}

/** What localStorage offers; tests stand in for it. */
export interface CourseKeep {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Where the course is kept, with the world it was set in. */
const KEY = 'keel.course';

/** The phone's localStorage, or null where it is refused. */
export function defaultKeep(): CourseKeep | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const SUBJECTS: readonly ChartSubject[] = ['island', 'place', 'feature'];

/** A course read back, if it is one. */
function courseFrom(raw: unknown): Course | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (r.kind) {
    case 'entry':
      return SUBJECTS.includes(r.subject as ChartSubject) && whole(r.number)
        ? { kind: 'entry', subject: r.subject as ChartSubject, number: r.number }
        : null;
    case 'start':
      return whole(r.course) ? { kind: 'start', course: r.course } : null;
    case 'pin':
      return finite(r.east) && finite(r.north)
        ? { kind: 'pin', east: r.east, north: r.north }
        : null;
    case 'boat':
      return typeof r.sailor === 'string' &&
        r.sailor !== '' &&
        typeof r.name === 'string' &&
        typeof r.machine === 'boolean'
        ? { kind: 'boat', sailor: r.sailor, name: r.name, machine: r.machine }
        : null;
  }
  return null;
}

/** The course kept for a world: null for none, or one kept for another world. */
export function loadCourse(world: string, keep: CourseKeep | null): Course | null {
  try {
    const text = keep?.getItem(KEY) ?? null;
    const raw = text === null ? null : (JSON.parse(text) as unknown);
    if (raw === null || typeof raw !== 'object') {
      return null;
    }
    const r = raw as Record<string, unknown>;
    return r.world === world ? courseFrom(r.course) : null;
  } catch {
    return null;
  }
}

/** Keeps a world's course, or with null forgets it; whether the store took it. */
export function saveCourse(world: string, c: Course | null, keep: CourseKeep | null): boolean {
  try {
    if (keep === null) {
      return false;
    }
    if (c === null) {
      keep.removeItem(KEY);
    } else {
      keep.setItem(KEY, JSON.stringify({ world, course: c }));
    }
    return true;
  } catch {
    return false;
  }
}
