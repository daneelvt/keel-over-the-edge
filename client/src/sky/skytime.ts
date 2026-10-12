// SPDX-License-Identifier: AGPL-3.0-only

// Sky time: the time the sky is drawn at, in whole microseconds since the
// sky's own epoch, which is the same in every world. It is the world's
// epoch, as the server's Welcome tells it, and the world's time since: the
// time the sea is drawn at, so the two never part. Offline there is no
// world, and the sky starts at a time of the page's choosing.
//
// The developer panel and the tests can move the sky they draw: shifted by
// an offset, run faster or held still. That changes nothing sent to the
// server, and nothing the server judges by.

import { STEPS_PER_SECOND } from '../game/clock';

/** Microseconds in a step of the world clock. */
const STEP_US = 1e6 / STEPS_PER_SECOND;

/** The module's rule: sky time from a world's epoch (µs of UTC since 1970) and its time (µs). */
export type SkyTimeRule = (worldEpoch: number, worldTime: number) => number;

export class SkyTime {
  /** The world's epoch, in microseconds of UTC since 1970. */
  epochUs: number;
  /** The developer's offset from the world's sky, in microseconds. */
  offset = 0;
  /** How fast the drawn sky runs against the world: 1 as the world, 0 held still. */
  speed = 1;

  readonly #rule: SkyTimeRule;
  #lastTicks: number | null = null;

  constructor(rule: SkyTimeRule, epochUs: number) {
    this.#rule = rule;
    this.epochUs = epochUs;
  }

  /**
   * Sky time at a world time in ticks, which need not be whole: the time
   * the frame's sea is drawn at. Called once a frame, it also runs the
   * developer's speed.
   */
  frame(ticks: number): number {
    if (this.speed !== 1 && this.#lastTicks !== null) {
      // At most a second of the world: after a pause or a jump the sky
      // does not leap.
      const moved = Math.min(Math.max(ticks - this.#lastTicks, 0), STEPS_PER_SECOND);
      this.offset += (this.speed - 1) * moved * STEP_US;
    }
    this.#lastTicks = ticks;
    return this.at(ticks);
  }

  /** Sky time at a world time in ticks, with the developer's offset. */
  at(ticks: number): number {
    return this.#rule(this.epochUs, ticks * STEP_US) + Math.round(this.offset);
  }

  /** The world's own sky time at a world time in ticks: what the server has. */
  world(ticks: number): number {
    return this.#rule(this.epochUs, ticks * STEP_US);
  }

  /** Puts the drawn sky at sky time t, in microseconds, at a world time in ticks. */
  set(t: number, ticks: number): void {
    this.offset = t - this.world(ticks);
    this.#lastTicks = ticks;
  }
}

/** A day's hours: the day is told in 24 of them, noon at 12 at the centre of the disk. */
export const HOURS = 24;

/** The hours of the day the developer panel and ?sky name. */
export const SKY_HOURS: Record<string, number> = {
  dawn: 6,
  noon: 12,
  dusk: 18,
  midnight: 0,
};

/** What ?sky asks for: an hour of the day, the moon's age as a fraction of its month, or neither. */
export interface SkyChoice {
  hour: number;
  /** 0 new, 0.5 full; null for whatever the hour brings. */
  moon: number | null;
}

/**
 * Reads ?sky: an hour by name or number (0 to 24, noon at 12), and after a
 * comma the moon's age, 0 new to 1 new again: ?sky=midnight,0.5 is a
 * full-moon midnight. Null when absent or unreadable.
 */
export function skyFromQuery(query: URLSearchParams): SkyChoice | null {
  const raw = query.get('sky');
  if (raw === null) {
    return null;
  }
  const [h = '', m] = raw.split(',');
  const hour = SKY_HOURS[h] ?? (h.trim() === '' ? Number.NaN : Number(h));
  if (!Number.isFinite(hour) || hour < 0 || hour > HOURS) {
    return null;
  }
  const moon = m === undefined ? null : Number(m);
  if (moon !== null && (!Number.isFinite(moon) || moon < 0 || moon > 1)) {
    return null;
  }
  return { hour, moon };
}

/** The sky's periods, in whole microseconds, from the catalog's numbers. */
export interface SkyPeriods {
  day: number;
  month: number;
}

/** The periods the catalog gives: its day in minutes, its month in days. */
export function skyPeriods(sky: { day: number; month: number }): SkyPeriods {
  const day = Math.round(sky.day * 60e6);
  return { day, month: Math.round(sky.month * day) };
}

/**
 * A sky time at which it is a given hour at the centre of the disk and
 * the moon is nearest a given age: the first such time at or after `from`.
 * The hour is exact; the moon's age falls within half a day of its month.
 * This chooses a time to look at; where anything stands at that time is
 * the module's to say.
 */
export function skyTimeFor(choice: SkyChoice, p: SkyPeriods, from = 0): number {
  // Noon is at the start of each day of sky time.
  const intoDay = (((choice.hour - 12) / HOURS) % 1) + (choice.hour < 12 ? 1 : 0);
  const first = Math.ceil((from - intoDay * p.day) / p.day);
  let best = first;
  if (choice.moon !== null) {
    const days = Math.ceil(p.month / p.day);
    let least = Number.POSITIVE_INFINITY;
    for (let n = first; n < first + days; n++) {
      const t = (n + intoDay) * p.day;
      const age = (t % p.month) / p.month;
      const off = Math.abs(((age - choice.moon + 1.5) % 1) - 0.5);
      if (off < least) {
        least = off;
        best = n;
      }
    }
  }
  return Math.round((best + intoDay) * p.day);
}

/** The hour of the day at the centre of the disk at sky time t: 0 to 24, noon at 12. */
export function hourAt(t: number, p: SkyPeriods): number {
  const frac = (((t % p.day) + p.day) % p.day) / p.day;
  return (frac * HOURS + 12) % HOURS;
}

/** The moon's age at sky time t, as a fraction of its month: 0 new, 0.5 full. */
export function moonAgeAt(t: number, p: SkyPeriods): number {
  return (((t % p.month) + p.month) % p.month) / p.month;
}

/**
 * Offline the sky starts two hours of the day after sunrise at the centre
 * of the disk, in the first day of sky time: the hour is 8.
 */
export const SANDBOX_HOUR = 8;

/** The sky's epoch, in microseconds of UTC since 1970. */
export function skyEpochUs(sky: { epoch: number }): number {
  return sky.epoch * 1e6;
}

/**
 * The epoch the offline sandbox counts its world from: world time 0 is
 * SANDBOX_HOUR at the centre of the disk.
 */
export function sandboxEpochUs(sky: { epoch: number; day: number; month: number }): number {
  return skyEpochUs(sky) + skyTimeFor({ hour: SANDBOX_HOUR, moon: null }, skyPeriods(sky));
}
