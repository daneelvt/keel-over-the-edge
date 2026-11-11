// SPDX-License-Identifier: AGPL-3.0-only

// The ship's clock: the world's time of day, the hour the sky is drawn at
// at the centre of the disk, one time for every sailor as a ship keeps one
// time. A 12-hour dial, so a disc beneath an aperture above the 6 turns
// once a world day, the sun and the moon opposite on it, to say whether the
// hands mean day or night: the sun stands in the window by day, the moon
// by night, and each rises into it at dawn or dusk. Its hands and its disc
// are turned by attached elements, a write when they move, never by
// drawing the case again. Beside it, in words, the time in the player's
// own form and how long until the sun rises or sets, in real minutes.

import { signal } from '@preact/signals';
import { Moved } from './model';

/** The hours of a day, and the hours the sun rises and sets at the centre of the disk. */
const DAY_HOURS = 24;
const SUNRISE = 6;
const SUNSET = 18;

/** The dial's angles, degrees clockwise from straight up: its hands', and its disc's, 0 with the sun at the top. */
export interface ClockAngles {
  hour: number;
  minute: number;
  disc: number;
}

/** Wraps an angle, degrees, into [-180, 180). */
function wrap(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** The hands' and the disc's angles at an hour of the day, 0 to 24, noon at 12. */
export function clockAngles(hour: number): ClockAngles {
  const h = ((hour % DAY_HOURS) + DAY_HOURS) % DAY_HOURS;
  return {
    hour: ((h % 12) / 12) * 360,
    minute: (h % 1) * 360,
    disc: wrap(((h - 12) / DAY_HOURS) * 360),
  };
}

/** An hour of the day as a time to be lettered: ms of a UTC day. */
function dayMs(hour: number): number {
  const h = ((hour % DAY_HOURS) + DAY_HOURS) % DAY_HOURS;
  // To the minute, as the hands read it; a hair over, so that a whole
  // minute's hour reads as that minute.
  return Math.floor(h * 60 + 1e-6) * 60_000;
}

/** "World time 4:20 PM", or "World time 16:20", in the reader's own form. */
export function worldTimeText(hour: number, locale?: string): string {
  const f = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `World time ${f.format(dayMs(hour))}`;
}

/** The hour's name alone: "World time 4 PM", "World time 16". */
export function hourText(hour: number, locale?: string): string {
  const f = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' });
  return `World time ${f.format(Math.floor(dayMs(hour) / 3_600_000) * 3_600_000)}`;
}

/**
 * How long until the sun sets, by day, or rises, by night, at the centre
 * of the disk, in real minutes from a world day of dayMinutes: "Sunset in
 * 25 min".
 */
export function sunText(hour: number, dayMinutes: number): string {
  const h = ((hour % DAY_HOURS) + DAY_HOURS) % DAY_HOURS;
  const day = h >= SUNRISE && h < SUNSET;
  const until = day ? SUNSET - h : (SUNRISE - h + DAY_HOURS) % DAY_HOURS;
  const minutes = Math.max(1, Math.ceil((until * dayMinutes) / DAY_HOURS));
  return `${day ? 'Sunset' : 'Sunrise'} in ${minutes} min`;
}

/** Turns an SVG group about its own origin, degrees. */
export const turn = (el: HTMLElement | SVGElement, deg: number): void => {
  el.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
};

/** A dial's moving parts: its hands and its disc. */
export interface ClockHands {
  hour: Moved;
  minute: Moved;
  disc: Moved;
}

/** A dial's moving parts, each written only when it moves. */
export function clockHands(): ClockHands {
  return {
    hour: new Moved(turn, 0.05),
    minute: new Moved(turn, 0.05),
    disc: new Moved(turn, 0.05),
  };
}

/** Sets a dial's hands and disc to an hour of the day. */
export function setHands(hands: ClockHands, hour: number): void {
  const a = clockAngles(hour);
  hands.hour.set(a.hour);
  hands.minute.set(a.minute);
  hands.disc.set(a.disc);
}

export class ShipsClock {
  readonly hands = clockHands();
  /** "World time 4:20 PM"; empty before the first reading. */
  readonly words = signal('');
  /** "Sunset in 25 min". */
  readonly sun = signal('');
  /** The hour's name, changed once a world hour: for a screen reader's polite status. */
  readonly named = signal('');
  /** The last hour read, 0 to 24; NaN before the first. */
  hour = Number.NaN;
  readonly #dayMinutes: number;
  readonly #locale: string | undefined;

  constructor(dayMinutes: number, locale?: string) {
    this.#dayMinutes = dayMinutes;
    this.#locale = locale;
  }

  /** Reads the world's hour of the day: the hands move, and the words where they change. */
  update(hour: number): void {
    const before = this.hour;
    this.hour = hour;
    setHands(this.hands, hour);
    this.words.value = worldTimeText(hour, this.#locale);
    this.sun.value = sunText(hour, this.#dayMinutes);
    if (!(Math.floor(before) === Math.floor(hour))) {
      this.named.value = hourText(hour, this.#locale);
    }
  }
}
