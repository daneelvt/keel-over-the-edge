// SPDX-License-Identifier: AGPL-3.0-only

// How much the scene draws. A tier is a set of values, not a back end: the
// render scale's cap, the detail band, the foam map, the shadows, the spray.
// A device starts on the best tier its back end can run, or where it settled
// last time, and adaptive quality moves it down and up a ladder of rungs
// from there: the render scale by tenths to 0.7 of the tier's, then the
// shadows off, then the detail band a step, then the tier below.
//
// A window of frames is slow when the 90th percentile of the intervals
// between drawn frames is more than 1.15 times the interval the frame cap
// asks for (so a display at 30 Hz is not slow). Two slow windows in a row
// step down. A window is comfortable when it is not slow and the device has
// time to spare: GPU time under 70% of the interval where the device
// measures it, or the main thread's work under 6 ms where it does not, since
// under vertical sync the interval itself shows no headroom. Ten seconds of
// comfort step up. A step up that has to be undone within 20 s doubles the
// wait before the next, to 320 s at most, so a device at its limit settles
// and does not try the same step every ten seconds (the idea of drei's
// PerformanceMonitor and its "flipflops":
// https://drei.docs.pmnd.rs/performances/performance-monitor).

import { QUALITY_VERSION } from '../ocean/look';
import type { Backend } from './renderer';

export type TierName = 'high' | 'medium' | 'low';

/** The detail band a tier draws: the transform on the GPU at a size, with one patch or two, or the loop made once. */
export type DetailKind =
  | { kind: 'fft'; size: 128 | 256; patches: 1 | 2 }
  | { kind: 'baked' }
  | { kind: 'none' };

export interface Tier {
  name: TierName;
  /** As the server is told it: 1 low, 2 medium, 3 high. */
  number: number;
  /** The pixel ratio drawn at, at most. */
  scale: number;
  detail: DetailKind;
  /** The foam map's side, in texels. */
  foamMap: number;
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
}

export const TIERS: Record<TierName, Tier> = {
  high: {
    name: 'high',
    number: 3,
    scale: 2,
    detail: { kind: 'fft', size: 256, patches: 2 },
    foamMap: 512,
    shadowMap: 2048,
    shadowBox: 40,
    shadowFleet: true,
    spray: 512,
    sprayBoats: 3,
    sprayCrests: true,
    anisotropy: 4,
  },
  medium: {
    name: 'medium',
    number: 2,
    scale: 1.5,
    detail: { kind: 'fft', size: 128, patches: 1 },
    foamMap: 512,
    shadowMap: 1024,
    shadowBox: 12,
    shadowFleet: false,
    spray: 256,
    sprayBoats: 0,
    sprayCrests: true,
    anisotropy: 4,
  },
  low: {
    name: 'low',
    number: 1,
    scale: 1,
    detail: { kind: 'baked' },
    foamMap: 256,
    shadowMap: 0,
    shadowBox: 0,
    shadowFleet: false,
    spray: 96,
    sprayBoats: 0,
    sprayCrests: false,
    anisotropy: 1,
  },
};

const ORDER: readonly TierName[] = ['high', 'medium', 'low'];

/** A rung of the ladder: a tier, and how far it has been stepped down within it. */
export interface Rung {
  tier: TierName;
  /** The fraction of the tier's render scale drawn at: 1, 0.9, 0.8 or 0.7. */
  scale: number;
  /** Whether the shadow map is drawn. */
  shadows: boolean;
  /** The detail band drawn. */
  detail: DetailKind;
}

/** The render scale's steps within a tier. */
export const SCALE_STEPS: readonly number[] = [1, 0.9, 0.8, 0.7];

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
 * by tenths, then the shadows off, then the second patch of the detail band
 * off. The detail's next steps, 256 to 128 and then the loop, are the tiers
 * below, which are entered with the shadows already off.
 */
export function ladder(top: TierName): Rung[] {
  const rungs: Rung[] = [];
  let shadows = true;
  for (const name of ORDER.slice(ORDER.indexOf(top))) {
    const tier = TIERS[name];
    const lit = shadows && tier.shadowMap > 0;
    for (const scale of SCALE_STEPS) {
      rungs.push({ tier: name, scale, shadows: lit, detail: tier.detail });
    }
    const scale = SCALE_STEPS[SCALE_STEPS.length - 1] as number;
    if (lit) {
      rungs.push({ tier: name, scale, shadows: false, detail: tier.detail });
    }
    if (tier.detail.kind === 'fft' && tier.detail.patches === 2) {
      rungs.push({ tier: name, scale, shadows: false, detail: { ...tier.detail, patches: 1 } });
    }
    shadows = false;
  }
  return rungs;
}

