// SPDX-License-Identifier: AGPL-3.0-only

// The world clock as the client estimates it, and how far ahead of the
// server the client steps its boat. Times are microseconds held in numbers
// as whole values, so the arithmetic is the same, bit for bit, as the Go
// test client's (internal/edge/edgetest/clock.go), whose traces the tests
// replay through this code.
//
// The clock takes Pongs: each gives an offset, the server's world time plus
// half the round trip less the client's own time (Cristian's algorithm).
// The estimate is the median offset of the samples with the lowest round
// trips, which slow samples cannot pull; the clock moves toward it by at
// most 1 ms per 100 ms, so world time never jumps, unless it is more than
// 250 ms off (a reconnect, a page that was hidden).

/** Samples kept. */
export const CLOCK_SAMPLES = 32;
/** The lowest round trips whose offsets' median is the estimate. */
export const CLOCK_BEST = 8;
/** The most the offset moves: 1 ms per 100 ms. */
export const SLEW_RATE = 0.01;
/** An offset further than this from the estimate, µs, is set at once. */
export const SET_BEYOND = 250_000;

interface Sample {
  rtt: number;
  offset: number;
}

/** A clock's state: what the net worker sends the page, which reads world time from it. */
export interface ClockState {
  have: boolean;
  /** The offset came from a Welcome alone; the first Pong sets the clock at once. */
  rough: boolean;
  /** The offset in force at `at`, and the estimate it moves toward. */
  offset: number;
  target: number;
  at: number;
  /** The round trip's estimate, µs. */
  rtt: number;
}

export function newClockState(): ClockState {
  return { have: false, rough: false, offset: 0, target: 0, at: 0, rtt: 0 };
}

/** The offset in force at now. */
export function applied(c: ClockState, now: number): number {
  const d = c.target - c.offset;
  if (Math.abs(d) > SET_BEYOND) {
    return c.target;
  }
  const step = (now - c.at) * SLEW_RATE;
  if (d > step) {
    return c.offset + step;
  }
  if (d < -step) {
    return c.offset - step;
  }
  return c.target;
}

/** World time at now, µs since the world's epoch. */
export function worldUs(c: ClockState, now: number): number {
  return now + applied(c, now);
}

function median(v: number[]): number {
  v.sort((a, b) => a - b);
  const n = v.length;
  return n % 2 === 1 ? (v[(n - 1) / 2] ?? 0) : ((v[n / 2 - 1] ?? 0) + (v[n / 2] ?? 0)) / 2;
}

export class Clock {
  readonly state = newClockState();
  #samples: Sample[] = [];

  /** Sets the clock from a Welcome's world time, if it has none yet. */
  welcome(world: number, now: number): void {
    const c = this.state;
    if (c.have) {
      return;
    }
    c.offset = world - now;
    c.target = world - now;
    c.at = now;
    c.have = true;
    c.rough = true;
  }

  /** Adds a Pong: sent is the Ping's client time, world the server's. */
  sample(sent: number, world: number, now: number): void {
    const rtt = now - sent;
    this.#samples.push({ rtt, offset: world + rtt / 2 - now });
    if (this.#samples.length > CLOCK_SAMPLES) {
      this.#samples.shift();
    }
    // Array.prototype.sort is stable: equal round trips keep their order.
    const best = [...this.#samples].sort((a, b) => a.rtt - b.rtt).slice(0, CLOCK_BEST);
    const target = median(best.map((s) => s.offset));
    const c = this.state;
    if (c.have && !c.rough) {
      c.offset = applied(c, now);
    } else {
      c.offset = target;
      c.have = true;
      c.rough = false;
    }
    c.at = now;
    c.target = target;
    c.rtt = median(best.map((s) => s.rtt));
  }

  worldUs(now: number): number {
    return worldUs(this.state, now);
  }
}

/** m: how many ticks ahead of the server the client runs. */
export const AHEAD_START = 2;
export const AHEAD_MIN = 1;
export const AHEAD_MAX = 30;
/** A margin this or more is room to spare. */
export const AHEAD_GOOD = 3;
/** µs of spare margins before stepping one tick less ahead. */
export const AHEAD_SETTLE = 5_000_000;
/** µs beyond a round trip after a raise during which late margins are let be. */
export const AHEAD_HOLD = 100_000;
export const TICKS_PER_SECOND = 30;
/** Behind its target by more than this, the boat is put back to the server's latest state. */
export const BEHIND = 30;
/** The most steps a frame takes. */
export const MAX_STEPS = 4;
/** A snapshot's margin when none came. */
const NO_MARGIN = -32768;

/**
 * m, tuned from the arrival margins the server reports: a late input raises
 * it at once, once a round trip (the margins of inputs sent before the
 * raise took effect say nothing new); five seconds of margins to spare
 * lower it by one.
 */
export class Ahead {
  m = AHEAD_START;
  #good = -1;
  #hold = 0;

  margin(margin: number, now: number, rtt: number): void {
    if (margin === NO_MARGIN) {
      return;
    }
    if (margin < 0) {
      if (now >= this.#hold) {
        this.m = Math.min(AHEAD_MAX, this.m - margin + 1);
        this.#hold = now + rtt + AHEAD_HOLD;
      }
      this.#good = -1;
    } else if (margin < AHEAD_GOOD) {
      this.#good = -1;
    } else if (this.#good < 0) {
      this.#good = now;
    } else if (now - this.#good >= AHEAD_SETTLE) {
      this.m = Math.max(AHEAD_MIN, this.m - 1);
      this.#good = now;
    }
  }
}

/** The tick, with its fraction, the client should have stepped to at world time worldUs. */
export function aheadTicks(world: number, rtt: number, m: number): number {
  return ((world + rtt / 2) * TICKS_PER_SECOND) / 1e6 + m;
}

/**
 * The tick to have stepped to: the tick due when an input sent now
 * arrives, half a round trip on, and m more.
 */
export function target(world: number, rtt: number, m: number): number {
  return Math.ceil(((world + rtt / 2) * TICKS_PER_SECOND) / 1e6) + m;
}

/**
 * The client's own time, µs, the same in the page and in its workers:
 * performance.timeOrigin differs between them, its sum with
 * performance.now() does not.
 */
export function nowUs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}
