// SPDX-License-Identifier: AGPL-3.0-only

// The forecast on the phone, and what has been. The server sends each
// issue as it is made, and after a Welcome the issue of ninety minutes
// before and the truth since; from then the phone keeps its own: each
// issue for ninety minutes after the next, and the systems' keyframe at
// each five minutes and the spells in play as the weather is sent. The
// past is everyone's; of the future only the forecast is ever sent.
//
// The fields the chart, a place's box, the board and the barometer read
// come from a second instance of the physics module, made when first
// needed, which holds the forecast's spells and steps, or the truth's: one
// instance cannot hold the present and a forecast at once, for the
// prediction reads its spells and keyframes mid-frame. Its fields are the
// first's exports, with the same rules, so a forecast reads as the server
// computes it.

import type { ForecastTold, PastTold, WeatherKeyframe, WeatherSpells } from '../net/messages';
import { RECORDS, SIZES, WEATHER } from './layout.gen';
import type { Keyframe, Physics } from './physics';

const H = RECORDS.forecastHead;
const P = RECORDS.spell;

/** Ticks in five minutes: the truth is kept at each boundary of them. */
export const PAST_EVERY = 5 * 60 * 30;

/** How long issues and the truth are kept, ticks: ninety minutes and a step. */
const KEEP = 100 * 60 * 30;

/** The tick an issue was issued at. */
export function issueOf(f: ForecastTold): number {
  return f.head[H.issue] ?? 0;
}

/** How many steps an issue has, the issue's own first, and how many ticks apart. */
export function stepsOf(f: ForecastTold): { steps: number; step: number } {
  return { steps: f.head[H.steps] ?? 1, step: f.head[H.step] ?? 18000 };
}

/** A keyframe off the wire, as the module's setKeyframes takes it. */
function keyframeOf(k: WeatherKeyframe): Keyframe {
  const systems: Float64Array[] = [];
  for (const [slot, v] of k.systems) {
    systems[slot] = Float64Array.from(v);
  }
  return { tick: k.tick, systems };
}

/** The issues and the truth the phone keeps. */
export class Forecasts {
  /** The issues kept, ascending by their ticks. */
  #issues: ForecastTold[] = [];
  /** The truth's keyframes at each five minutes, ascending. */
  #truth: Keyframe[] = [];
  /** The spells seen in play over the past and the present, ascending by the tick each begins at. */
  #spells: Float64Array[] = [];
  /** Counts the changes, so that whoever draws knows to read again. */
  version = 0;

  /** Forgets everything: a new world's. */
  reset(): void {
    this.#issues = [];
    this.#truth = [];
    this.#spells = [];
    this.version++;
  }

  /** Takes an issue, and what has been with it after a Welcome. */
  receive(f: ForecastTold, past: PastTold | null = null): void {
    if (past !== null) {
      this.#add(past.issue);
      for (const k of past.truth) {
        this.#keep(keyframeOf(k));
      }
      this.#spellsSeen(past.spells);
    }
    this.#add(f);
    // Its spells are the forecast's, not the truth's: those are kept as
    // they are sent in play.
    this.#forget(issueOf(f));
    this.version++;
  }

  /**
   * Takes the weather as it is sent: the spells in play, or null to keep
   * them, and keyframes, of which those at a boundary of five minutes are
   * kept as the truth.
   */
  keep(spells: WeatherSpells | null, keyframes: readonly WeatherKeyframe[]): void {
    let changed = false;
    if (spells !== null) {
      this.#spellsSeen(spells);
      changed = true;
    }
    for (const k of keyframes) {
      if (k.tick % PAST_EVERY === 0) {
        this.#keep(keyframeOf(k));
        changed = true;
      }
    }
    if (changed) {
      this.version++;
    }
  }

  /** Keeps a keyframe of the truth at its tick, as one already kept of it or in its place. */
  keepKeyframe(k: Keyframe): void {
    this.#keep(k);
    this.version++;
  }

  /** Keeps spells seen in play, each a spell record's values. */
  keepSpells(spells: readonly ArrayLike<number>[]): void {
    this.#spellsSeen(spells);
    this.version++;
  }

