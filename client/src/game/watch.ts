// SPDX-License-Identifier: AGPL-3.0-only

// The watching driver: another sailor's boat, drawn as the player's own
// is, from the snapshots' headers, which hold the watched boat. Nothing is
// predicted and nothing steers: each header is kept, and the boat is drawn
// between the two either side of the near band's render tick, the one the
// boats about it are drawn at (fleet.ts), so the watched boat and those
// near it share one timeline. Its Out record, what the instruments read,
// is one step of the physics module from each header's state with the
// controls in force, in the wind, sea and wakes of that tick, as the
// server steps it; the one drawn is the newest header's at or before the
// render tick, never ahead of it. The game's frame loop never steps it:
// Online sets it to the render tick each frame.

import type { PilotControl } from '../input/pilot';
import type { OwnSnapshot } from '../net/snapshot';
import { lerpAngle, StatePair } from '../predict/blend';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Physics } from '../predict/physics';
import type { Seas } from '../predict/seas';
import type { Wakes } from '../predict/wakes';
import { type BoatWind, newBoatWind, type Spells } from '../predict/weather';
import type { BoatDriver } from './driver';

/** Headers kept: at 15 a second, a second of them. */
export const WATCH_KEPT = 16;

const S = RECORDS.state;
const N = SIZES.state;
const OUT = SIZES.out;
/** The state's fields that are counted, not measured: taken from the nearer header, not blended. */
const COUNTED: readonly number[] = [S.sailorMode, S.pilotWay, S.pilotOrder];

export class WatchDriver implements BoatDriver {
  readonly states = new StatePair();
  readonly out = new Float64Array(OUT);
  readonly wind: BoatWind = newBoatWind();
  /** A header has come since the watch began. */
  started = false;
  /** The tick the drawn boat went over the lip, 0 while afloat; the times it was back at the start. */
  over = 0;
  restarts = 0;
  /** The autopilot's word in force as drawn: the screen reads it, nothing steers by it. */
  readonly pilot: { -readonly [K in keyof PilotControl]: number } = {
    mode: 0,
    target: 0,
    order: 0,
    way: 0,
  };
  /** The helm's and sheet's indices in force as drawn. */
  helm = 512;
  sheet = 512;

  readonly #physics: Physics;
  readonly #seas: Seas;
  readonly #weather: Spells;
  readonly #wakes: Wakes;
  readonly #ticks = new Float64Array(WATCH_KEPT);
  readonly #states = new Float64Array(WATCH_KEPT * N);
  readonly #outs = new Float64Array(WATCH_KEPT * OUT);
  readonly #winds = Array.from({ length: WATCH_KEPT }, newBoatWind);
  /** Each header's control and pilot words: helm, sheet, mode, target, order, way; and its fall. */
  readonly #words = new Float64Array(WATCH_KEPT * 7);
  #count = 0;
  #next = 0;
  /** The header whose Out is drawn, by its tick. */
  #drawn = -1;

  constructor(physics: Physics, seas: Seas, weather: Spells, wakes: Wakes) {
    this.#physics = physics;
    this.#seas = seas;
    this.#weather = weather;
    this.#wakes = wakes;
  }

  get physics(): Physics {
    return this.#physics;
  }

  get seas(): Seas {
    return this.#seas;
  }

  get weather(): Spells {
    return this.#weather;
  }

  /** The newest header's tick, or NaN before the first. */
  get newest(): number {
    return this.#count === 0 ? Number.NaN : (this.#ticks[this.#at(0)] ?? 0);
  }

  /** Nothing steers a boat watched. */
  step(): void {}

  /**
   * Holds the boat as another driver last drew it, until a header comes:
   * the own boat's last place, as it leaves the water to watch.
   */
  holdFrom(d: BoatDriver): void {
    this.states.previous.set(d.states.previous);
    this.states.current.set(d.states.current);
    this.out.set(d.out);
    Object.assign(this.wind, d.wind);
  }

  /** Forgets every header: another boat, or the same one watched again. */
  reset(): void {
    this.started = false;
    this.#count = 0;
    this.#next = 0;
    this.#drawn = -1;
    this.over = 0;
  }

  /** The k-th newest header's slot. */
  #at(k: number): number {
    return (this.#next - 1 - k + 2 * WATCH_KEPT) % WATCH_KEPT;
  }

