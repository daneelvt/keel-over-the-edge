// SPDX-License-Identifier: AGPL-3.0-only

// The countdown to the world's end, which the game shows at all times: by
// the world clock, which every phone shares with the server, never the
// device's own clock, which may be wrong by any amount. Over a day it
// reads in days and hours ("4d 6h"), on the last day in hours and minutes,
// in the last ten minutes in minutes and seconds, in the reader's language
// (Intl.DurationFormat's narrow style). Its text changes at most once a
// second; it is a timer (WAI-ARIA's role), which screen readers do not read
// as it changes, and the last minute is announced once. The end itself is
// shown in the player's own time with its zone's name, and in the zone the
// schedule is published in beside it when the two differ: "Monday 12:00
// NZDT (Sunday 6:00 pm ET)", so two players anywhere can agree on it.

import { signal } from '@preact/signals';

/** A world's end, as its Welcome tells it: ms of UTC since 1970, and the schedule's zone. */
export interface WorldEnd {
  world: string;
  /** When it ends, ms of UTC; 0 for no end known. */
  ends: number;
  /** When its last days begin, ms of UTC. */
  closing: number;
  /** The IANA zone the schedule is published in; "" for UTC. */
  zone: string;
  /** When it began, its epoch, ms of UTC. */
  epoch: number;
}

/** A world this young is a new world, told of once on each phone, ms. */
export const NEW_FOR = 24 * 60 * 60 * 1000;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Under this the countdown reads in minutes and seconds. */
export const SECONDS_FROM = 10 * MINUTE;

/** A duration as Intl.DurationFormat takes it. */
interface Duration {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

/** The parts the countdown reads in, for ms left. */
export function countdownParts(ms: number): Duration {
  const s = Math.max(0, Math.ceil(ms / SECOND));
  if (s * SECOND >= DAY) {
    return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600) };
  }
  if (s * SECOND >= SECONDS_FROM) {
    return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) };
  }
  return { minutes: Math.floor(s / 60), seconds: s % 60 };
}

interface DurationFormatter {
  format(d: Duration): string;
}

const formatters = new Map<string, DurationFormatter | null>();

/** Intl.DurationFormat in the narrow style, where the browser has it (Baseline 2025). */
function durationFormat(locale: string | undefined): DurationFormatter | null {
  const key = locale ?? '';
  if (!formatters.has(key)) {
    const DF = (
      Intl as unknown as { DurationFormat?: new (l?: string, o?: object) => DurationFormatter }
    ).DurationFormat;
    formatters.set(key, DF === undefined ? null : new DF(locale, { style: 'narrow' }));
  }
  return formatters.get(key) ?? null;
}

/** The time left, ms, as the countdown reads it: "4d 6h", "5h 3m", "9m 12s". */
export function leftText(ms: number, locale?: string): string {
  const d = countdownParts(ms);
  const f = durationFormat(locale);
  // Zero parts are left out, but the last minute keeps its minutes' place
  // out: "12s", and the end itself "0s".
  const shown: Duration = {};
  for (const k of ['days', 'hours', 'minutes', 'seconds'] as const) {
    const v = d[k];
    if (v !== undefined && v > 0) {
      shown[k] = v;
    }
  }
  if (Object.keys(shown).length === 0) {
    shown.seconds = 0;
  }
  if (f !== null) {
    // The narrow style leaves a zero out, even alone: the end's "0s" is
    // the seconds' unit's own.
    return shown.seconds === 0
      ? new Intl.NumberFormat(locale, {
          style: 'unit',
          unit: 'second',
          unitDisplay: 'narrow',
        }).format(0)
      : f.format(shown);
  }
  const unit = { days: 'd', hours: 'h', minutes: 'm', seconds: 's' } as const;
  return (Object.keys(shown) as (keyof Duration)[]).map((k) => `${shown[k]}${unit[k]}`).join(' ');
}

/** The device's own time zone. */
function deviceZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The end, in the player's own zone with its name, and in the schedule's
 * published zone when that differs: "Monday 12:00 NZDT (Sunday 6:00 pm
 * ET)". A schedule of periods is published in UTC.
 */
export function endText(
  ends: number,
  scheduleZone: string,
  locale?: string,
  zone?: string,
): string {
  const own = zone ?? deviceZone();
  const at = new Date(ends);
  const local = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: own,
  }).format(at);
  const published = scheduleZone === '' ? 'UTC' : scheduleZone;
  if (sameZone(own, published, at)) {
    return local;
  }
  const there = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: published === 'UTC' ? 'short' : 'shortGeneric',
    timeZone: published,
  }).format(at);
  return `${local} (${there})`;
}

/** Whether two zones are one: the same name, or the same wall clock and name at the instant. */
function sameZone(a: string, b: string, at: Date): boolean {
  if (a === b) {
    return true;
  }
  const f = (z: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone: z, dateStyle: 'short', timeStyle: 'long' }).format(
      at,
    );
  try {
    return f(a) === f(b);
  } catch {
    return false;
  }
}

/** What the screen shows of the world's end, written at most once a second. */
export class Countdown {
  /** The world's end, from the latest Welcome, or null before one. */
  readonly end = signal<WorldEnd | null>(null);
  /** The time left, as it reads; "" with no end known. */
  readonly text = signal('');
  /** The world is in its last days. */
  readonly closing = signal(false);
  /** The end, in the player's own time and the schedule's. */
  readonly when = signal('');
  /** Set once in the last minute, for a screen reader to announce once. */
  readonly last = signal('');
  /** ms left at the last tick; Infinity with no end known. */
  left = Number.POSITIVE_INFINITY;
  /** The world clock as UTC, ms; NaN while it is not known. */
  readonly now: () => number;
  readonly #locale: string | undefined;

