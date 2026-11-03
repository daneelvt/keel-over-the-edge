// SPDX-License-Identifier: AGPL-3.0-only

// When the world may be shown. The cover stays over the page until the
// world under it is the world, not the scene's defaults: the sky at the
// world's hour, the boat's first snapshot taken and its driver set, the
// first view placed, the land within reach of the boat built (or three
// seconds past), and a few frames drawn under the cover so that the first
// one seen is not the one that makes every shader. Ten seconds after the
// tap it lifts on whatever has come, once there is a boat to show. A page
// that draws nothing has no frames to wait for.

/** What the cover waits for now: the boat, the land, the first frames; or nothing. */
export type Waiting = 'boat' | 'land' | 'sail' | 'ready';

/** The cover's line for each wait. */
export const WAITING_WORDS: Record<Exclude<Waiting, 'ready'>, string> = {
  boat: 'Finding your boat',
  land: 'Raising the land',
  sail: 'Setting sail',
};

/** The parts of the world, each true once it is ready. */
export interface GateParts {
  /** The Welcome's epoch applied: the sky at the world's hour. */
  epoch(): boolean;
  /** The boat's first snapshot taken and its driver set. */
  boat(): boolean;
  /** The first view placed. */
  view(): boolean;
  /** The land within reach of the boat built. */
  land(): boolean;
  /** Nothing more will come (a watch refused, a queue): show what there is now. */
  abandoned?(): boolean;
}

export interface GateRules {
  /** When the wait began, ms: the tap. */
  start: number;
  /** Whether frames are drawn to wait for. */
  draws: boolean;
  /** The longest the land is waited for once the boat is in, ms. */
  landWait?: number;
  /** The longest the whole wait takes once there is a boat, ms after the start. */
  ceiling?: number;
  /** How many frames are drawn under the cover, and how long the last may take, ms. */
  frames?: number;
  slow?: number;
}

export const LAND_WAIT = 3000;
export const CEILING = 10_000;
export const FRAMES = 3;
export const SLOW_FRAME = 50;

export class Gate {
  readonly #parts: GateParts;
  readonly #start: number;
  readonly #draws: boolean;
  readonly #landWait: number;
  readonly #ceiling: number;
  readonly #frames: number;
  readonly #slow: number;
  /** When the boat came in, ms; NaN before. */
  #boatAt = Number.NaN;
  /** Frames drawn since the frames were waited for, and the last one's work, ms. */
  #drawn = 0;
  #last = Number.POSITIVE_INFINITY;
  #sailing = false;
  /** Whether it lifted at the ceiling, not because everything came. */
  timedOut = false;

  constructor(parts: GateParts, rules: GateRules) {
    this.#parts = parts;
    this.#start = rules.start;
    this.#draws = rules.draws;
    this.#landWait = rules.landWait ?? LAND_WAIT;
    this.#ceiling = rules.ceiling ?? CEILING;
    this.#frames = rules.frames ?? FRAMES;
    this.#slow = rules.slow ?? SLOW_FRAME;
  }

  /** A frame drawn, with the main thread's work on it, ms. Counted only while the frames are waited for. */
  drawn(work: number): void {
    if (this.#sailing) {
      this.#drawn++;
      this.#last = work;
    }
  }

  /** What is waited for at now, ms. */
  step(now: number): Waiting {
    const p = this.#parts;
    if (p.abandoned?.() === true) {
      return 'ready';
    }
    // Nothing to show without a boat, however long it takes: the queue or
    // "Back soon" say why on the cover.
    if (!p.boat()) {
      return 'boat';
    }
    if (Number.isNaN(this.#boatAt)) {
      this.#boatAt = now;
    }
    if (now - this.#start >= this.#ceiling) {
      this.timedOut = true;
      return 'ready';
    }
    if (!p.epoch() || !p.view()) {
      return 'boat';
    }
    if (!p.land() && now - this.#boatAt < this.#landWait) {
      return 'land';
    }
    if (!this.#draws) {
      return 'ready';
    }
    this.#sailing = true;
    return this.#drawn >= this.#frames && this.#last < this.#slow ? 'ready' : 'sail';
  }
}

/** What the page did from the wait's start to the reveal, for the tests and the developer. */
export interface Revealed {
  /** ms from the wait's start: each wait as it began, and the reveal. */
  waits: { waiting: Waiting; at: number }[];
  at: number;
  /** Whether it lifted at the ceiling, not because everything came. */
  timedOut: boolean;
  /** At the reveal: the sky counted from the world's epoch, the boats arrived, the first view placed. */
  epoch: boolean;
  arrived: number;
  view: boolean;
  /** Frames drawn to the screen before the reveal: those under the cover. */
  drawn: number;
}
