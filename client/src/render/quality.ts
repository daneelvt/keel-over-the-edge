// SPDX-License-Identifier: AGPL-3.0-only

// How much the scene draws. A tier is a set of values, not a back end: the
// render scale's cap, the detail band, the foam map, the shadows, the spray.
// A device starts on the best tier its back end can run, or where it settled
// last time, and adaptive quality moves it down and up a ladder of rungs
// from there.
//
// The ladder is ordered by the pixels drawn, and only ever goes down in
// them: no rung draws more than the one above it, on any display. Each rung
// holds a step of the render scale, from the top tier's pixel ratio on this
// display down to the floor in six steps of the same size, and the steps are
// shared out between the tiers: the high tier steps the scale first, then
// turns off the shadows and the detail's second patch, and each tier below
// starts at the scale the one above ended on. A step that changes only the
// scale changes the size of the render target and no shader, so it costs no
// wait and no hitch. The floor is half the display's CSS pixels, never under
// 540 lines on its shorter side, unless the display itself has fewer: the
// instruments and words are HTML and stay sharp, and the sea is never
// softer than that. Below the last rung the frame cap draws at half the
// display's rate: an even 30 frames a second looks better than an uneven
// rate between 30 and 60.
//
// A window of frames is slow when the 90th percentile of the intervals
// between drawn frames is more than 1.15 times the interval the frame cap
// asks for (so a display at 30 Hz is not slow). Two slow windows in a row
// step down: a rung at a time, or, when the window was twice as slow as the
// cap or more, straight to the rung whose pixels are fewer by that ratio. A
// window is comfortable when it is not slow and the main thread's work is
// within its budget; GPU time is shown on the developer panel but judges
// nothing, since under vertical sync a reading may hold time spent waiting.
// So whether there is room above is found by trying: ten seconds of comfort
// step up a rung, or from half the rate back to the full rate. A step up
// that has to be undone within 20 s doubles the wait before the next, to
// 320 s at most, so a device at its limit settles and does not try the same
// step every ten seconds (the idea of drei's PerformanceMonitor and its
// "flipflops": https://drei.docs.pmnd.rs/performances/performance-monitor).
// A try that only adds pixels costs two windows and no hitch.

import { QUALITY_VERSION } from '../ocean/look';
import type { Backend } from './renderer';

export type TierName = 'high' | 'medium' | 'low';

/** The detail band a tier draws: the transform on the GPU at a size, with one patch or two, or the loop made once. */
export type DetailKind =
  | { kind: 'fft'; size: 128 | 256; patches: 1 | 2 }
  | { kind: 'baked' }
  | { kind: 'none' };

/** The wake's waves a tier draws: by the transform on the GPU, or on the CPU, over a square of size texels and span metres. */
export interface WakeWavesKind {
  kind: 'fft' | 'cpu';
  size: 64 | 128 | 256;
  span: number;
}

export interface Tier {
  name: TierName;
  /** As the server is told it: 1 low, 2 medium, 3 high. */
  number: number;
  /** The pixel ratio drawn at, at most. */
  scale: number;
  detail: DetailKind;
  /** The foam map's side, in texels. */
  foamMap: number;
  /** The wake's waves. */
  wakeWaves: WakeWavesKind;
  /** The shadow map's side, in texels (0 for none), the side of the box it covers, in metres, and whether other boats cast and receive. */
  shadowMap: number;
  shadowBox: number;
  shadowFleet: boolean;
  /** The most drops of spray, how many boats throw it beside the player's, and whether crests do. */
  spray: number;
  sprayBoats: number;
  sprayCrests: boolean;
  /** The detail's anisotropic filtering. */
  anisotropy: number;
  /**
   * The sea's look: whole, or plain, which leaves out what costs most and
   * shows least (seamaterial.ts's PLAIN_SEA) and draws the tiles a hull
   * may reach apart, so that the rest of the sea's shader holds no cut.
   */
  sea: 'whole' | 'plain';
  /** The clouds' puffs drawn at most, and the streaks of rain at the boat. */
  puffs: number;
  streaks: number;
}