  #add(f: ForecastTold): void {
    const at = issueOf(f);
    this.#issues = this.#issues.filter((x) => issueOf(x) !== at);
    this.#issues.push(f);
    this.#issues.sort((a, b) => issueOf(a) - issueOf(b));
  }

  #keep(k: Keyframe): void {
    this.#truth = this.#truth.filter((x) => x.tick !== k.tick);
    this.#truth.push(k);
    this.#truth.sort((a, b) => a.tick - b.tick);
  }

  #spellsSeen(spells: readonly ArrayLike<number>[]): void {
    for (const v of spells) {
      const s = Float64Array.from(v);
      const begin = s[P.begin] ?? 0;
      const i = this.#spells.findIndex((x) => (x[P.begin] ?? 0) === begin);
      if (i >= 0) {
        this.#spells[i] = s;
      } else {
        this.#spells.push(s);
      }
    }
    this.#spells.sort((a, b) => (a[P.begin] ?? 0) - (b[P.begin] ?? 0));
  }

  /** Drops what is older than is kept, at the latest issue's tick. */
  #forget(now: number): void {
    const from = now - KEEP;
    this.#issues = this.#issues.filter((f) => issueOf(f) >= from);
    this.#truth = this.#truth.filter((k) => k.tick >= from);
    // A spell is kept while the one after it begins within what is kept.
    const n = this.#spells.length;
    this.#spells = this.#spells.filter(
      (_s, i) => i >= n - 1 || (this.#spells[i + 1]?.[P.begin] ?? 0) >= from - 2 * KEEP,
    );
  }

  /** The latest issue, or null before the first. */
  get latest(): ForecastTold | null {
    return this.#issues[this.#issues.length - 1] ?? null;
  }

  /** The issue in force at a tick, the last issued by it, or null if none is kept. */
  issueAt(tick: number): ForecastTold | null {
    let found: ForecastTold | null = null;
    for (const f of this.#issues) {
      if (issueOf(f) <= tick) {
        found = f;
      }
    }
    return found;
  }

  /** The truth's keyframes kept, ascending. */
  get truth(): readonly Keyframe[] {
    return this.#truth;
  }

  /** The spells kept, ascending by the tick each begins at. */
  get spells(): readonly Float64Array[] {
    return this.#spells;
  }

  /** The earliest tick the truth is kept from, or null for none. */
  get truthFrom(): number | null {
    return this.#truth[0]?.tick ?? null;
  }

  /**
   * The truth about a tick: the two keyframes kept about it, and the
   * spells in play then, at most WEATHER.spells: the one in effect, the
   * one before it and the one after. Null if none is kept about it.
   */
  truthAt(tick: number): { keys: Keyframe[]; spells: Float64Array[] } | null {
    const t = this.#truth;
    let k = -1;
    for (let i = 0; i < t.length; i++) {
      if ((t[i] as Keyframe).tick <= tick) {
        k = i;
      }
    }
    if (k < 0) {
      return null;
    }
    const keys = [t[k] as Keyframe];
    if (k + 1 < t.length) {
      keys.push(t[k + 1] as Keyframe);
    }
    return { keys, spells: spellsAbout(this.#spells, tick) };
  }
}

/** The spells about a tick, at most WEATHER.spells: the one in effect, the one before and the one after. */
export function spellsAbout(spells: readonly Float64Array[], tick: number): Float64Array[] {
  let i = 0;
  for (let j = 0; j < spells.length; j++) {
    if ((spells[j]?.[P.begin] ?? 0) <= tick) {
      i = j;
    }
  }
  return spells.slice(Math.max(i - 1, 0), Math.min(i + 2, spells.length)).slice(0, WEATHER.spells);
}

/** What the fields module holds now: a forecast at a tick, the truth at a tick, or the present. */
type Use =
  | { kind: 'forecast'; issue: number; version: number }
  | { kind: 'truth' }
  | { kind: 'none' };

/**
 * The fields of the forecast and of what has been, from a module of their
 * own: set it to a forecast or the truth at a tick, then read its fields
 * through the physics module's exports.
 */
export class Fields {
  readonly physics: Physics;
  #use: Use = { kind: 'none' };
  #written: ForecastTold | null = null;

  constructor(physics: Physics) {
    this.physics = physics;
  }

  /**
   * Makes the fields the forecast's at a tick: its spells and the steps
   * about the tick as keyframes, interpolated as keyframes are. The wind,
   * the pressure, the rain and the visibility then answer for it.
   */
  forecastAt(f: ForecastTold, tick: number): void {
    if (this.#written !== f) {
      this.#write(f);
    }
    this.physics.synoptic(false);
    this.physics.forecastAt(tick);
    this.physics.windDrawAt(tick);
    this.#use = { kind: 'forecast', issue: issueOf(f), version: 0 };
  }

  /** Makes the fields the truth's at a tick: its keyframes and spells. */
  truthAt(keys: readonly Keyframe[], spells: readonly ArrayLike<number>[], tick: number): void {
    const p = this.physics;
    p.synoptic(false);
    p.setRecords([]);
    p.setSpells(spells);
    p.setKeyframes(keys);
    p.windDrawAt(tick);
    this.#use = { kind: 'truth' };
  }

  /** The gale grid's points in a gale in the forecast's synoptic wind at a tick, a byte each, and the step's gale. */
  galeAt(f: ForecastTold, tick: number): { on: Uint8Array; gale: Float64Array } {
    if (this.#written !== f) {
      this.#write(f);
    }
    return this.physics.galeAt(tick);
  }

  /** The forecast's gale at each of its steps: galeStep records' values. */
  galeScan(f: ForecastTold): Float64Array {
    if (this.#written !== f) {
      this.#write(f);
    }
    return this.physics.galeScan();
  }

  /** What it holds now. */
  get use(): Use {
    return this.#use;
  }

  /** Writes an issue into the module's forecast. */
  #write(f: ForecastTold): void {
    const v = this.physics.forecast;
    v.head.fill(0);
    v.head.set(f.head.slice(0, SIZES.forecastHead));
    v.spells.fill(0);
    f.spells.slice(0, WEATHER.forecastSpells).forEach((s, i) => {
      v.spells.set(s.slice(0, SIZES.spell), i * SIZES.spell);
    });
    v.systems.fill(0);
    f.systems.slice(0, WEATHER.forecastSystems).forEach((s, i) => {
      v.systems.set(s.slice(0, SIZES.forecastSystem), i * SIZES.forecastSystem);
    });
    this.#written = f;
  }
}

/** The forecast the module made (forecastMake), as the server's issue is told. */
export function forecastOfModule(physics: Physics): ForecastTold {
  const v = physics.forecast;
  const ns = v.head[H.nSpells] ?? 0;
  const nsys = v.head[H.nSystems] ?? 0;
  const spells: number[][] = [];
  for (let i = 0; i < ns; i++) {
    spells.push([...v.spells.subarray(i * SIZES.spell, (i + 1) * SIZES.spell)]);
  }
  const systems: number[][] = [];
  for (let i = 0; i < nsys; i++) {
    systems.push([...v.systems.subarray(i * SIZES.forecastSystem, (i + 1) * SIZES.forecastSystem)]);
  }
  return { head: [...v.head], spells, systems, gale: null };
}
