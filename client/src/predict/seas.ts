// SPDX-License-Identifier: AGPL-3.0-only

// The sea about the boat, as the server sends it: the two SeaAreas with the
// latest ticks, each held in one of the physics module's windows, where its
// areas' winds become the waves' amplitudes exactly as the server derives
// its own. The sea changes only on a second's first tick, and the server
// says what it changes to a second before, so the prediction, which runs a
// fraction of a second ahead, always knows the sea of the tick it steps. At
// each tick it sails in the later of the windows whose tick has come.
// An area's swell is sent only when it changes: a SeaAreas without it has
// the last one's. Its current is not sent: the module works it out at the
// area's centre from the world's way round, as the server does.
// internal/client/sea.go is its twin.

import type { SeaAreas } from '../net/messages';
import { SEA } from './layout.gen';
import type { Physics } from './physics';

interface Held {
  have: boolean;
  tick: number;
  col: number;
  row: number;
  size: number;
  /**
   * What raises each area's waves, as sent, row by row from the south-west:
   * the wind 10 m up in steps of SEA_SPEED_STEP, the direction it comes from
   * in steps of a turn / SEA.fromSteps, and the fetch in metres.
   */
  speed: Uint32Array;
  from: Uint32Array;
  fetch: Uint32Array;
  /** Each area's swell: height in centimetres, period in 0.01 s, direction, as sent. */
  swellHeight: Uint32Array;
  swellPeriod: Uint32Array;
  swellFrom: Uint32Array;
  /** Each area's current, east and north in steps of 0.01 m/s, if given with the window; else the module's. */
  current: { east: Int32Array; north: Int32Array } | null;
}

const AREAS = SEA.window * SEA.window;

export class Seas {
  /** What each of the module's windows holds. */
  readonly held: readonly Held[] = Array.from({ length: SEA.slots }, () => ({
    have: false,
    tick: 0,
    col: 0,
    row: 0,
    size: 0,
    speed: new Uint32Array(AREAS),
    from: new Uint32Array(AREAS),
    fetch: new Uint32Array(AREAS),
    swellHeight: new Uint32Array(AREAS),
    swellPeriod: new Uint32Array(AREAS),
    swellFrom: new Uint32Array(AREAS),
    current: null,
  }));
  /** The swell of the last SeaAreas that had it. */
  readonly #swellHeight = new Uint32Array(AREAS);
  readonly #swellPeriod = new Uint32Array(AREAS);
  readonly #swellFrom = new Uint32Array(AREAS);
  readonly #current = [0, 0];
  /** Counts the windows taken, so that whoever draws them knows to read them again. */
  version = 0;

  readonly #physics: Physics;

  constructor(physics: Physics) {
    this.#physics = physics;
  }

  /** Forgets what was sent. */
  reset(): void {
    for (const h of this.held) {
      h.have = false;
    }
    this.version++;
  }

  /**
   * Takes a SeaAreas: it replaces the window held for the same tick, or else
   * the one with the earlier tick. One that is malformed is let go. A
   * developer's window may give each area's current, east and north in
   * steps of 0.01 m/s, in place of the one the module works out.
   */
  receive(m: SeaAreas, current: { east: number[]; north: number[] } | null = null): void {
    const n = m.size * m.size;
    if (
      !Number.isInteger(m.size) ||
      m.size < 1 ||
      m.size > SEA.window ||
      m.speed.length !== n ||
      m.from.length !== n ||
      m.fetch.length !== n
    ) {
      return;
    }
    const sh = m.swellHeight ?? [];
    if (sh.length > 0) {
      if (sh.length !== n || m.swellPeriod?.length !== n || m.swellFrom?.length !== n) {
        return;
      }
      for (let i = 0; i < n; i++) {
        this.#swellHeight[i] = sh[i] ?? 0;
        this.#swellPeriod[i] = m.swellPeriod[i] ?? 0;
        this.#swellFrom[i] = (m.swellFrom[i] ?? 0) % SEA.fromSteps;
      }
    }
    const [a, b] = this.held as [Held, Held];
    let slot = 0;
    if (a.have && a.tick === m.tick) {
      slot = 0;
    } else if (b.have && b.tick === m.tick) {
      slot = 1;
    } else if (!a.have) {
      slot = 0;
    } else if (!b.have || b.tick < a.tick) {
      slot = 1;
    }
    const h = this.held[slot] as Held;
    h.have = true;
    h.tick = m.tick;
    h.col = m.col;
    h.row = m.row;
    h.size = m.size;
    for (let i = 0; i < n; i++) {
      h.speed[i] = m.speed[i] ?? 0;
      h.from[i] = (m.from[i] ?? 0) % SEA.fromSteps;
      h.fetch[i] = m.fetch[i] ?? 0;
      h.swellHeight[i] = this.#swellHeight[i] ?? 0;
      h.swellPeriod[i] = this.#swellPeriod[i] ?? 0;
      h.swellFrom[i] = this.#swellFrom[i] ?? 0;
    }
    h.current =
      current === null
        ? null
        : { east: Int32Array.from(current.east), north: Int32Array.from(current.north) };
    this.#apply(slot);
    this.version++;
  }

  /**
   * Gives the module's windows their currents again, after the world's way
   * round has changed.
   */
  recirculate(): void {
    for (let slot = 0; slot < this.held.length; slot++) {
      if (this.held[slot]?.have) {
        this.#apply(slot);
      }
    }
    this.version++;
  }

  /** Sets a window in the module from what it holds, each area's current its own. */
  #apply(slot: number): void {
    const h = this.held[slot] as Held;
    const p = this.#physics;
    p.seaWindow(slot, h.col, h.row, h.size);
    const n = h.size * h.size;
    for (let i = 0; i < n; i++) {
      const c =
        h.current === null
          ? p.seaCurrent(h.col + (i % h.size), h.row + Math.floor(i / h.size), this.#current)
          : [h.current.east[i] ?? 0, h.current.north[i] ?? 0];
      p.seaArea(
        slot,
        i,
        h.speed[i] ?? 0,
        h.from[i] ?? 0,
        h.fetch[i] ?? 0,
        h.swellHeight[i] ?? 0,
        h.swellPeriod[i] ?? 0,
        h.swellFrom[i] ?? 0,
        c[0] ?? 0,
        c[1] ?? 0,
      );
    }
    p.seaSeal(slot);
  }

  /**
   * The window the sea of a tick is in: the later of those whose tick has
   * come, or the earlier of two that are both to come; −1 before any.
   */
  slotAt(tick: number): number {
    let use = -1;
    for (let i = 0; i < this.held.length; i++) {
      const h = this.held[i] as Held;
      if (!h.have) {
        continue;
      }
      const u = use < 0 ? null : (this.held[use] as Held);
      if (
        u === null ||
        (h.tick <= tick && (u.tick > tick || h.tick > u.tick)) ||
        (h.tick > tick && u.tick > tick && h.tick < u.tick)
      ) {
        use = i;
      }
    }
    return use;
  }

  /** Readies the module for a step into tick: its window and its time. */
  use(tick: number): void {
    const slot = this.slotAt(tick);
    this.#physics.seaUse(slot);
    if (slot >= 0) {
      this.#physics.seaAt(tick);
    }
  }
}