export const TIERS: Record<TierName, Tier> = {
  high: {
    name: 'high',
    number: 3,
    scale: 2,
    detail: { kind: 'fft', size: 256, patches: 2 },
    foamMap: 512,
    wakeWaves: { kind: 'fft', size: 256, span: 64 },
    // A shadow map is a depth texture and a colour target: 5 bytes a texel
    // here (shadows.ts), so 1,024² is 5 MB and 2,048² would be 20.
    shadowMap: 1024,
    shadowBox: 40,
    shadowFleet: true,
    spray: 512,
    sprayBoats: 3,
    sprayCrests: true,
    anisotropy: 4,
    sea: 'whole',
    puffs: 1024,
    streaks: 2048,
  },
  medium: {
    name: 'medium',
    number: 2,
    scale: 1.5,
    detail: { kind: 'fft', size: 128, patches: 1 },
    foamMap: 512,
    wakeWaves: { kind: 'fft', size: 128, span: 48 },
    shadowMap: 1024,
    shadowBox: 12,
    shadowFleet: false,
    spray: 512,
    sprayBoats: 0,
    sprayCrests: true,
    anisotropy: 4,
    sea: 'whole',
    puffs: 768,
    streaks: 1024,
  },
  low: {
    name: 'low',
    number: 1,
    scale: 1,
    detail: { kind: 'baked' },
    foamMap: 256,
    wakeWaves: { kind: 'cpu', size: 64, span: 28 },
    shadowMap: 0,
    shadowBox: 0,
    shadowFleet: false,
    spray: 96,
    sprayBoats: 0,
    sprayCrests: false,
    anisotropy: 1,
    sea: 'plain',
    puffs: 512,
    streaks: 512,
  },
};

const ORDER: readonly TierName[] = ['high', 'medium', 'low'];

/** A rung of the ladder: a tier, the step of the render scale, the shadows and the detail band. */
export interface Rung {
  tier: TierName;
  /** The render scale's step, 0 at the ladder's top to LEVELS at its floor. */
  level: number;
  /** Whether the shadow map is drawn. */
  shadows: boolean;
  /** The detail band drawn. */
  detail: DetailKind;
}

/** The render scale's steps from the top of a ladder to its floor. */
export const LEVELS = 6;
/** The step each tier takes the render scale down to before the tier below: the low tier's is the floor. */
const LAST_LEVEL: Record<TierName, number> = { high: 3, medium: 5, low: LEVELS };
/** The floor: this share of the display's CSS pixels, a side, and never fewer lines than these on its shorter side. */
export const FLOOR = 0.5;
export const FLOOR_LINES = 540;

/** The best tier a back end can run: the transform needs compute, and 256 texels a side need core's workgroups of 256. */
export function topTier(backend: Backend, compat: boolean): TierName {
  return backend === 'webgl2' ? 'low' : compat ? 'medium' : 'high';
}

/** The lower of two tiers. */
export function lowerTier(a: TierName, b: TierName): TierName {
  return ORDER.indexOf(a) > ORDER.indexOf(b) ? a : b;
}

/**
 * The ladder from a tier down, best first. Within a tier: the render scale
 * down to the tier's last step, then the shadows off, then the second patch
 * of the detail band off. The detail's next steps, 256 to 128 and then the
 * loop, are the tiers below, each entered at the scale the one above ended
 * on, with the shadows already off.
 */
export function ladder(top: TierName): Rung[] {
  const rungs: Rung[] = [];
  let shadows = true;
  let level = 0;
  for (const name of ORDER.slice(ORDER.indexOf(top))) {
    const tier = TIERS[name];
    const lit = shadows && tier.shadowMap > 0;
    const last = LAST_LEVEL[name];
    for (; level <= last; level++) {
      rungs.push({ tier: name, level, shadows: lit, detail: tier.detail });
    }
    level = last;
    if (lit) {
      rungs.push({ tier: name, level, shadows: false, detail: tier.detail });
    }
    if (tier.detail.kind === 'fft' && tier.detail.patches === 2) {
      rungs.push({ tier: name, level, shadows: false, detail: { ...tier.detail, patches: 1 } });
    }
    shadows = false;
  }
  return rungs;
}

/** The display drawn on: its device pixel ratio, and its shorter side in CSS pixels (0 when not known). */
export interface Display {
  dpr: number;
  short: number;
}

/** The pixel ratio a ladder starts at on a display: the display's own, at least 1, and no more than the top tier's. */
export function topRatio(top: TierName, dpr: number): number {
  return Math.min(Math.max(dpr, 1), TIERS[top].scale);
}

/**
 * The lowest pixel ratio a ladder goes to on a display: half its CSS pixels
 * a side, or 540 lines on its shorter side where that is more, and never
 * more than the ladder's top (a display of fewer lines than that has no
 * steps of the scale).
 */
