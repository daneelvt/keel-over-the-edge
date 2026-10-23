// SPDX-License-Identifier: AGPL-3.0-only

// The barometer aboard: a brass aneroid that reads the pressure where the
// boat is, a reading a second, with a set hand at its own reading of a
// quarter of an hour before, so the tendency is the gap between the two
// hands, as WEATHER's real barometers have it set by hand (Weems & Plath:
// "Turn the exterior knob to move the marker needle to the present
// atmospheric pressure … to determine if the atmospheric pressure is rising
// or falling"); and beneath, its reading and tendency in the Met Office's
// words, "1009 hPa, falling quickly", over its own readings now, five and
// fifteen minutes before. After a load its past is filled from the truth
// kept, at the boat's place.

import { signal } from '@preact/signals';
import { barometerWords } from '../chart/words';
import { Moved, rotate } from './model';

/** Ticks a second, and a minute. */
const SECOND = 30;
const MINUTE = 60 * SECOND;

/** How the barometer is drawn: its dial's range, hPa, and its set hand's lag, minutes. */
export interface BarometerLook {
  range: readonly [number, number];
  set: number;
}

/** The dial's sweep, degrees either side of straight up. */
export const SWEEP = 135;

/** A pressure's angle on the dial, degrees clockwise from straight up. */
export function dialAngle(hPa: number, look: BarometerLook): number {
  const [lo, hi] = look.range;
  const u = Math.min(Math.max((hPa - lo) / (hi - lo), 0), 1);
  return -SWEEP + 2 * SWEEP * u;
}

export class Barometer {
  /** The reading and its tendency: "1009 hPa, falling quickly"; empty before the first. */
  readonly words = signal('');
  readonly hand = new Moved(rotate, 0.05);
  readonly setHand = new Moved(rotate, 0.05);
  /** The last reading and the set hand's, hPa. */
  now = Number.NaN;
  set = Number.NaN;
  /**
   * A held change, hPa a quarter of an hour, from a tick and what was held
   * then, added to every reading: the sandbox's, to show the words at
   * each rate.
   */
  held: { rate: number; from: number; base: number } | null = null;
  readonly look: BarometerLook;
  /** The readings kept, a second apart, oldest first: ticks and hPa. */
  readonly #ticks: number[] = [];
  readonly #hpa: number[] = [];
  #last = Number.NEGATIVE_INFINITY;

  constructor(look: BarometerLook) {
    this.look = look;
  }

  /**
   * Holds a change, hPa a quarter of an hour, from a tick on, carried on
   * from what was held before so the readings do not jump; null lets it go.
   */
  hold(rate: number | null, tick: number): void {
    this.held = rate === null ? null : { rate, from: tick, base: this.#heldAt(tick) };
  }

  /** A held change added to a reading at a tick. */
  #heldAt(tick: number): number {
    return this.held === null
      ? 0
      : this.held.base + (this.held.rate * (tick - this.held.from)) / (15 * MINUTE);
  }

  /**
   * Reads the barometer at a tick, at most once a second: read gives the
   * pressure at the boat now, past the truth's at its place at a tick
   * before, null where none is kept. Its hands are moved and its words
   * written.
   */
  update(tick: number, read: () => number, past: (tick: number) => number | null): void {
    if (tick - this.#last < SECOND && tick >= this.#last) {
      return;
    }
    if (tick < this.#last) {
      // Another world, or the clock set back: what was read is not this.
      this.#ticks.length = 0;
      this.#hpa.length = 0;
    }
    this.#last = tick;
    const now = read() + this.#heldAt(tick);
    this.#ticks.push(tick);
    this.#hpa.push(now);
    // A quarter of an hour and a minute kept.
    while (
      this.#ticks.length > 0 &&
      (this.#ticks[0] ?? 0) < tick - this.look.set * MINUTE - MINUTE
    ) {
      this.#ticks.shift();
      this.#hpa.shift();
    }
    const before = this.readingAt(tick - 5 * MINUTE, past);
    const quarter = this.readingAt(tick - this.look.set * MINUTE, past);
    this.now = now;
    this.set = quarter ?? now;
    this.words.value = barometerWords(now, before ?? now, quarter ?? now);
    this.hand.set(dialAngle(now, this.look));
    this.setHand.set(dialAngle(this.set, this.look));
  }

  /** The reading at a tick: its own, the nearest at or before it, or the truth's, or null. */
  readingAt(tick: number, past: (tick: number) => number | null): number | null {
    let found: number | null = null;
    for (let i = 0; i < this.#ticks.length; i++) {
      const t = this.#ticks[i] ?? 0;
      if (t > tick) {
        break;
      }
      if (tick - t < 2 * SECOND) {
        found = this.#hpa[i] ?? null;
      }
    }
    if (found !== null) {
      return found;
    }
    const p = past(tick);
    return p === null ? null : p + this.#heldAt(tick);
  }
}
