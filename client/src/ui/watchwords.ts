// SPDX-License-Identifier: AGPL-3.0-only

// Every word about watching another sailor's boat, in one place: the
// buttons and headings, the counts of who watches, why a watch ended or
// was refused, the place in the spectators' queue, the question before
// the boat leaves the water, and the links that open a watch, shared,
// made anew, opened and refused.

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
  | 'aboard'
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
    case 'aboard':
      return 'Go ashore first to watch another boat.';
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

/** The queries of the links to watch: a sailor's, by its code, and a fleet's. */
export const SAILOR_PARAM = 'w';
export const FLEET_PARAM = 'f';

/** The address that opens the game watching a sailor, by its link's code, on this origin. */
export function watchLink(origin: string, code: string): string {
  return `${origin}/?${SAILOR_PARAM}=${encodeURIComponent(code)}`;
}

/** The address that opens the game watching a fleet's machine sailors, by its code. */
export function fleetLink(origin: string, code: string): string {
  return `${origin}/?${FLEET_PARAM}=${encodeURIComponent(code)}`;
}

/** A link to watch the page was opened at: a sailor's or a fleet's, by its code. */
export interface WatchLink {
  kind: 'sailor' | 'fleet';
  code: string;
}

/** A code as the links carry them: short, lower-case letters and digits. */
const CODE = /^[a-z0-9]{1,32}$/;

/** The link to watch a page was opened at, from its query; null for none. */
export function linkFromQuery(query: URLSearchParams): WatchLink | null {
  const w = query.get(SAILOR_PARAM) ?? '';
  if (CODE.test(w)) {
    return { kind: 'sailor', code: w };
  }
  const f = query.get(FLEET_PARAM) ?? '';
  return CODE.test(f) ? { kind: 'fleet', code: f } : null;
}

/** The share of the player's own link, of a machine sailor's, and of their fleet's. */
export const SHARE_ME = 'Share a link to watch me';
export const SHARE_SAILOR = 'Share a link to watch';
export const SHARE_FLEET = 'Share a link to watch my fleet';
export const SHARE_PICTURE = 'Share with a picture';

/** A machine sailor's share, named for a screen reader. */
export function shareSailorFor(name: string): string {
  return `${SHARE_SAILOR} ${name}`;
}

/** Under the player's own share while the box is unticked. */
export const SHOWN_WHEN_WATCHED = 'Your link shows your boat only on voyages you let others watch.';

/** Under the fleet's share: what it opens. */
export const FLEET_DETAIL =
  'It watches the liveliest of your machine sailors at sea, and never says whose they are.';

/** Making a link anew: the key, its question, and its answers. */
export const MAKE_NEW_LINK = 'Make a new link';
export const NEW_LINK_QUESTION = 'Your old link will stop working.';
export const KEEP_LINK = 'Keep it';
export const NEW_LINK_MADE = 'A new link: the old one no longer works.';
export const NEW_LINK_FAILED = 'A new link cannot be made just now. Try again.';

/** The picture shared, saved where the phone cannot share a file. */
export const PICTURE_SAVED = 'Picture saved, link copied';
export const PICTURE_FAILED = 'No picture can be made just now.';

/** The words on a picture shared, and over the link shared with it. */
export function watchSailText(name: string): string {
  return `Watch ${name} sail`;
}

/** The text a link is shared with, the link last, so that an app that keeps only the text keeps it. */
export function shareText(name: string, url: string): string {
  return `${watchSailText(name)} on Keel Over the Edge: ${url}`;
}

/** The text a fleet's link is shared with. */
export function fleetShareText(url: string): string {
  return `Watch my machine sailors on Keel Over the Edge: ${url}`;
}

/** On the start screen, to a visitor who came by a link to watch. */
export const MAKE_TO_WATCH = 'Make a sailor, and you will be watching.';

/** On the player's own panel, once a sailor followed from a refused link may be watched. */
export function nowWatchableText(name: string): string {
  return `${name} is sailing, and can be watched now.`;
}

/** The list's filter of a fleet opened by its link, first and chosen. */
export const THIS_FLEET = 'This fleet';

/** Why a link to watch opened no watch. */
export type LinkRefusal =
  | { why: 'cannot' | 'not-at-sea' | 'own'; name: string; machine: boolean }
  | { why: 'no-fleet' | 'no-link' | 'unread' };

/** The words at the head of the player's own panel for a link that opened no watch. */
export function linkRefusedText(r: LinkRefusal): string {
  switch (r.why) {
    case 'cannot':
      return `${r.name} cannot be watched now.`;
    case 'not-at-sea':
      return `${r.name} is not at sea.`;
    case 'own':
      return 'That is your own boat.';
    case 'no-fleet':
      return 'None of this fleet is at sea now.';
    case 'no-link':
      return 'This link is no longer in use.';
    default:
      return 'The link cannot be read just now. Open it again in a moment.';
  }
}
