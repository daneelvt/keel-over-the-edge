// SPDX-License-Identifier: AGPL-3.0-only

// The notices of races, worked out on the phone from the board the server
// last gave and the world clock: the next harbour race, at each of its
// kind's minutes before the start, for a sailor who may enter it and has
// not; and each race the sailor has entered, at each of its kind's. Each
// once, and only within the minute of its time, never late. A race the
// sailor entered that a storm called off at its warning signal is told
// once, within the half hour after its start, with the next harbour race;
// one whose warning came while the boat raced in another, once, soon
// after. And the player's next race, shown on the race line from half an
// hour before its start.

import { leftText } from './countdown';
import type { RacesBoard, Summary } from './raceapi';
import { boatsText, calledOffFill } from './racewords';

const MINUTE = 60_000;

/** A kind of race notice, as the catalog has it: what raises it, and its minutes before the start. */
export interface RaceNoticeKind {
  on: string;
  before?: readonly number[];
}

/** What raises the harbour's notice and the entered races'. */
export const HARBOUR_RACE = 'harbour-race';
export const RACE_SOON = 'race-soon';
export const RACE_CALLED_OFF = 'race-called-off';

/** How long after its start a race called off is still told of, ms. */
const CALLED_OFF_TOLD = 30 * MINUTE;

/** A notice due: what raises it, its words, and the race it is of. */
export interface RaceNoticeDue {
  on: string;
  fill: Record<string, string>;
  race: Summary;
  /** Whether it offers Enter: the harbour race's. */
  enter: boolean;
}

/**
 * The notices due at now (ms of UTC) from the board: each kind's minutes
 * before the start, within the minute after each; none already shown
 * (keys in shown, which this adds to).
 */
export function dueNotices(
  board: RacesBoard,
  kinds: readonly RaceNoticeKind[],
  now: number,
  shown: Set<string>,
  locale?: string,
): RaceNoticeDue[] {
  const out: RaceNoticeDue[] = [];
  const at = (on: string, s: Summary, enter: boolean) => {
    for (const k of kinds) {
      if (k.on !== on) {
        continue;
      }
      for (const m of k.before ?? []) {
        const left = s.startsAt - now;
        const t = m * MINUTE;
        const key = `${on}:${s.code}:${m}`;
        if (left <= t && left > t - MINUTE && !shown.has(key)) {
          shown.add(key);
          out.push({
            on,
            fill: { name: s.name, left: leftText(t, locale), boat: boatsText(s.boat.name) },
            race: s,
            enter,
          });
        }
      }
    }
  };
  // The next harbour race: for a sailor who may enter it and has not.
  const next = board.harbour.find((s) => s.phase === 'open' || s.phase === 'closed');
  if (next?.enter.ok && !next.mine.entered) {
    at(HARBOUR_RACE, next, true);
  }
  for (const s of board.mine) {
    if (s.mine.entered && s.phase !== 'cancelled') {
      at(RACE_SOON, s, false);
    }
  }
  // A race entered that a storm called off: once, soon after.
  if (kinds.some((k) => k.on === RACE_CALLED_OFF)) {
    for (const s of board.mine) {
      const key = `${RACE_CALLED_OFF}:${s.code}`;
      if (
        s.mine.entered &&
        s.phase === 'cancelled' &&
        s.calledOff === 'storm' &&
        now < s.startsAt + CALLED_OFF_TOLD &&
        !shown.has(key)
      ) {
        shown.add(key);
        out.push({
          on: RACE_CALLED_OFF,
          fill: calledOffFill(s, board.harbour, now, locale),
          race: s,
          enter: false,
        });
      }
    }
  }
  return out;
}

/** How long before its start a race's warning signal is, ms: its boats are placed then. */
export const WARNING = 2 * MINUTE;

/** How long before its start a race entered is shown on the race line, ms. */
export const WAITING_SHOWN = 30 * MINUTE;

/** The player's next race on the board: the soonest race (not a trial) they are in, not over; null for none. */
export function nextRace(board: RacesBoard): Summary | null {
  let out: Summary | null = null;
  for (const s of board.mine) {
    const live =
      s.phase === 'open' || s.phase === 'closed' || s.phase === 'starting' || s.phase === 'racing';
    if (
      s.kind === 'race' &&
      s.mine.entered &&
      live &&
      (out === null || s.startsAt < out.startsAt)
    ) {
      out = s;
    }
  }
  return out;
}

/**
 * The race the player is in that the race line shows before its warning
 * signal, at now (ms of UTC): their next, starting within WAITING_SHOWN;
 * null for none.
 */
export function waitingRace(board: RacesBoard | null, now: number): Summary | null {
  const s = board === null ? null : nextRace(board);
  if (s === null || (s.phase !== 'open' && s.phase !== 'closed')) {
    return null;
  }
  const left = s.startsAt - now;
  return left > WARNING && left <= WAITING_SHOWN ? s : null;
}

/** How long after a race's warning signal its sitting out is still told, ms. */
const SAT_OUT_TOLD = MINUTE;

/**
 * The races the player is in whose warning signal came while they raced
 * in another (by its code), each once (keys in shown, which this adds to):
 * the boat sailed on in its race and sat these out.
 */
export function satOut(
  board: RacesBoard,
  racingIn: { code: string; name: string } | null,
  now: number,
  shown: Set<string>,
): Summary[] {
  if (racingIn === null || racingIn.code === '') {
    return [];
  }
  const out: Summary[] = [];
  for (const s of board.mine) {
    const since = now - (s.startsAt - WARNING);
    const key = `sat-out:${s.code}`;
    if (
      s.kind === 'race' &&
      s.mine.entered &&
      s.code !== racingIn.code &&
      s.phase !== 'cancelled' &&
      since >= 5_000 &&
      since < SAT_OUT_TOLD &&
      !shown.has(key)
    ) {
      shown.add(key);
      out.push(s);
    }
  }
  return out;
}

/** A race the player asked to watch when it starts, as its card said: its code, name and start, ms of UTC. */
export interface WatchedRace {
  code: string;
  name: string;
  startsAt: number;
}

/** How long before its start a race asked to be watched is offered, ms: the boats are on the line. */
export const WATCH_OFFERED = MINUTE;

/**
 * The races asked to be watched whose start is within WATCH_OFFERED of now
 * (ms of UTC), each once (keys in shown, which this adds to): offered with
 * Watch on the entered races' notice, its minute before the start.
 */
export function dueWatches(
  races: readonly WatchedRace[],
  now: number,
  shown: Set<string>,
  locale?: string,
): { race: WatchedRace; fill: Record<string, string> }[] {
  const out: { race: WatchedRace; fill: Record<string, string> }[] = [];
  for (const r of races) {
    const left = r.startsAt - now;
    const key = `watch:${r.code}`;
    if (left > 0 && left <= WATCH_OFFERED && !shown.has(key)) {
      shown.add(key);
      out.push({ race: r, fill: { name: r.name, left: leftText(Math.max(left, 1000), locale) } });
    }
  }
  return out;
}