export function floorRatio(top: TierName, d: Display): number {
  const lines = d.short > 0 ? FLOOR_LINES / d.short : 0;
  return Math.min(topRatio(top, d.dpr), Math.max(FLOOR, lines));
}

/**
 * The pixel ratio a rung of the ladder from top draws at on a display: from
 * the top's ratio to the floor in steps of the same factor, so that each
 * step takes away the same share of the pixels.
 */
export function pixelRatioOf(top: TierName, rung: Rung, d: Display): number {
  const from = topRatio(top, d.dpr);
  const to = floorRatio(top, d);
  return from * (to / from) ** (Math.min(Math.max(rung.level, 0), LEVELS) / LEVELS);
}

/** What storage offers; tests stand in for it. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'keel.quality';

/** Where a device settled: a preference, not progress. Kept with the build's quality version and the ladder it was on. */
export function remember(store: Store | null, top: TierName, index: number): void {
  try {
    store?.setItem(KEY, JSON.stringify({ version: QUALITY_VERSION, top, index }));
  } catch {
    // Storage refused: the next visit starts from the top.
  }
}

/** Lets go of where the device settled: the next visit starts from the top. */
export function forget(store: Store | null): void {
  try {
    store?.setItem(KEY, '');
  } catch {
    // Storage refused: nothing was remembered.
  }
}

/** The rung remembered for this ladder by this build, or −1. */
export function remembered(store: Store | null, top: TierName, length: number): number {
  try {
    const text = store?.getItem(KEY) ?? null;
    const raw: unknown = text === null ? null : JSON.parse(text);
    if (raw === null || typeof raw !== 'object') {
      return -1;
    }
    const r = raw as Record<string, unknown>;
    if (r.version !== QUALITY_VERSION || r.top !== top || !Number.isInteger(r.index)) {
      return -1;
    }
    const index = r.index as number;
    return index >= 0 && index < length ? index : -1;
  } catch {
    return -1;
  }
}

export interface QualityStart {
  /** The tier the ladder starts from, and the ladder. */
  top: TierName;
  ladder: Rung[];
  /** The rung to start on: ladder.length for the last rung at half the rate. */
  index: number;
  /** Whether adaptive quality moves it. */
  adaptive: boolean;
}

function tierName(s: string | null): TierName | null {
  return s === 'high' || s === 'medium' || s === 'low' ? s : null;
}

/**
 * Where a page starts. The ladder's top is the back end's best tier, or
 * the low tier when the player asked for it. ?tier=high|medium|low fixes a
 * tier, no better than the back end's, and turns adaptive quality off.
 * Otherwise the page starts where this device settled before on this ladder,
 * or at its top.
 */
export function startQuality(
  backend: Backend,
  compat: boolean,
  query: URLSearchParams,
  detail: 'auto' | 'low',
  store: Store | null,
): QualityStart {
  const best = topTier(backend, compat);
  const forced = tierName(query.get('tier'));
  if (forced !== null) {
    const top = lowerTier(forced, best);
    return { top, ladder: ladder(top), index: 0, adaptive: false };
  }
  const top = detail === 'low' ? 'low' : best;
  const rungs = ladder(top);
  return {
    top,
    ladder: rungs,
    // One more than the rungs: the last rung at half the rate.
    index: Math.max(0, remembered(store, top, rungs.length + 1)),
    adaptive: true,
  };
}

/** What a window of frames showed. */
export interface FrameWindow {
  /** Drawn frames in it. */
  frames: number;
  /** The 90th percentile of the intervals between drawn frames, ms. */
  p90: number;
  /** The interval the frame cap asks for, ms: the display's own, times the divisor drawn at. */
  interval: number;
  /** The median of the main thread's work a frame, ms. */
  work: number;
}

/** A step taken, for the log. */
export interface Step {
  /** When, ms, on the clock the windows are given on. */
  at: number;
  from: number;
  to: number;
  why: string;
}

/** A window slower than this many times the cap's interval is slow. */
export const SLOW = 1.15;
/**
 * A window this many times the cap's interval or more steps by that ratio:
 * twice, less a little, as a frame held for two refreshes measures twice
 * the interval to within the clock's jitter.
 */
