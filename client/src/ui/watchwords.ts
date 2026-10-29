// SPDX-License-Identifier: AGPL-3.0-only

// Every word about watching another sailor's boat, in one place: the
// buttons and headings, the counts of who watches, why a watch ended or
// was refused, the place in the spectators' queue, the question before
// the boat leaves the water, and the link that opens a watch.

import type { Place } from '../net/online';
import { ordinal } from './queue';

export const WATCH = 'Watch';
export const WATCHING = 'Watching';
export const WATCH_ANOTHER = 'Watch another';
export const WATCH_ANOTHER_SAILOR = 'Watch another sailor';
export const WATCH_A_SAILOR = 'Watch a sailor';
export const STOP_WATCHING = 'Stop watching';
export const SAIL = 'Sail';
export const SPECTATORS = 'spectators';
export const COPY_WATCH_LINK = 'Copy a link to watch';
export const COPIED = 'Copied';
export const BEHIND_THE_BOAT = 'Behind the boat';
export const MORE = 'More';
export const CLOSE = 'Close';
export const SEARCH = 'Part of a name';
export const READING = 'Reading who is at sea…';
export const UNREADABLE = 'Who is at sea cannot be read just now. Try again.';

/** The notice when the queue for a boat gives one to a player who was watching. */
export const BOAT_IN_THE_WATER = 'Your boat is in the water.';

/** The question before a sailing player's boat leaves the water to watch, and its answers. */
export const LEAVE_QUESTION = 'Leave the water to watch?';
export const LEAVE_DETAIL = 'Your boat leaves the water now. Sailing again starts at the start.';
export const LEAVE = 'Leave the water';
export const STAY = 'Stay';

/** The start screen's warning to a player whose boat is still at sea. */
export const STILL_AT_SEA = 'Your boat is still in the water: watching takes it out';

/** Who may watch the account's boat, as GET /api/me names it: no one, or anyone for the voyage. */
export type Spectators = 'no' | 'voyage';

/** How many watch a boat: "3 watching"; "" for none. */
export function watchersText(n: number): string {
  return n >= 1 ? `${n} watching` : '';
}

/** Why a watch ended or was refused, as the worker names WatchEnded's reasons. */
export type WatchEndWhy =
  | 'left'
  | 'off'
  | 'cannot'
  | 'not-at-sea'
  | 'no-sailor'
  | 'own'
  | 'quick'
  | 'busy'
  | 'other';

/** The words of a watch ended or refused, the sailor named as the server names them. */
export function endedText(why: WatchEndWhy, sailor: string): string {
  switch (why) {
    case 'left':
      return `${sailor} has left the water.`;
    case 'off':
      return `${sailor} no longer allows spectators.`;
    case 'not-at-sea':
      return `${sailor} is not at sea.`;
    case 'no-sailor':
      return `There is no sailor called ${sailor}.`;
    case 'own':
      return 'That is your own boat.';
    case 'quick':
      return 'One at a time: try again in a moment.';
    case 'busy':
      return 'The harbour is busy: try again in a moment.';
    default:
      return `${sailor} cannot be watched now.`;
  }
}

/** The place in the spectators' queue: "Many are watching. You are 12th in line to watch." */
export function spectatorQueueLine(p: Place): string {
  const place =
    p.position === 1
      ? 'You are next in line to watch.'
      : `You are ${ordinal(p.position)} in line to watch.`;
  return `Many are watching. ${place}`;
}

/** A bump the watched boat was in, in the third person. */
export function bumpedLine(sailor: string): string {
  return `${sailor} was bumped`;
}

/** The address that opens the game watching a sailor, on this origin. */
export function watchLink(origin: string, sailor: string): string {
  return `${origin}/?watch=${encodeURIComponent(sailor)}`;
}

/** The sailor a page was opened to watch, from its query: "" for none. */
export function watchFromQuery(query: URLSearchParams): string {
  return (query.get('watch') ?? '').trim();
}
