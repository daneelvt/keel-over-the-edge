// SPDX-License-Identifier: AGPL-3.0-only

// The words of races ashore: when a race starts, in the reader's own time;
// who may enter; the entrants by name, or by their boat and number where a
// name is not the reader's to see; and every refusal, told kindly and with
// when it lifts, so that a sailor at a limit knows what to do next and
// can still watch.

import { leftText } from './countdown';
import type { Entrant, Phase, RaceCard, Summary, Who } from './raceapi';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A time of day in the reader's own time: "4:10 PM". */
export function clockText(ms: number, locale?: string, zone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(new Date(ms));
}

/** The calendar day of ms in a zone, as a string to compare. */
function dayOf(ms: number, zone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(new Date(ms));
}

/**
 * When a race starts, in the reader's own time: the time alone today,
 * "tomorrow" and the time, and the day's name within the week: "4:00 PM",
 * "tomorrow 9:00 AM", "Tuesday 4:00 PM".
 */
export function whenText(ms: number, now: number, locale?: string, zone?: string): string {
  const time = clockText(ms, locale, zone);
  const day = dayOf(ms, zone);
  if (day === dayOf(now, zone)) {
    return time;
  }
  if (day === dayOf(now + DAY, zone)) {
    return `tomorrow ${time}`;
  }
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(new Date(ms));
  return `${weekday} ${time}`;
}

