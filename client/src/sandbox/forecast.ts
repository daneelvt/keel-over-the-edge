// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox's forecast, made as the server makes its own: at each
// boundary of the forecast's every of world time, from the spells in play
// and the systems' records the module holds (forecastMake), with the gale
// scan over the water and the gale warning in force, its key the issue it
// came into force at; and the truth kept at each five minutes, each record's
// keyframe then. The offline page then has what a page online is sent.

import type { ChartSubject, ForecastTold, GaleTold } from '../net/messages';
import { type Forecasts, forecastOfModule, issueOf, PAST_EVERY } from '../predict/forecast';
import { RECORDS, SIZES } from '../predict/layout.gen';
import type { Keyframe, Physics } from '../predict/physics';

const G = RECORDS.galeStep;

/** What the sandbox's forecast is made from. */
export interface SandboxWeather {
  physics: Physics;
  /** The world's tick now. */
  tick: () => number;
  /** The spells in play, each a spell record's values. */
  spells: () => readonly ArrayLike<number>[];
}

/** The nearest charted island or place to a point, or null. */
export type Nearest = (
  east: number,
  north: number,
) => { subject: ChartSubject; number: number } | null;

/**
 * A forecast's gale warning from its scan: the steps it blows at, the
 * first, the most force, the direction its wind first blows from, and its
 * strongest point, as the server's weather.GaleOf finds them; null for
 * none.
 */
export function galeOf(
  scan: Float64Array,
  steps: number,
  key: number,
  nearest: Nearest,
): GaleTold | null {
  let mask = 0;
  let first = -1;
  let force = 0;
  let from = 0;
  let east = 0;
  let north = 0;
  let best = 0;
  for (let k = 0; k < steps; k++) {
    const o = k * SIZES.galeStep;
    if (!((scan[o + G.points] ?? 0) > 0)) {
      continue;
    }
    mask |= 1 << k;
    if (first < 0) {
      first = k;
      from = scan[o + G.from] ?? 0;
    }
    force = Math.max(force, scan[o + G.force] ?? 0);
    const score = (scan[o + G.mean] ?? 0) + (scan[o + G.gust] ?? 0);
    if (score > best) {
      best = score;
      east = scan[o + G.east] ?? 0;
      north = scan[o + G.north] ?? 0;
    }
  }
  if (mask === 0) {
    return null;
  }
  return {
    key,
    steps: mask,
    first,
    force,
    from,
    east: Math.round(east),
    north: Math.round(north),
    place: nearest(east, north),
  };
}

export class SandboxForecast {
  /** Told of each issue, as a page online is sent it. */
  onIssue: ((f: ForecastTold) => void) | null = null;
  readonly #w: SandboxWeather;
  readonly #forecasts: Forecasts;
  readonly #every: number;
  readonly #nearest: Nearest;
  #issued = Number.NEGATIVE_INFINITY;
  #kept = Number.NEGATIVE_INFINITY;

  constructor(w: SandboxWeather, forecasts: Forecasts, every: number, nearest: Nearest) {
    this.#w = w;
    this.#forecasts = forecasts;
    this.#every = every;
    this.#nearest = nearest;
  }

  /** Issues the forecast at each boundary passed, and keeps the truth at each five minutes. */
  tick(): void {
    const now = this.#w.tick();
    const issue = Math.floor(now / this.#every) * this.#every;
    const at = Math.floor(now / PAST_EVERY) * PAST_EVERY;
    if (at !== this.#kept) {
      this.#kept = at;
      this.#forecasts.keepKeyframe(this.keyframeAt(at));
      this.#forecasts.keepSpells(this.#w.spells());
    }
    if (issue !== this.#issued) {
      this.issueAt(issue);
    }
  }

  /** Issues the forecast at a boundary again: the weather has changed. */
  again(): void {
    const now = this.#w.tick();
    this.issueAt(Math.floor(now / this.#every) * this.#every);
  }

  /** The truth's keyframe at a tick: each record's system then, in its slot. */
  keyframeAt(tick: number): Keyframe {
    const p = this.#w.physics;
    const systems: Float64Array[] = [];
    p.systemRecords.forEach((r, slot) => {
      const s = p.systemAt(r, tick);
      if ((s[RECORDS.system.on] ?? 0) !== 0) {
        systems[slot] = Float64Array.from(s);
      }
    });
    return { tick, systems };
  }

  /** Issues the forecast at a tick, as the server issues its own. */
  issueAt(issue: number): ForecastTold {
    const p = this.#w.physics;
    p.forecastMake(issue, 0);
    const f = forecastOfModule(p);
    const steps = f.head[RECORDS.forecastHead.steps] ?? 1;
    const before = this.#forecasts.issueAt(issue - this.#every);
    const key =
      before !== null && before.gale !== null && issueOf(before) === issue - this.#every
        ? before.gale.key
        : issue;
    f.gale = galeOf(p.galeScan(), steps, key, this.#nearest);
    this.#issued = issue;
    this.#forecasts.receive(f);
    this.onIssue?.(f);
    return f;
  }
}