  constructor(now: () => number, locale?: string) {
    this.now = now;
    this.#locale = locale;
  }

  /** The world's end, as a Welcome tells it. */
  setEnd(e: WorldEnd): void {
    const was = this.end.value;
    if (was !== null && was.world === e.world && was.ends === e.ends) {
      return;
    }
    this.end.value = e;
    this.when.value = e.ends === 0 ? '' : endText(e.ends, e.zone, this.#locale);
    this.last.value = '';
    this.tick();
  }

  /** Brings the countdown to the world clock's now. */
  tick(): void {
    const e = this.end.value;
    const now = this.now();
    if (e === null || e.ends === 0 || Number.isNaN(now)) {
      this.left = Number.POSITIVE_INFINITY;
      if (this.text.value !== '') {
        this.text.value = '';
      }
      return;
    }
    this.left = e.ends - now;
    const text = leftText(this.left, this.#locale);
    if (text !== this.text.value) {
      this.text.value = text;
    }
    const closing = now >= e.closing;
    if (closing !== this.closing.value) {
      this.closing.value = closing;
    }
    if (this.left <= MINUTE && this.left > 0 && this.last.value === '') {
      this.last.value = 'The falls take this world in a minute.';
    }
  }
}

/** Where the notices of each world shown on this phone are kept. */
const SHOWN_KEY = 'keel.worldNotices';

/** What a phone keeps of the world's notices shown: by world, the notices' keys. */
export interface ShownStore {
  get(world: string): string[];
  add(world: string, key: string): void;
}

/** The notices shown, kept in localStorage, the newest few worlds; in memory where it is refused. */
export function localShown(storage: Storage | null = safeStorage()): ShownStore {
  const memory = new Map<string, string[]>();
  const read = (): Record<string, string[]> => {
    try {
      return JSON.parse(storage?.getItem(SHOWN_KEY) ?? '{}') as Record<string, string[]>;
    } catch {
      return {};
    }
  };
  return {
    get(world) {
      return read()[world] ?? memory.get(world) ?? [];
    },
    add(world, key) {
      const all = read();
      const keys = [...(all[world] ?? memory.get(world) ?? []), key];
      memory.set(world, keys);
      all[world] = keys;
      // A world's notices are kept while it may be sailed: the last few.
      const worlds = Object.keys(all);
      for (const w of worlds.slice(0, Math.max(0, worlds.length - 4))) {
        delete all[w];
      }
      try {
        storage?.setItem(SHOWN_KEY, JSON.stringify(all));
      } catch {
        // Private browsing, or no room: kept for the page's life.
      }
    },
  };
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Raises a notice: Notices.raise. */
type Raise = (on: string, fill: Record<string, string>, now: number) => void;

/** The kinds of notice of the world's end: what raises each, and the minutes before the end for a near end's. */
export interface EndNoticeKind {
  on: string;
  before?: readonly number[];
}

/**
 * The notices of a world's life, worked out on the phone from the end its
 * Welcome gives and the world clock, each shown once a world: the closing
 * (from its start, so a player who comes on Friday is still told once), the
 * end near at each of its times before (only within a minute of it, never
 * late), and a new world at its first Welcome.
 */
export class EndNotices {
  readonly #countdown: Countdown;
  readonly #kinds: readonly EndNoticeKind[];
  readonly #shown: ShownStore;
  readonly #raise: Raise;
  readonly #locale: string | undefined;

  constructor(
    countdown: Countdown,
    kinds: readonly EndNoticeKind[],
    shown: ShownStore,
    raise: Raise,
    locale?: string,
  ) {
    this.#countdown = countdown;
    this.#kinds = kinds;
    this.#shown = shown;
    this.#raise = raise;
    this.#locale = locale;
  }

  #once(world: string, key: string, on: string, fill: Record<string, string>, now: number): void {
    if (this.#shown.get(world).includes(key)) {
      return;
    }
    this.#shown.add(world, key);
    this.#raise(on, fill, now);
  }

  /**
   * A Welcome, now ms of the page's clock: a world begun within NEW_FOR by
   * the world clock is told of once, a new world; an older one, which the
   * player has merely not sailed before, is not.
   */
  welcome(now: number): void {
    const e = this.#countdown.end.value;
    const utc = this.#countdown.now();
    if (e === null || Number.isNaN(utc) || utc - e.epoch >= NEW_FOR || utc < e.epoch) {
      return;
    }
    if (this.#kinds.some((k) => k.on === 'new-world')) {
      this.#once(e.world, 'new', 'new-world', {}, now);
    }
  }

  /** At each tick of the countdown: the notices due, now ms of the page's clock. */
  tick(now: number): void {
    const c = this.#countdown;
    const e = c.end.value;
    if (e === null || e.ends === 0 || !Number.isFinite(c.left) || c.left <= 0) {
      return;
    }
    if (c.closing.value && this.#kinds.some((k) => k.on === 'falls-coming')) {
      this.#once(e.world, 'closing', 'falls-coming', { day: c.when.value }, now);
    }
    for (const k of this.#kinds) {
      if (k.on !== 'falls-soon') {
        continue;
      }
      for (const m of k.before ?? []) {
        const at = m * MINUTE;
        if (c.left <= at && c.left > at - MINUTE) {
          this.#once(e.world, `soon-${m}`, 'falls-soon', { left: leftText(at, this.#locale) }, now);
        }
      }
    }
  }
}