/** The pixel ratio a rung draws at on a display of a device pixel ratio. */
export function pixelRatioOf(rung: Rung, dpr: number): number {
  return Math.min(Math.max(dpr, 1), TIERS[rung.tier].scale) * rung.scale;
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
  /** The rung to start on. */
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
    index: Math.max(0, remembered(store, top, rungs.length)),
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
  /** Mean GPU time a frame, ms, or null where the device does not measure it. */
  gpu: number | null;
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
/** Comfortable: GPU time under this share of the interval, or the main thread's work under so many ms. */
export const SPARE_GPU = 0.7;
export const SPARE_WORK = 6;
/** Comfort for this long steps up, ms; an undone step doubles it, to at most MAX_WAIT. */
export const WAIT = 10_000;
export const MAX_WAIT = 320_000;
/** A step up followed by a step down within this long was undone, ms. */
export const UNDONE = 20_000;
/** Windows within this long after a change are not counted, ms. */
export const SETTLE = 1000;
/** A window with fewer drawn frames than this says nothing. */
const FEW = 4;
const LOG = 40;

/** Adaptive quality: given each window of frames, says when to step and where to. */
export class Adaptive {
  readonly ladder: readonly Rung[];
  /** The rung in use. */
  index: number;
  enabled = true;
  /** The steps taken, the latest last. */
  readonly log: Step[] = [];
  /** How long the comfort must last before the next step up, ms: base, doubled for each step up undone. */
  base = WAIT;
  wait = WAIT;

  #slow = 0;
  #comfort = 0;
  #quietUntil = 0;
  #lastUp = Number.NEGATIVE_INFINITY;
  #lastWindow = Number.NaN;

  constructor(rungs: readonly Rung[], index: number) {
    this.ladder = rungs;
    this.index = Math.min(Math.max(index, 0), rungs.length - 1);
  }

  get rung(): Rung {
    return this.ladder[this.index] as Rung;
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
    this.#comfort = 0;
  }

  /** What was being waited for is in: windows count again a second from now. */
  unquiet(now: number): void {
    this.#quietUntil = now + SETTLE;
  }

  /**
   * Takes the window that ended at now, ms. Returns the rung to move to, or
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
    if (!this.enabled || now < this.#quietUntil || w.frames < FEW || !(w.interval > 0)) {
      return null;
    }
    const slow = w.p90 > SLOW * w.interval;
    if (slow) {
      this.#comfort = 0;
      this.#slow++;
      if (this.#slow >= 2 && this.index < this.ladder.length - 1) {
        return this.#step(now, this.index + 1, 'slow');
      }
      return null;
    }
    this.#slow = 0;
    const spare = w.gpu !== null ? w.gpu < SPARE_GPU * w.interval : w.work < SPARE_WORK;
    if (!spare) {
      this.#comfort = 0;
      return null;
    }
    this.#comfort += length;
    if (this.#comfort >= this.wait && this.index > 0) {
      return this.#step(now, this.index - 1, 'comfortable');
    }
    return null;
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
    this.log.push({ at: now, from: this.index, to, why });
    if (this.log.length > LOG) {
      this.log.shift();
    }
    this.index = to;
    this.#slow = 0;
    this.#comfort = 0;
    return to;
  }

  /** Moves to a rung by hand (the developer panel, the tests), without judging it. */
  set(now: number, to: number, why = 'set'): void {
    const index = Math.min(Math.max(to, 0), this.ladder.length - 1);
    this.log.push({ at: now, from: this.index, to: index, why });
    if (this.log.length > LOG) {
      this.log.shift();
    }
    this.index = index;
    this.#slow = 0;
    this.#comfort = 0;
  }
}

/** A rung in words, for the log and the panel. */
export function rungName(r: Rung): string {
  const d = r.detail;
  const detail =
    d.kind === 'fft'
      ? `${d.size}²${d.patches === 2 ? ' × 2' : ''}`
      : d.kind === 'baked'
        ? 'loop'
        : 'none';
  return `${r.tier} × ${r.scale}${r.shadows ? ', shadows' : ''}, ${detail}`;
}
