// SPDX-License-Identifier: AGPL-3.0-only

// A gale warning's notice: raised once a warning, when the forecast's gale
// comes near the boat, its words the Met Office's, "Gale warning:
// southwesterly gale 8 expected soon, south-west of Gannet Holm", where it
// blows named from the shared chart, so everyone's notice names the same
// place. Near is the forecast's synoptic gale, as the chart hatches it, at
// any minute of the latest issue's reach still to come, within 1.5 NM of
// the boat or across the course the sailor steered for a system from its
// box. A gale elsewhere is hatched on the chart, and named in the places'
// boxes, on the boards and in the news, but raises no notice: with a storm
// on the disk half the time, a warning for every gale would mean nothing.

import { catalog } from '../catalog';
import type { ForecastTold } from '../net/messages';
import { type Fields, issueOf } from '../predict/forecast';
import type { Notices } from '../ui/notices';
import { warningOf } from './placeweather';
import type { ChartStore } from './store';
import { untilOf } from './weather';
import { warningParts, wordsOf } from './words';

const MINUTE = 60 * 30;

/** A gale within this of the boat raises its notice, m. */
export const GALE_NEAR = 1.5 * 1852;

/** A point of the forecast's gale: where, m, and when, the world's tick. */
export interface GalePoint {
  east: number;
  north: number;
  tick: number;
}

/** A point on the water, m. */
interface Point {
  east: number;
  north: number;
}

/** What the notices read of the boat and the forecast. */
export interface GaleWatch {
  /** The forecast's module, or null while it is made. */
  fields(): Fields | null;
  /** The forecast's module, made if it is not. */
  made(): Promise<Fields>;
  /** The world's tick now. */
  tick(): number;
  /** Where the boat is. */
  boat(): Point;
  /** Where the course steered for a tapped system meets it, while the autopilot holds that course; null for none. */
  course(): Point | null;
}

/** The forecast's gale at each minute of its reach from its issue: the grid's points in a gale, as the chart hatches them. */
export function galePoints(fields: Fields, f: ForecastTold, spacing: number): GalePoint[] {
  const out: GalePoint[] = [];
  const until = untilOf(f);
  const side = fields.physics.galeSide();
  const c = (side - 1) / 2;
  for (let tick = issueOf(f); tick <= until; tick += MINUTE) {
    const on = fields.galeAt(f, tick).on;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        if (on[j * side + i] === 1) {
          out.push({ east: (i - c) * spacing, north: (j - c) * spacing, tick });
        }
      }
    }
  }
  return out;
}

/** How far a point is from the segment from a to b, m. */
function fromSegment(p: Point, a: Point, b: Point): number {
  const dx = b.east - a.east;
  const dy = b.north - a.north;
  const l2 = dx * dx + dy * dy;
  const t =
    l2 > 0 ? Math.min(Math.max(((p.east - a.east) * dx + (p.north - a.north) * dy) / l2, 0), 1) : 0;
  return Math.hypot(p.east - (a.east + t * dx), p.north - (a.north + t * dy));
}

/**
 * Whether a gale still to come is near: at a point within GALE_NEAR of the
 * boat, or within the gale grid's spacing of the course from the boat to
 * where it meets a system. Points over a minute before now are past.
 */
export function galeNear(
  points: readonly GalePoint[],
  now: number,
  boat: Point,
  course: Point | null,
  spacing: number,
): boolean {
  for (const p of points) {
    if (p.tick < now - MINUTE) {
      continue;
    }
    if (Math.hypot(p.east - boat.east, p.north - boat.north) <= GALE_NEAR) {
      return true;
    }
    if (course !== null && fromSegment(p, boat, course) <= spacing) {
      return true;
    }
  }
  return false;
}

export class GaleNotices {
  readonly #store: ChartStore;
  readonly #notices: Notices;
  readonly #watch: GaleWatch;
  readonly #now: () => number;
  readonly #spacing = catalog.weather.forecast.gale.grid * 1852;
  /** The warnings told of, by their keys. */
  readonly #told = new Set<number>();
  /** The latest issue, and its gale's points once worked out. */
  #issue: ForecastTold | null = null;
  #points: GalePoint[] | null = null;

  constructor(
    store: ChartStore,
    notices: Notices,
    watch: GaleWatch,
    now: () => number = () => performance.now(),
  ) {
    this.#store = store;
    this.#notices = notices;
    this.#watch = watch;
    this.#now = now;
  }

  /** Takes an issue: its gale, if near, raises a notice not raised for its warning yet. */
  issued(f: ForecastTold): void {
    this.#issue = f;
    this.#points = null;
    this.check();
  }

  /** Looks again whether the latest issue's gale is near, as the boat moves: its timer's, and each issue's. */
  check(): void {
    const f = this.#issue;
    const g = f?.gale ?? null;
    if (f === null || g === null || this.#told.has(g.key)) {
      return;
    }
    if (this.#points === null) {
      const fields = this.#watch.fields();
      if (fields === null) {
        // Looked at again once the module is made.
        void this.#watch.made().then(() => this.check());
        return;
      }
      this.#points = galePoints(fields, f, this.#spacing);
    }
    const w = this.#watch;
    if (!galeNear(this.#points, w.tick(), w.boat(), w.course(), this.#spacing)) {
      return;
    }
    this.#told.add(g.key);
    const p = warningParts(warningOf(g, this.#store), wordsOf(catalog.weather));
    this.#notices.raise('gale-warned', { wind: p.wind, when: p.when, where: p.where }, this.#now());
  }

  /** Forgets the warnings told of: a new world's. */
  reset(): void {
    this.#told.clear();
    this.#issue = null;
    this.#points = null;
  }
}
