// SPDX-License-Identifier: AGPL-3.0-only

// The notices of races, worked out on the phone from the board the server
// last gave and the world clock: the next harbour race, at each of its
// kind's minutes before the start, for a sailor who may enter it and has
// not; and each race the sailor has entered, at each of its kind's. Each
// once, and only within the minute of its time, never late.

import { leftText } from './countdown';
import type { RacesBoard, Summary } from './raceapi';
import { boatsText } from './racewords';

const MINUTE = 60_000;

/** A kind of race notice, as the catalog has it: what raises it, and its minutes before the start. */
export interface RaceNoticeKind {
  on: string;
  before?: readonly number[];
}

/** What raises the harbour's notice and the entered races'. */
export const HARBOUR_RACE = 'harbour-race';
export const RACE_SOON = 'race-soon';

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
  return out;
}
