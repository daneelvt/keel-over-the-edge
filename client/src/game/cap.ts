// SPDX-License-Identifier: AGPL-3.0-only

// The frame cap. The browser calls for an animation frame at the display's
// rate: 60 Hz, 120 Hz on many phones, 90 or 144 Hz on some, 30 Hz on an
// iPhone in Low Power Mode. The game draws at most 60 frames a second (30 to
// save battery), and draws on every n-th animation frame, n the smallest
// whole number that brings the display's rate within the cap. Every drawn
// frame then stays on screen for the same number of refreshes, which keeps
// motion even: skipping frames by elapsed time instead alternates one and two
// refreshes on a display whose rate is not a multiple of the cap, and
// judders. A 90 Hz display draws at 45, a 144 Hz one at 48.
//
// The display's rate is the median of the last 30 intervals between
// animation frames, measured all the time, so a phone that changes its rate
// is followed within half a second or so.
//
// That rate is what the page gets, which is the display's own only while
// the page keeps up: a phone that takes 25 ms a frame on a 60 Hz display is
// called for an animation frame every 33 ms, exactly as one whose display
// runs at 30 Hz is. To tell a slow phone from a slow display, the cap can
// probe: for a few animation frames nothing is drawn, and the intervals
// between them are the display's.

/** Animation-frame intervals the display's rate is measured over. */
const WINDOW = 30;
/** A rate within this fraction above the cap still counts as the cap. */
const SLACK = 0.05;
/** Animation frames a probe leaves undrawn; the first interval still holds the last drawn frame's work. */
const PROBE = 6;

/** The smallest n for which a display of rate hz drawn every n-th frame is within the cap. */
export function divisorFor(hz: number, cap: number): number {
  if (!(hz > 0) || !(cap > 0)) {
    return 1;
  }
  return Math.max(1, Math.ceil(hz / (cap * (1 + SLACK)) - 1e-9));
}

export class FrameCap {
  /** The most frames a second to draw: 60, or 30 to save battery. */
  limit = 60;
  /** A divisor that overrides the measured one (the browser tests). */
  forced: number | null = null;

  readonly #intervals = new Float64Array(WINDOW);
  readonly #sorted = new Float64Array(WINDOW);
  #n = 0;
  #next = 0;
  #prev = -1;
  #since = 0;
  #divisor = 1;
  #hz = 0;
  readonly #probe = new Float64Array(PROBE - 1);
  #probing = 0;
  #display = 0;
  #probed = Number.NEGATIVE_INFINITY;

  /** The rate animation frames come at, in Hz; 0 until measured. */
  get rate(): number {
    return this.#hz;
  }

  /**
   * The display's own rate, in Hz: by the last probe, or the rate animation
   * frames come at when that is faster or nothing was probed yet.
   */
  get display(): number {
    return Math.max(this.#display, this.#hz);
  }

  /** The interval between drawn frames the cap asks of this display, in milliseconds; 0 until measured. */
  get interval(): number {
    const hz = this.display;
    return hz > 0 ? (1000 * (this.forced ?? divisorFor(hz, this.limit))) / hz : 0;
  }

  /** When the display was last probed, in milliseconds on the animation frames' clock. */
  get probed(): number {
    return this.#probed;
  }

  /** Whether a probe is under way. */
  get probing(): boolean {
    return this.#probing > 0;
  }

  /** Measures the display itself: the next few animation frames are not drawn. */
  probe(): void {
    if (this.#probing === 0) {
      this.#probing = PROBE;
    }
  }

  /** Every how many animation frames one is drawn. */
  get divisor(): number {
    return this.forced ?? this.#divisor;
  }

  /**
   * Records an animation frame at now, in milliseconds, and says whether to
   * draw it.
   */
  tick(now: number): boolean {
    if (this.#prev >= 0) {
      const dt = now - this.#prev;
      if (dt > 0) {
        this.#intervals[this.#next] = dt;
        this.#next = (this.#next + 1) % WINDOW;
        this.#n = Math.min(this.#n + 1, WINDOW);
        this.#measure();
      }
    }
    if (this.#probing > 0) {
      const dt = now - this.#prev;
      // The first of them still waited for the last drawn frame.
      if (this.#prev >= 0 && this.#probing < PROBE) {
        this.#probe[PROBE - 1 - this.#probing] = dt;
      }
      this.#prev = now;
      this.#probing--;
      if (this.#probing === 0) {
        const median = this.#probe.slice().sort()[(PROBE - 1) >> 1] ?? 0;
        this.#display = median > 0 ? 1000 / median : 0;
        this.#probed = now;
        this.#since = this.divisor;
      }
      return false;
    }
    this.#prev = now;
    this.#since++;
    if (this.#since >= this.divisor) {
      this.#since = 0;
      return true;
    }
    return false;
  }

  /** Forgets the frames seen, after the page was hidden. */
  restart(): void {
    this.#prev = -1;
    this.#since = this.divisor;
    this.#probing = 0;
  }

  #measure(): void {
    // Intervals not yet measured sort last, as infinities.
    const n = this.#n;
    const s = this.#sorted;
    for (let i = 0; i < WINDOW; i++) {
      s[i] = i < n ? (this.#intervals[i] ?? 0) : Number.POSITIVE_INFINITY;
    }
    s.sort();
    const median =
      n % 2 === 1 ? (s[(n - 1) / 2] ?? 0) : ((s[n / 2 - 1] ?? 0) + (s[n / 2] ?? 0)) / 2;
    this.#hz = median > 0 ? 1000 / median : 0;
    this.#divisor = divisorFor(this.#hz, this.limit);
  }
}