export const JUMP = 1.9;
/** Comfortable: the main thread's work a frame under this, ms. */
export const SPARE_WORK = 6;
/** Comfort for this long steps up, ms; an undone step doubles it, to at most MAX_WAIT. */
export const WAIT = 10_000;
export const MAX_WAIT = 320_000;
/** A step up followed by a step down within this long was undone, ms. */
export const UNDONE = 20_000;
/** Windows within this long after a change of shaders are not counted, ms. */
export const SETTLE = 1000;
/** A window with fewer drawn frames than this says nothing. */
const FEW = 4;
const LOG = 40;

/** Whether two rungs draw the same shaders: the same tier, shadows and detail band. */
export function sameShaders(a: Rung, b: Rung): boolean {
  const x = a.detail;
  const y = b.detail;
  return (
    a.tier === b.tier &&
    a.shadows === b.shadows &&
    x.kind === y.kind &&
    (x.kind !== 'fft' || (y.kind === 'fft' && x.size === y.size && x.patches === y.patches))
  );
}

/** Whether two rungs draw alike on a display: the same shaders, at the same pixel ratio. */
function alike(a: Rung, b: Rung, ratioOf: (r: Rung) => number): boolean {
  return sameShaders(a, b) && Math.abs(ratioOf(a) - ratioOf(b)) < 1e-6;
}

/** Adaptive quality: given each window of frames, says when to step and where to. */
export class Adaptive {
  readonly ladder: readonly Rung[];
  /** The rung in use; ladder.length for the last rung drawn at half the display's rate. */
  index: number;
  enabled = true;
  /**
   * Whether the frame cap can draw at half the rate: whether that is slower
   * than the cap's own on this display (it is not with the menu's 30, nor
   * on a display of 30 Hz).
   */
  halvable = true;
  /** The pixel ratio a rung draws at on this display, for the big steps; null steps a rung at a time. */
  ratioOf: ((r: Rung) => number) | null = null;
  /** The steps taken, the latest last. */
  readonly log: Step[] = [];
  /** How long the comfort must last before the next step up, ms: base, doubled for each step up undone. */
  base = WAIT;
  wait = WAIT;

  #slow = 0;
  /** The least of the slow windows' ratios to the cap's interval, since the last that was not. */
  #ratio = Number.POSITIVE_INFINITY;
  #comfort = 0;
  #quietUntil = 0;
  #lastUp = Number.NEGATIVE_INFINITY;
  #lastWindow = Number.NaN;
  /** Windows judged since the last step. */
  #judged = 0;

  constructor(rungs: readonly Rung[], index: number) {
    this.ladder = rungs;
    this.index = Math.min(Math.max(index, 0), rungs.length);
  }

  get rung(): Rung {
    return this.ladder[Math.min(this.index, this.ladder.length - 1)] as Rung;
  }

  /** Whether the frame cap is to draw at half the display's rate. */
  get halved(): boolean {
    return this.halvable && this.index >= this.ladder.length;
  }

  /** The lowest step there is: the last rung at half the rate, or the last rung where the rate cannot be halved. */
  get bottom(): number {
    return this.halvable ? this.ladder.length : this.ladder.length - 1;
  }

