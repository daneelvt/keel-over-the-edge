// SPDX-License-Identifier: AGPL-3.0-only

// The other boats' wakes as the prediction approximates them. The server
// steps each boat in the shadow of the wakes the boats near it left a tick
// before; the page knows those boats only from the snapshots' samples. For
// each boat in the near band it keeps the newest two samples; before a step
// into tick t it offers the module the wakes of the ENCOUNTERS.wakes
// nearest, each where its samples put it at t − 1 (between them, or carried
// on past the newest at the speed between them), heading and heeled as the
// newest says, in the wind at that place and tick. The difference from the
// server's shadow is corrected as any other. internal/client/wakes.go is
// its twin, bit for bit: the Go client's traces replay here.

import { CHANGE, FLEET_META, SLOT, slotAt, VIEW_SLOTS } from '../net/view';
import { ENCOUNTERS, RECORDS, SIZES } from './layout.gen';
import type { Physics } from './physics';

const S = RECORDS.state;
const W = RECORDS.wind;
const TICKS_PER_SECOND = 30;

export class Wakes {
  /** Samples held per view slot: 0, 1 or 2. */
  readonly #n = new Uint8Array(VIEW_SLOTS);
  /** The newest sample's and the one before's tick, east and north. */
  readonly #tick = new Float64Array(VIEW_SLOTS * 2);
  readonly #x = new Float64Array(VIEW_SLOTS * 2);
  readonly #y = new Float64Array(VIEW_SLOTS * 2);
  /** The newest's heading, heel and boom. */
  readonly #pose = new Float64Array(VIEW_SLOTS * 3);
  readonly #order = new Int32Array(VIEW_SLOTS);
  readonly #d2 = new Float64Array(VIEW_SLOTS);
  readonly #physics: Physics;
  /** How many wakes reached the boat at the last step, for the developer panel. */
  reaching = 0;

  constructor(physics: Physics) {
    this.#physics = physics;
  }

  /** Forgets every boat: a new connection. */
  reset(): void {
    this.#n.fill(0);
  }

  /**
   * Takes a snapshot's fleet record: the boats it samples in the near band
   * gain a sample; a slot a boat entered starts afresh; one left, or in the
   * far band, holds none.
   */
  observe(f: Float64Array): void {
    const tick = f[FLEET_META.tick] ?? 0;
    for (let i = 0; i < VIEW_SLOTS; i++) {
      const o = slotAt(i);
      const present = f[o + SLOT.present] === 1;
      const change = f[o + SLOT.change];
      if (change === CHANGE.left || change === CHANGE.entered || !present) {
        this.#n[i] = 0;
      }
      if (!present) {
        continue;
      }
      if (f[o + SLOT.far] !== 0) {
        this.#n[i] = 0;
        continue;
      }
      if (f[o + SLOT.sampled] !== 1) {
        continue;
      }
      this.#tick[2 * i + 1] = this.#tick[2 * i] ?? 0;
      this.#x[2 * i + 1] = this.#x[2 * i] ?? 0;
      this.#y[2 * i + 1] = this.#y[2 * i] ?? 0;
      this.#tick[2 * i] = tick;
      this.#x[2 * i] = f[o + SLOT.x] ?? 0;
      this.#y[2 * i] = f[o + SLOT.y] ?? 0;
      this.#pose[3 * i] = f[o + SLOT.heading] ?? 0;
      this.#pose[3 * i + 1] = f[o + SLOT.heel] ?? 0;
      this.#pose[3 * i + 2] = f[o + SLOT.boom] ?? 0;
      this.#n[i] = Math.min((this.#n[i] ?? 0) + 1, 2);
    }
  }

  /**
   * Changes the module's env, the wind at its state's place for a step into
   * tick, by the shadow of the nearest boats as they were at tick − 1. Call
   * it after the wind is set and before the step.
   */
  use(tick: number): void {
    const p = this.#physics;
    const state = p.records.state;
    const x = state[S.x] ?? 0;
    const y = state[S.y] ?? 0;
    let n = 0;
    for (let i = 0; i < VIEW_SLOTS; i++) {
      if (this.#n[i] === 0) {
        continue;
      }
      const dx = (this.#x[2 * i] ?? 0) - x;
      const dy = (this.#y[2 * i] ?? 0) - y;
      this.#d2[i] = dx * dx + dy * dy;
      this.#order[n++] = i;
    }
    this.reaching = 0;
    if (n === 0) {
      return;
    }
    // The nearest first, ties to the lower slot.
    const order = this.#order;
    const d2 = this.#d2;
    for (let i = 1; i < n; i++) {
      for (let j = i; j > 0 && (d2[order[j] ?? 0] ?? 0) < (d2[order[j - 1] ?? 0] ?? 0); j--) {
        const t = order[j] ?? 0;
        order[j] = order[j - 1] ?? 0;
        order[j - 1] = t;
      }
    }
    n = Math.min(n, ENCOUNTERS.wakes);
    const at = tick - 1;
    p.windDrawAt(at);
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      let px = this.#x[2 * i] ?? 0;
      let py = this.#y[2 * i] ?? 0;
      let vx = 0;
      let vy = 0;
      const t0 = this.#tick[2 * i] ?? 0;
      const t1 = this.#tick[2 * i + 1] ?? 0;
      if (this.#n[i] === 2 && t0 > t1) {
        const span = t0 - t1;
        const ux = (px - (this.#x[2 * i + 1] ?? 0)) / span;
        const uy = (py - (this.#y[2 * i + 1] ?? 0)) / span;
        const dt = at - t0;
        px = px + ux * dt;
        py = py + uy * dt;
        vx = ux * TICKS_PER_SECOND;
        vy = uy * TICKS_PER_SECOND;
      }
      const wind = p.windPoint(px, py);
      const speed = wind[W.speed] ?? 0;
      const from = wind[W.from] ?? 0;
      const w = p.wakeOf(
        px,
        py,
        this.#pose[3 * i] ?? 0,
        this.#pose[3 * i + 1] ?? 0,
        this.#pose[3 * i + 2] ?? 0,
        vx,
        vy,
        speed,
        from,
      );
      p.wakes.set(w, k * SIZES.wake);
    }
    this.reaching = p.shadowAt(n);
  }
}
