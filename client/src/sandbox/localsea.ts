// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's own sea. With no server to say what raises the waves, the
// sandbox does what the server does, by the same rules: every sea area has
// the waves its wave wind raises, the mean wind at its centre averaged over
// the last minutes, which the physics module computes from the spells in
// play as the server does; the sea changes only on a second's first tick, to
// what was fixed a second before; and the boat holds a window of areas
// about it, which follows it once it is well into another area. So a sail
// recorded here is the sail the server's tick gives in the same weather at
// the same ticks. Its swell is the server's too: each area's from the
// storms the sandbox has placed, at the keyframe boundary at or before the
// second, which the module raises from their records as the server does
// from the week's (without the land's shadow, which the sandbox's open
// water does not cast); its current the module's at the area's centre.
//
// Three things are here for looking at that the server's sea does not
// do: another fetch than open water's, a second wind east of a line of
// area centres, so that the blend between two seas can be seen, and a
// swell of the developer's own (?swell=height,period,from).

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
  /** A swell in every area, in place of the storms', or null. */
  swell: Swell | null;
}

/** A swell: its significant height in m, its peak period in s and the direction it comes from in radians. */
export interface Swell {
  height: number;
  period: number;
  from: number;
}

/** Reads ?swell=height,period,degrees-from: a swell in every area, or null. */
export function swellFromQuery(query: URLSearchParams): Swell | null {
  const raw = query.get('swell');
  if (raw === null) {
    return null;
  }
  const [height, period, from] = raw.split(',').map(Number);
  if (
    height === undefined ||
    period === undefined ||
    !Number.isFinite(height) ||
    !Number.isFinite(period) ||
    height <= 0 ||
    period <= 0
  ) {
    return null;
  }
  const deg = from !== undefined && Number.isFinite(from) ? from : 0;
  return { height, period, from: (((deg % 360) + 360) % 360) * (Math.PI / 180) };
}

/** A window's sea: each area's inputs, row by row from the south-west. */
interface Raised {
  speed: number[];
  from: number[];
  fetch: number[];
  swellHeight: number[];
  swellPeriod: number[];
  swellFrom: number[];
}

const FIELDS = ['speed', 'from', 'fetch', 'swellHeight', 'swellPeriod', 'swellFrom'] as const;

function raised(): Raised {
  return {
    speed: new Array<number>(AREAS).fill(0),
    from: new Array<number>(AREAS).fill(0),
    fetch: new Array<number>(AREAS).fill(0),
    swellHeight: new Array<number>(AREAS).fill(0),
    swellPeriod: new Array<number>(AREAS).fill(0),
    swellFrom: new Array<number>(AREAS).fill(0),
  };
}

function same(a: Raised, b: Raised): boolean {
  for (const f of FIELDS) {
    for (let i = 0; i < AREAS; i++) {
      if (a[f][i] !== b[f][i]) {
        return false;
      }
    }
  }
  return true;
}

/** The middle of the world's areas, and the last: past the world's edge the sea is the edge's. */
const MIDDLE = SEA.areas >> 1;
const LAST = SEA.areas - 1;

export class LocalSea {
  readonly options: SeaOptions = { fetch: null, split: null, flat: false, swell: null };
  /** Counts the changes of the window in effect: of its areas or of its place. */
  stamp = 0;

  readonly #physics: Physics;
  readonly #seas: Seas;
  /** The window's first area. */
  #col = 0;
  #row = 0;
  /** The sea in effect, and the one fixed for the next second. */
  #now = raised();
  #next = raised();
  /** The tick the sea was last brought to, and the first tick of its second. */
  #tick = 0;
  #from = 0;
  readonly #wind = [0, 0];
  readonly #input = [0, 0, 0];
  readonly #current = [0, 0];
  /** The keyframes' spacing, ticks: an area's swell is its storms' at the boundary at or before its second. */
  readonly #every: number;

  constructor(physics: Physics, seas: Seas, every: number) {
    this.#physics = physics;
    this.#seas = seas;
    this.#every = every;
  }

  /** The first area of the window in effect. */
  get col(): number {
    return this.#col;
  }

  get row(): number {
    return this.#row;
  }

  /** Whether the sea is one a server's would be: the weather's, over open water. */
  get plain(): boolean {
    return (
      this.options.fetch === null &&
      this.options.split === null &&
      !this.options.flat &&
      this.options.swell === null
    );
  }

