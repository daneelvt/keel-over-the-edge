// SPDX-License-Identifier: AGPL-3.0-only

// The sea about the boat, as the server sends it: the two SeaAreas with the
// latest ticks, each held in one of the physics module's windows, where its
// areas' winds become the waves' amplitudes exactly as the server derives
// its own. The sea changes only on a second's first tick, and the server
// says what it changes to a second before, so the prediction, which runs a
// fraction of a second ahead, always knows the sea of the tick it steps. At
// each tick it sails in the later of the windows whose tick has come.
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
}

export class Seas {
  /** What each of the module's windows holds. */
  readonly held: readonly Held[] = Array.from({ length: SEA.slots }, () => ({
    have: false,
    tick: 0,
    col: 0,
    row: 0,
    size: 0,
  }));
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
   * the one with the earlier tick. One that is malformed is let go.
   */
  receive(m: SeaAreas): void {
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
    const p = this.#physics;
    p.seaWindow(slot, m.col, m.row, m.size);
    for (let i = 0; i < n; i++) {
      p.seaArea(slot, i, m.speed[i] ?? 0, (m.from[i] ?? 0) % SEA.fromSteps, m.fetch[i] ?? 0);
    }
    p.seaSeal(slot);
    this.version++;
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