  /**
   * Whether the device holds where it is: a window judged since the last
   * step asked for no step down, or there is nowhere lower to go. Always,
   * with adaptive quality off.
   */
  get settled(): boolean {
    return !this.enabled || (this.#judged > 0 && (this.#slow === 0 || this.index >= this.bottom));
  }

  /**
   * Something changed at now that a window would misread: a step applied (a
   * new shader, new targets), the page shown again, a lost device made
   * again. Windows that end within a second of it are not counted, nor
   * until, when what changed takes longer (a shader still compiling).
   */
  quiet(now: number, until = now + SETTLE): void {
    this.#quietUntil = Math.max(this.#quietUntil, until);
    this.#slow = 0;
    this.#ratio = Number.POSITIVE_INFINITY;
    this.#comfort = 0;
  }

  /**
   * What was being waited for is in: windows count again a second from
   * now, or settle ms (sooner after a change of the render target's size
   * alone, which compiles nothing).
   */
  unquiet(now: number, settle = SETTLE): void {
    this.#quietUntil = now + settle;
  }

  /**
   * Takes the window that ended at now, ms. Returns the step to move to, or
   * null. The caller applies it and calls quiet once it has.
   */
  window(now: number, w: FrameWindow): number | null {
    const length = Number.isNaN(this.#lastWindow) ? 0 : now - this.#lastWindow;
    this.#lastWindow = now;
    if (Number.isFinite(this.#lastUp) && now - this.#lastUp > UNDONE) {
      // The last step up held: the wait starts over.
      this.wait = this.base;
      this.#lastUp = Number.NEGATIVE_INFINITY;
    }
    // The menu's 30 or a slower display took the half rate's place.
    this.index = Math.min(this.index, this.bottom);
    if (!this.enabled || now < this.#quietUntil || w.frames < FEW || !(w.interval > 0)) {
      return null;
    }
    this.#judged++;
    const ratio = w.p90 / w.interval;
    if (ratio > SLOW) {
      this.#comfort = 0;
      this.#slow++;
      this.#ratio = Math.min(this.#ratio, ratio);
      if (this.#slow >= 2 && this.index < this.bottom) {
        return this.#step(now, this.#below(this.#ratio), 'slow');
      }
      return null;
    }
    this.#slow = 0;
    this.#ratio = Number.POSITIVE_INFINITY;
    if (!(w.work < SPARE_WORK)) {
      this.#comfort = 0;
      return null;
    }
    this.#comfort += length;
    if (this.#comfort >= this.wait && this.index > 0) {
      return this.#step(now, this.#above(), 'comfortable');
    }
    return null;
  }

  /** Whether two steps draw alike on this display. */
  #alike(i: number, j: number): boolean {
    const r = this.ratioOf;
    return r !== null && alike(this.ladder[i] as Rung, this.ladder[j] as Rung, r);
  }

  /**
   * The step below for windows ratio times the cap's interval: the rung
   * whose pixels are fewer by that ratio when it is twice or more, or else
   * the next rung that draws differently; from the last rung, half the rate.
   */
  #below(ratio: number): number {
    const last = this.ladder.length - 1;
    if (this.index >= last) {
      return this.bottom;
    }
    const r = this.ratioOf;
    if (r === null) {
      return this.index + 1;
    }
    if (ratio >= JUMP) {
      const want = (r(this.rung) ** 2 / ratio) * (1 + 1e-9);
      for (let i = this.index + 1; i < last; i++) {
        if (r(this.ladder[i] as Rung) ** 2 <= want) {
          return i;
        }
      }
      return last;
    }
    let i = this.index + 1;
    while (i < last && this.#alike(i, this.index)) {
      i++;
    }
    return i;
  }

  /** The step above: the full rate from half of it, or the highest rung of the next that draws differently. */
  #above(): number {
    if (this.index >= this.ladder.length) {
      return this.ladder.length - 1;
    }
    let i = this.index - 1;
    while (i > 0 && this.#alike(i, this.index)) {
      i--;
    }
    while (i > 0 && this.#alike(i - 1, i)) {
      i--;
    }
    return i;
  }

  #step(now: number, to: number, why: string): number {
    if (to > this.index) {
      // A step up undone: the next one waits twice as long.
      if (now - this.#lastUp <= UNDONE) {
        this.wait = Math.min(this.wait * 2, MAX_WAIT);
      }
      this.#lastUp = Number.NEGATIVE_INFINITY;
    } else {
      this.#lastUp = now;
    }
    this.#moved(now, to, why);
    return to;
  }

  #moved(now: number, to: number, why: string): void {
    this.log.push({ at: now, from: this.index, to, why });
    if (this.log.length > LOG) {
      this.log.shift();
    }
    this.index = to;
    this.#slow = 0;
    this.#ratio = Number.POSITIVE_INFINITY;
    this.#comfort = 0;
    this.#judged = 0;
  }

  /** Moves to a step by hand (the developer panel, the tests), without judging it. */
  set(now: number, to: number, why = 'set'): void {
    this.#moved(now, Math.min(Math.max(to, 0), this.bottom), why);
  }

  /** A step in words: its rung, and the half rate below the last. */
  nameOf(index: number): string {
    const rung = rungName(this.ladder[Math.min(index, this.ladder.length - 1)] as Rung);
    return index >= this.ladder.length ? `${rung}, at half the rate` : rung;
  }
}

/** A rung in words, for the log and the panel: its tier, the step of its scale, its shadows and its detail. */
export function rungName(r: Rung): string {
  const d = r.detail;
  const detail =
    d.kind === 'fft'
      ? `${d.size}²${d.patches === 2 ? ' × 2' : ''}`
      : d.kind === 'baked'
        ? 'loop'
        : 'none';
  return `${r.tier} at ${r.level}/${LEVELS}${r.shadows ? ', shadows' : ''}, ${detail}`;
}