  /**
   * The sea as the weather has raised it, at once: in effect and next,
   * about the boat at (east, north), from tick on.
   */
  settle(east: number, north: number, tick: number): void {
    this.#col = seaAreaOf(east) - HALF;
    this.#row = seaAreaOf(north) - HALF;
    this.#tick = tick;
    this.#from = second(tick) * SEA_PERIOD;
    this.#raise(this.#from, this.#now);
    this.#raise(this.#from + SEA_PERIOD, this.#next);
    this.#seas.reset();
    this.#send(this.#from, this.#now);
    if (!same(this.#next, this.#now)) {
      this.#send(this.#from + SEA_PERIOD, this.#next);
    }
    this.stamp++;
  }

  /**
   * Brings the sea to tick, the tick about to be stepped into, with the
   * boat at (east, north). As the server's tick does: into a new second,
   * what was fixed for it comes into effect and the wave wind fixes the
   * second after; over more than a second both are the wave wind's.
   */
  advance(tick: number, east: number, north: number): void {
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
    } else if (seconds !== 0) {
      this.#from = second(tick) * SEA_PERIOD;
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
      this.#raise(this.#from, this.#now);
      this.#raise(this.#from + SEA_PERIOD, this.#next);
      this.#send(this.#from, this.#now);
      if (!same(this.#next, this.#now)) {
        this.#send(this.#from + SEA_PERIOD, this.#next);
      }
      this.stamp++;
    } else if (seconds === 1) {
      this.#raise(this.#from + SEA_PERIOD, this.#next);
      if (!same(this.#next, this.#now)) {
        this.#send(this.#from + SEA_PERIOD, this.#next);
      }
    }
  }

  /**
   * The inputs of the window in effect, as a scenario has them: eight
   * numbers an area, its wind's three, its swell's three and its current's
   * two.
   */
  areas(): number[][] {
    const out: number[][] = [];
    const n = this.#now;
    for (let i = 0; i < AREAS; i++) {
      const c = this.#physics.seaCurrent(
        this.#col + (i % SEA.window),
        this.#row + Math.floor(i / SEA.window),
        this.#current,
      );
      out.push([
        n.speed[i] ?? 0,
        n.from[i] ?? 0,
        n.fetch[i] ?? 0,
        n.swellHeight[i] ?? 0,
        n.swellPeriod[i] ?? 0,
        n.swellFrom[i] ?? 0,
        c[0] ?? 0,
        c[1] ?? 0,
      ]);
    }
    return out;
  }

  /** Raises into a window's sea what each of its areas' wave winds gives at a tick. */
  #raise(tick: number, into: Raised): void {
    if (this.options.flat) {
      for (const f of FIELDS) {
        into[f].fill(0);
      }
      return;
    }
    const p = this.#physics;
    const fetch = this.options.fetch ?? -1;
    const split = this.options.split;
    for (let i = 0; i < AREAS; i++) {
      const col = Math.min(Math.max(this.#col + (i % SEA.window), 0), LAST);
      const row = Math.min(Math.max(this.#row + Math.floor(i / SEA.window), 0), LAST);
      let speed: number;
      let from: number;
      if (split !== null && this.#col + (i % SEA.window) >= split.column) {
        speed = split.wind.speed;
        from = split.wind.from;
      } else {
        const w = p.waveWind(
          (col - MIDDLE) * SEA.areaSize,
          (row - MIDDLE) * SEA.areaSize,
          tick,
          this.#wind,
        );
        speed = w[0] ?? 0;
        from = w[1] ?? 0;
      }
      const a = p.seaInputOf(speed, from, fetch, this.#input);
      into.speed[i] = a[0] ?? 0;
      into.from[i] = a[1] ?? 0;
      into.fetch[i] = a[2] ?? 0;
      const sw = this.#swellAt(col, row, tick);
      const s = p.swellInputOf(sw.height, sw.period, sw.from, this.#input);
      into.swellHeight[i] = s[0] ?? 0;
      into.swellPeriod[i] = s[1] ?? 0;
      into.swellFrom[i] = s[2] ?? 0;
    }
  }

  /**
   * The swell of the area at a column and row in the second of tick: the
   * developer's, or its storms' at the keyframe boundary at or before it,
   * their variances added, with the period and direction of the higher.
   */
  #swellAt(col: number, row: number, tick: number): Swell {
    const own = this.options.swell;
    if (own !== null) {
      return own;
    }
    const p = this.#physics;
    const at = Math.floor(tick / this.#every) * this.#every;
    let best: Swell = { height: 0, period: 0, from: 0 };
    let energy = 0;
    for (const r of p.systemRecords) {
      p.records.systemRecord.set(r);
      const v = p.swellAt((col - MIDDLE) * SEA.areaSize, (row - MIDDLE) * SEA.areaSize, at);
      const h = v[0] ?? 0;
      if (h > 0) {
        if (h > best.height) {
          best = { height: h, period: v[1] ?? 0, from: v[2] ?? 0 };
        }
        energy += h * h;
      }
    }
    best.height = Math.sqrt(energy);
    return best;
  }

  #send(tick: number, sea: Raised): void {
    const m: SeaAreas = {
      tick,
      col: this.#col,
      row: this.#row,
      size: SEA.window,
      speed: sea.speed.slice(),
      from: sea.from.slice(),
      fetch: sea.fetch.slice(),
      swellHeight: sea.swellHeight.slice(),
      swellPeriod: sea.swellPeriod.slice(),
      swellFrom: sea.swellFrom.slice(),
    };
    this.#seas.receive(m);
  }
}