  /**
   * Keeps a header, with its Out from one step of the module from its
   * state; one of a tick already held replaces it (a resync's), and an
   * older one is let go.
   */
  receive(sn: OwnSnapshot): void {
    if (this.#count > 0) {
      const newest = this.#ticks[this.#at(0)] ?? 0;
      if (sn.tick < newest) {
        return;
      }
      if (sn.tick === newest) {
        this.#next = this.#at(0);
        this.#count--;
      }
    }
    const i = this.#next;
    this.#ticks[i] = sn.tick;
    this.#states.set(sn.state.subarray(0, N), i * N);
    const w = this.#words;
    w[i * 7] = sn.helm;
    w[i * 7 + 1] = sn.sheet;
    w[i * 7 + 2] = sn.mode;
    w[i * 7 + 3] = sn.target;
    w[i * 7 + 4] = sn.order;
    w[i * 7 + 5] = sn.way;
    w[i * 7 + 6] = sn.over;
    const wind = this.#winds[i] as BoatWind;
    if (sn.over === 0 && !sn.stays) {
      this.#stepFrom(sn, wind);
      this.#outs.set(this.#physics.records.out, i * OUT);
    } else if (this.#count > 0) {
      // Falling or held where it is: the last Out and wind stand.
      const j = this.#at(0);
      this.#outs.copyWithin(i * OUT, j * OUT, j * OUT + OUT);
      Object.assign(wind, this.#winds[j]);
    }
    this.#next = (this.#next + 1) % WATCH_KEPT;
    this.#count = Math.min(this.#count + 1, WATCH_KEPT);
    this.started = true;
  }

  /** One step of the module from a header's state with its controls, as the server steps the boat into the next tick. */
  #stepFrom(sn: OwnSnapshot, wind: BoatWind): void {
    const r = this.#physics.records;
    r.state.set(sn.state);
    const c = r.control;
    c[RECORDS.control.helm] = (sn.helm - 512) / 512;
    c[RECORDS.control.sheet] = sn.sheet / 1024;
    c[RECORDS.control.pilot] = sn.mode;
    c[RECORDS.control.target] = sn.target;
    c[RECORDS.control.order] = sn.order;
    c[RECORDS.control.way] = sn.way;
    const tick = sn.tick + 1;
    // The wind the step sails in is the wind where the boat is as it begins.
    this.#weather.read(tick, sn.state[S.x] ?? 0, sn.state[S.y] ?? 0, wind);
    this.#weather.use(tick);
    this.#wakes.use(tick);
    this.#seas.use(tick);
    this.#physics.step();
    if (this.#wakes.reaching > 0) {
      const env = r.env;
      wind.shadowSpeed = env[RECORDS.env.windSpeed] ?? 0;
      wind.shadowFrom = env[RECORDS.env.windFrom] ?? 0;
    }
  }

  /**
   * Draws the boat at render tick rt: the states either side of it, a
   * tick apart, so that the game's blend at the clock's alpha falls on
   * rt; the clock set to rt; and the Out, wind and words of the newest
   * header at or before it. Past the newest header the boat is held there.
   */
  at(rt: number, clock: { steps: number; alpha: number }): void {
    if (this.#count === 0) {
      return;
    }
    const t0 = Math.floor(rt);
    clock.steps = t0;
    clock.alpha = rt - t0;
    this.#stateAt(t0, this.states.previous);
    this.#stateAt(t0 + 1, this.states.current);
    // The newest header at or before rt, or the oldest held.
    let k = 0;
    while (k + 1 < this.#count && (this.#ticks[this.#at(k)] ?? 0) > rt) {
      k++;
    }
    const i = this.#at(k);
    const tick = this.#ticks[i] ?? 0;
    if (tick === this.#drawn) {
      return;
    }
    this.#drawn = tick;
    this.out.set(this.#outs.subarray(i * OUT, i * OUT + OUT));
    Object.assign(this.wind, this.#winds[i]);
    const w = this.#words;
    this.helm = w[i * 7] ?? 512;
    this.sheet = w[i * 7 + 1] ?? 512;
    this.pilot.mode = w[i * 7 + 2] ?? 0;
    this.pilot.target = w[i * 7 + 3] ?? 0;
    this.pilot.order = w[i * 7 + 4] ?? 0;
    this.pilot.way = w[i * 7 + 5] ?? 0;
    const over = w[i * 7 + 6] ?? 0;
    if (this.over !== 0 && over === 0) {
      this.restarts++;
    }
    this.over = over;
  }

  /** The boat's state at tick t, into out: between the headers either side, held at the ends. */
  #stateAt(t: number, out: Float64Array): void {
    let k = 0;
    while (k + 1 < this.#count && (this.#ticks[this.#at(k)] ?? 0) > t) {
      k++;
    }
    const a = this.#at(k);
    const ta = this.#ticks[a] ?? 0;
    const s = this.#states;
    if (k === 0 || ta >= t) {
      // Past the newest, or before the oldest: that header as it is.
      out.set(s.subarray(a * N, a * N + N));
      return;
    }
    const b = this.#at(k - 1);
    const tb = this.#ticks[b] ?? 0;
    const f = tb > ta ? (t - ta) / (tb - ta) : 1;
    for (let n = 0; n < N; n++) {
      const x = s[a * N + n] ?? 0;
      const y = s[b * N + n] ?? 0;
      out[n] = x + (y - x) * f;
    }
    out[S.heading] = lerpAngle(s[a * N + S.heading] ?? 0, s[b * N + S.heading] ?? 0, f);
    out[S.heel] = lerpAngle(s[a * N + S.heel] ?? 0, s[b * N + S.heel] ?? 0, f);
    for (const n of COUNTED) {
      out[n] = s[(f < 0.5 ? a : b) * N + n] ?? 0;
    }
  }
}