/** The same, with its first letter a capital, to begin a line. */
export function whenLine(ms: number, now: number, locale?: string, zone?: string): string {
  const t = whenText(ms, now, locale, zone);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The time to the start, as the countdown reads: "Starts in 9m 12s"; "Starting" once it is due. */
export function startsInText(ms: number, locale?: string): string {
  return ms <= 0 ? 'Starting' : `Starts in ${leftText(ms, locale)}`;
}

/** A kind of boat, many of them: "Jolly boats". */
export function boatsText(name: string): string {
  if (name === '') {
    return '';
  }
  return /s$/.test(name) ? name : `${name}s`;
}

/** Who may enter, as a choice reads. */
export function whoText(who: Who): string {
  switch (who) {
    case 'humans':
      return 'Human sailors only';
    case 'machines':
      return 'Machine sailors only';
    case 'newcomers':
      return 'Newcomers only';
    default:
      return 'Everyone';
  }
}

/** Under newcomers' choice: who a newcomer is. */
export const NEWCOMERS_DETAIL = 'Sailors with fewer than five races sailed';

/** A race or a time trial. */
export function kindText(kind: 'race' | 'trial'): string {
  return kind === 'trial' ? 'Time trial' : 'Race';
}

/** The race's owner, as the card names them: the Harbourmaster for the world's own. */
export function ownerText(card: Pick<RaceCard, 'owner' | 'harbour'>): string {
  if (card.harbour || card.owner === null) {
    return 'the Harbourmaster';
  }
  return card.owner.name ?? 'a sailor';
}

/** How an entrant is shown: their name, or their boat and number, or the number alone. */
export type EntrantLabel =
  | { kind: 'name'; name: string; machine: boolean }
  | { kind: 'boat'; boat: string; number: number }
  | { kind: 'number'; number: number };

/**
 * An entrant as the card shows them: by name, a machine sailor marked; one
 * not named to the reader by their boat's name and number, "the Gull, 7",
 * or "No. 7" with no boat's name.
 */
export function entrantLabel(e: Entrant): EntrantLabel {
  if (e.name !== null && e.name !== '') {
    return { kind: 'name', name: e.name, machine: e.machine };
  }
  if (e.boat != null && e.boat !== '') {
    return { kind: 'boat', boat: e.boat, number: e.number };
  }
  return { kind: 'number', number: e.number };
}

/** An entrant in words: "Mira", "Grey Gull ⚙", "the Gull, 7", "No. 7". */
export function entrantText(e: Entrant): string {
  const l = entrantLabel(e);
  switch (l.kind) {
    case 'name':
      return l.machine ? `${l.name} ⚙` : l.name;
    case 'boat':
      return `the ${l.boat}, ${l.number}`;
    default:
      return `No. ${l.number}`;
  }
}

/** How many are entered, of the most: "5 entered of 12". */
export function enteredText(n: number, most: number): string {
  return most > 0 ? `${n} entered of ${most}` : `${n} entered`;
}

/** The keys that replay a race on the chart, and a time trial's runs together. */
export const REPLAY = 'Replay';
export const REPLAY_RUNS = 'Replay the runs';

/** Where a race stands, where it is past entering: "" while it may be entered. */
export function phaseText(phase: Phase): string {
  switch (phase) {
    case 'starting':
    case 'racing':
      return 'The race is under way.';
    case 'finished':
    case 'ended':
      return 'This race is over.';
    case 'cancelled':
      return 'This race was cancelled.';
    case 'closed':
      return 'Entry is closed.';
    default:
      return '';
  }
}

/** The harbour board's line of a harbour race: "4:00 PM · Jolly boats · 5 entered". */
export function harbourLine(s: Summary, now: number, locale?: string, zone?: string): string {
  return `${whenLine(s.startsAt, now, locale, zone)} · ${boatsText(s.boat.name)} · ${s.entered} entered`;
}

/** A small number in words, as a limit is told; figures past twelve. */
export function countWords(n: number): string {
  const words = [
    'no',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
  ];
  return words[n] ?? String(n);
}

/** What the limits' words may name: when a refusal lifts, and the time now, ms of UTC. */
export interface RefusalTime {
  until?: number | undefined;
  now: number;
  locale?: string;
  zone?: string;
}

/** When a refusal lifts, as a line ends: " after 4:10 PM"; "" when it is not told. */
function after(t: RefusalTime): string {
  return t.until === undefined || t.until <= 0
    ? ''
    : ` after ${whenText(t.until, t.now, t.locale, t.zone)}`;
}

/** The words of a refusal that may come of any act, where the act's own have none. */
function common(reason: string): string {
  switch (reason) {
    case 'not-found':
      return 'There is no race at this link. It may have been copied short.';
    case 'not-owner':
      return 'Only the race’s owner can do that.';
    case 'offline':
      return 'The harbour cannot be reached. Check the connection and try again.';
    case 'cancelled':
      return 'This race was cancelled.';
    case 'finished':
      return 'This race is over.';
    default:
      return 'That cannot be done just now. Try again in a moment.';
  }
}

/**
 * Why a race cannot be entered, kindly, with when it may be: "You’ve
 * raced as often as a day allows. Your next race can start after 4:10 PM."
 */
export function enterRefusalText(reason: string, t: RefusalTime): string {
  switch (reason) {
    case 'full':
      return 'This race is full: every place is taken.';
    case 'closed':
      return 'The race’s owner has closed entry.';
    case 'started':
      return 'Entry closed at the warning signal, two minutes before the start.';
    case 'humans':
      return 'This race is for human sailors only.';
    case 'machines':
      return 'This race is for machine sailors only.';
    case 'newcomers':
      return 'This race is for newcomers, sailors with fewer than five races sailed. Come and cheer them on.';
    case 'blocked':
      return 'You can’t enter this race.';
    case 'ahead': {
      const a = after(t);
      return a === ''
        ? 'You’re entered in as many races ahead as you can be. Enter another once one has started.'
        : `You’re entered in as many races ahead as you can be. You can enter another${a}.`;
    }
    case 'daily': {
      const a = after(t);
      return a === ''
        ? 'You’ve raced as often as a day allows. Rest a while, and race again later.'
        : `You’ve raced as often as a day allows. Your next race can start${a}.`;
    }
    case 'entered':
      return 'You’re entered already.';
    case 'clash':
      return 'You’re entered in another race that starts within 20 minutes of this one.';
    case 'late':
      return 'The world ends too soon to sail this trial now.';
    case 'not-entered':
      return 'You’re not entered in this race.';
    default:
      return common(reason);
  }
}

/** Why a race cannot be made, kindly, with when it may be. */
export function makeRefusalText(reason: string, t: RefusalTime, name?: string): string {
  switch (reason) {
    case 'made': {
      const a = after(t);
      return a === ''
        ? 'You’ve made as many races as a day allows. Make the next one later.'
        : `You’ve made as many races as a day allows. You can make the next${a}.`;
    }
    case 'owned':
      return 'You have as many races of your own still to sail as you can. Make another once one is over.';
    case 'soon':
      return 'Give the sailors at least five minutes before the start.';
    case 'late': {
      const until = t.until;
      return until === undefined || until <= 0
        ? 'That’s too near the world’s end. Choose an earlier start.'
        : `That’s too near the world’s end. The latest start is ${whenText(until, t.now, t.locale, t.zone)}.`;
    }
    case 'course':
      return 'That course isn’t open to this boat. Choose another.';
    case 'areas':
      return 'Every racing area is busy at that time. Try another start, or an island course.';
    case 'who':
      return 'That choice of who may enter isn’t open to you.';
    case 'boat':
      return 'There is no such boat. Choose another.';
    case 'name':
      return nameRefusalText(name ?? '');
    default:
      return common(reason);
  }
}

/** Why a race's name was refused. */
export function nameRefusalText(why: string): string {
  switch (why) {
    case 'short':
      return 'That name is too short.';
    case 'long':
      return 'That name is too long.';
    case 'characters':
      return 'Use letters and numbers in the name, with single spaces and a little punctuation.';
    case 'scripts':
      return 'Use the letters of one alphabet in the name.';
    default:
      return 'That name is not allowed. Try another.';
  }
}

/** Why the owner's act, or a withdrawal, was refused. */
export function actRefusalText(reason: string, t: RefusalTime): string {
  switch (reason) {
    case 'moved':
      return 'The start can be changed only once.';
    case 'started':
      return 'The start sequence has begun: the race runs itself now.';
    case 'not-entered':
      return 'There is no entrant with that number.';
    case 'not-finished':
      return 'The race can be sailed again once it is over.';
    case 'soon':
    case 'late':
      return makeRefusalText(reason, t);
    default:
      return common(reason);
  }
}

/** The Enter key's line: what entering means. */
export const ENTER_LINE = 'Everyone can watch you while you race.';

/** Watch when it starts, once asked. */
export const WATCH_LATER = 'You can watch it from the start.';

/** On the start screen, to a visitor who came by a race's link. */
export const MAKE_TO_RACE = 'Make a sailor, and you can enter the race.';

/** The keys of races ashore. */
export const MAKE_A_RACE = 'Make a race';
export const MAKE_IT = 'Make it';
export const ENTER = 'Enter';
export const ENTER_WITH_CREW = 'Enter with my crew';
export const WATCH_WHEN_STARTS = 'Watch when it starts';

/** The notice's key as a race asked to be watched starts. */
export const WATCH = 'Watch';
export const ADD_TO_CALENDAR = 'Add to calendar';
export const WITHDRAW = 'Withdraw';
export const CLOSE = 'Close';

/** The text a race's link is shared with, the link last. */
export function raceShareText(
  name: string,
  boats: string,
  when: string,
  url: string,
  trial = false,
): string {
  return trial
    ? `${name}, a time trial for ${boats}, on Keel Over the Edge: ${url}`
    : `Race with me: ${name}, ${boats}, ${when}. Enter on Keel Over the Edge: ${url}`;
}

/** The text minutes a race is expected to take: "about 10 minutes". */
export function minutesText(m: number): string {
  if (m <= 0) {
    return '';
  }
  const r = Math.max(1, Math.round(m));
  return r === 1 ? 'about a minute' : `about ${r} minutes`;
}

/** A course's length in nautical miles, to one place: "2.4 NM". */
export function lengthText(m: number): string {
  return m > 0 ? `${(m / 1852).toFixed(1)} NM` : '';
}

/** The starts offered, minutes from now; 0 for a later time of the player's choosing. */
export const STARTS = [10, 30, 60, 0] as const;

/** A start's choice in words. */
export function startChoiceText(m: number): string {
  if (m === 0) {
    return 'Later';
  }
  return m === 60 ? 'In 1 hour' : `In ${m} min`;
}

/** The Greenhorn Cup's times, the week's, as the board lists them: "Saturday 3:00 PM, …". */
export function greenhornText(
  starts: readonly number[],
  now: number,
  locale?: string,
  zone?: string,
): string {
  return starts
    .filter((s) => s > now)
    .map((s) => whenText(s, now, locale, zone))
    .join(' · ');
}

/** Whether a race is for newcomers only: the Greenhorn Cup among the harbour's. */
export function forNewcomers(s: { who: Who }): boolean {
  return s.who === 'newcomers';
}

/** The minute rounded down: a start offered at a whole minute. */
export function wholeMinute(ms: number): number {
  return Math.floor(ms / MINUTE) * MINUTE;
}

/** When a race starts, for others anywhere: its day, time and the zone's short name, "Saturday 4:00 PM NZDT". */
export function zonedWhenText(ms: number, locale?: string, zone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(zone === undefined ? {} : { timeZone: zone }),
  }).format(new Date(ms));
}

/** Two digits. */
function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** A time as a datetime-local field holds it, in the device's own time: "2026-11-14T16:00". */
export function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A datetime-local field's value as ms of UTC; NaN for none. */
export function fromLocalInput(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (m === null) {
    return Number.NaN;
  }
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
}

/** A later start's first offer: two hours on, at the quarter hour, within the bounds. */
export function laterDefault(now: number, earliest: number, latest: number): number {
  const quarter = 15 * MINUTE;
  const t = Math.ceil((now + 2 * 60 * MINUTE) / quarter) * quarter;
  return Math.max(earliest, Math.min(latest, t));
}

/** The start of a race made now: minutes on (a whole minute), or the later time chosen. */
export function startOf(choice: number, later: string, now: number): number {
  return choice > 0 ? wholeMinute(now) + choice * MINUTE : fromLocalInput(later);
}
