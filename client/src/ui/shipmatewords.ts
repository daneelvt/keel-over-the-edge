// SPDX-License-Identifier: AGPL-3.0-only

// Every word about shipmates, in one place: the panel and its rows, an
// offer and what came of it, ending and blocking, a thread of messages
// and why one was not sent, the notices under the case, and "Appear
// offline". A name a player wrote is kept apart from the words around it
// ({ player }), as in deckwords.ts. Nothing here ever says anyone's age,
// or why an offer has not been answered.

import type { Presence } from '../account/shipmatesapi';
import type { ChatRefusalTold } from '../net/messages';
import type { Words } from './deckwords';

/** A player's text among words. */
function p(text: string): { player: string } {
  return { player: text };
}

export const SHIPMATES = 'Shipmates';
export const SHIPMATE = 'shipmate';
export const STAR = '★';
export const OFFERS_WAITING = 'Would like to be shipmates';
export const RECENT_CREW = 'Recent crew';
export const RECENT_DETAIL = 'Who you sailed with in the last day';
export const READING = 'Reading your shipmates…';
export const UNREADABLE = 'Your shipmates can’t be read just now. Try again in a moment.';
export const NO_SHIPMATES =
  'No shipmates yet: sail with someone a while and offer from Who’s aboard.';
export const NO_RECENT = 'Nobody yet: sail with someone and they’ll show here for a day.';

/** Where a shipmate is, under their name; "" for nothing shown. */
export function presenceText(p: Presence): string {
  switch (p) {
    case 'game':
      return 'in the game';
    case 'sea':
      return 'at sea';
    default:
      return '';
  }
}

/** A recent crew member's tags: "shipmate", or "offered" while the player's offer waits. */
export const OFFERED_TAG = 'offered';

export const BE_SHIPMATES = 'Be shipmates';
export const NO_LONGER = 'No longer shipmates';
export const ACCEPT = 'Accept';
export const DECLINE = 'Decline';
export const MESSAGE = 'Message';
export const ASK_ABOARD = 'Ask to come aboard';
export const KEEP = 'Keep';

/** The one question before ending: "No longer shipmates with Iron Mary?" */
export function endWords(name: string): Words {
  return ['No longer shipmates with ', p(name), '?'];
}

/** What came of an offer, or of accepting one, in plain words. */
export function offerWords(result: string, name: string): Words {
  switch (result) {
    case 'offered':
      return ['Offered: if ', p(name), ' accepts, you’ll be shipmates'];
    case 'made':
      return ['You and ', p(name), ' are shipmates'];
    case 'not-yet':
      return ['You can offer once you’ve sailed together a while'];
    case 'full':
      return ['You have as many shipmates as you can keep'];
    case 'offers':
      return ['You have offers waiting; try again later'];
    case 'already':
      return [p(name), ' is already your shipmate'];
    case 'gone':
      return ['That offer has lapsed'];
    case 'offline':
      return ['The harbour can’t be reached. Check the connection and try again.'];
    default:
      return ['That didn’t reach the harbour. Try again in a moment.'];
  }
}

/** Ending or a block that did not reach the server. */
export const NOT_DONE = 'That didn’t reach the harbour. Try again in a moment.';

/** After an ending, in the row's place until the list is read again. */
export function endedWords(name: string): Words {
  return ['No longer shipmates with ', p(name)];
}

/** After a block. */
export function blockedWords(name: string): Words {
  return [p(name), ' is blocked'];
}

/** A thread's title, for a screen reader: "Messages with Iron Mary". */
export function threadWords(name: string): Words {
  return ['Messages with ', p(name)];
}
export const MESSAGE_FIELD = 'Your message';
export const CLOSE_THREAD = 'Close the messages';

/** The field's hint: "Message Iron Mary" (an attribute's plain text, never markup). */
export function messageHint(name: string): string {
  return `Message ${name}`;
}

/** An empty thread: how messages go. */
export function emptyThreadWords(name: string): Words {
  return [
    'Messages reach ',
    p(name),
    ' only while they’re in the game. Nothing is kept: a reload forgets them.',
  ];
}

/** The owner has shipmates' messages off. */
export const MESSAGES_RESTING = 'Messages between shipmates are resting';

/** Why a message was not sent, in its thread. */
export function messageRefusedWords(why: Exclude<ChatRefusalTold, ''>, name: string): Words {
  switch (why) {
    case 'away':
      return [p(name), ' isn’t in the game; messages aren’t kept for later'];
    case 'resting':
      return [MESSAGES_RESTING];
    case 'contact':
      return ['Links and contact details can’t be sent'];
    case 'long':
      return ['That message is too long: 200 characters at most'];
    case 'fast':
      return ['Too fast: wait a moment'];
    case 'silent':
      return ['You can’t send messages just now'];
    case 'nobody':
      return [p(name), ' can’t be reached just now'];
  }
}

/** An own message that never came back. */
export const MESSAGE_LOST = 'That message didn’t go. Try again.';

/** A notice under the case: a message, while its thread is not open. */
export function wroteWords(name: string): Words {
  return [p(name), ' wrote'];
}
export const OPEN = 'Open';

/** A notice under the case: an offer to the player. */
export function wouldLikeWords(name: string): Words {
  return [p(name), ' would like to be shipmates'];
}
export const SEE = 'See';

/** The account's switch, on the panel's foot and the account page. */
export const APPEAR_OFFLINE = 'Appear offline';
export const APPEAR_OFFLINE_DETAIL = 'Your shipmates won’t see that you’re in the game.';

/** A report made from the panel, of someone not aboard. */
export const REPORT_SHIPMATE_DETAIL =
  'Your report goes to the game’s owner. Nobody is ever told who reported them.';
