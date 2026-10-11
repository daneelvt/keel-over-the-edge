// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own sea. With no server to say what raises the waves, the
// sandbox does what the server does, by the same rules: every sea area has
// the wind's waves; the sea changes only on a second's first tick, to what
// was fixed a second before from the wind as it then stood; and the boat
// holds a window of areas about it, which follows it once it is well into
// another area. So a sail recorded here is the sail the server's tick
// gives from the same winds at the same ticks.
//
// Two things the server's sea cannot do yet are here for looking at:
// another fetch than open water's, and a second wind east of a line of area
// centres, so that the blend between two seas can be seen.

import type { Wind } from '../game/driver';
import type { SeaAreas } from '../net/messages';
import { SEA } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';

/** Ticks the sea holds between changes: a second. */
export const SEA_PERIOD = 30;
/** How far past an area's edge the boat sails before its window follows, m. */
const SLACK = 60;
const AREAS = SEA.window * SEA.window;
const HALF = SEA.window >> 1;

/** The column of the area whose centre is nearest a point x metres east, or the row nearest one that far north. */
export function seaAreaOf(v: number): number {
  return Math.floor(v / SEA.areaSize + ((SEA.areas >> 1) + 0.5));
}

function second(tick: number): number {
  return Math.floor(tick / SEA_PERIOD);
}

/** What the developer may change of the sandbox's sea. */
export interface SeaOptions {
  /** The fetch, in metres, or null for open water's. */
  fetch: number | null;
  /** A second wind, for the areas from column `column` eastward, or null. */
  split: { column: number; wind: Wind } | null;
  /** No waves at all, whatever the wind: flat water. */
  flat: boolean;
}

/** A sea of two winds at most: the inputs of the areas west of the split, and of those east of it. */
interface Raised {
  west: number[];
  east: number[];
}

function same(a: Raised, b: Raised): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.west[i] !== b.west[i] || a.east[i] !== b.east[i]) {
      return false;
    }
  }
  return true;
}

export class LocalSea {
  readonly options: SeaOptions = { fetch: null, split: null, flat: false };
  /** Counts the changes of the window in effect: of its areas or of its place. */
  stamp = 0;

  readonly #physics: Physics;
  readonly #seas: Seas;
  /** The window's first area. */
  #col = 0;
  #row = 0;
  /** The sea in effect, and the one fixed for the next second. */
  #now: Raised = { west: [0, 0, 0], east: [0, 0, 0] };
  #next: Raised = { west: [0, 0, 0], east: [0, 0, 0] };
  /** The tick the sea was last brought to, and the first tick of its second. */
  #tick = 0;
  #from = 0;

  constructor(physics: Physics, seas: Seas) {
    this.#physics = physics;
    this.#seas = seas;
  }

  /** The first area of the window in effect. */
  get col(): number {
    return this.#col;
  }

  get row(): number {
    return this.#row;
  }

  /** Whether the sea is one a server's would be: one wind over open water. */
  get plain(): boolean {
    return this.options.fetch === null && this.options.split === null && !this.options.flat;
  }

  /**
   * The sea as the wind has raised it, at once: in effect and next alike,
   * about the boat at (east, north), from tick on.
   */
  settle(wind: Wind, east: number, north: number, tick: number): void {
    this.#raise(wind, this.#now);
    this.#raise(wind, this.#next);
    this.#col = seaAreaOf(east) - HALF;
    this.#row = seaAreaOf(north) - HALF;
    this.#tick = tick;
    this.#from = second(tick) * SEA_PERIOD;
    this.#seas.reset();
    this.#send(this.#from, this.#now);
    this.stamp++;
  }

  /**
   * Brings the sea to tick, the tick about to be stepped into, given the
   * wind as it stood at the tick before and where the boat is. As the
   * server's tick does: into a new second, what was fixed for it comes into
   * effect and the wind fixes the second after; over more than a second the
   * wind has had its time already.
   */
  advance(tick: number, windBefore: Wind, east: number, north: number): void {
    const seconds = second(tick) - second(this.#tick);
    this.#tick = tick;
    let again = false;
    if (seconds === 1) {
      this.#from = second(tick) * SEA_PERIOD;
      const was = this.#now;
      this.#now = this.#next;
      this.#next = was;
      if (!same(was, this.#now)) {
        // Sent a second ago, and now in effect.
        this.stamp++;
      }
      this.#raise(windBefore, this.#next);
      if (!same(this.#next, this.#now)) {
        this.#send(this.#from + SEA_PERIOD, this.#next);
      }
    } else if (seconds !== 0) {
      this.#from = second(tick) * SEA_PERIOD;
      this.#raise(windBefore, this.#now);
      this.#raise(windBefore, this.#next);
      again = true;
    }
    // The window follows the boat once it is well into another area.
    const cx = this.#col + HALF;
    const cy = this.#row + HALF;
    if (seaAreaOf(east - SLACK) > cx || seaAreaOf(east + SLACK) < cx) {
      this.#col = seaAreaOf(east) - HALF;
      again = true;
    }
    if (seaAreaOf(north - SLACK) > cy || seaAreaOf(north + SLACK) < cy) {
      this.#row = seaAreaOf(north) - HALF;
      again = true;
    }
    if (again) {
      this.#send(this.#from, this.#now);
      if (!same(this.#next, this.#now)) {
        this.#send(this.#from + SEA_PERIOD, this.#next);
      }
      this.stamp++;
    }
  }

  /** The inputs of the window in effect, three numbers an area, as a scenario has them. */
  areas(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < AREAS; i++) {
      const a = this.#area(this.#now, i);
      out.push([a[0] ?? 0, a[1] ?? 0, a[2] ?? 0]);
    }
    return out;
  }

  #raise(wind: Wind, into: Raised): void {
    if (this.options.flat) {
      into.west.fill(0);
      into.east.fill(0);
      return;
    }
    const fetch = this.options.fetch ?? -1;
    this.#physics.seaInputOf(wind.speed, wind.from, fetch, into.west);
    const other = this.options.split?.wind ?? wind;
    this.#physics.seaInputOf(other.speed, other.from, fetch, into.east);
  }

  #area(sea: Raised, i: number): number[] {
    const split = this.options.split;
    return split !== null && this.#col + (i % SEA.window) >= split.column ? sea.east : sea.west;
  }

  #send(tick: number, sea: Raised): void {
    const m: SeaAreas = {
      tick,
      col: this.#col,
      row: this.#row,
      size: SEA.window,
      speed: [],
      from: [],
      fetch: [],
    };
    for (let i = 0; i < AREAS; i++) {
      const a = this.#area(sea, i);
      m.speed.push(a[0] ?? 0);
      m.from.push(a[1] ?? 0);
      m.fetch.push(a[2] ?? 0);
    }
    this.#seas.receive(m);
  }
}
