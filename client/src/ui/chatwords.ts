// SPDX-License-Identifier: AGPL-3.0-only

// Every word about chat aboard, in one place: the strip and its field,
// why a line was not said, how chat stands, muting, blocking and
// reporting, the card shown before a player of 13 to 17 turns chat on,
// the account's switch and its list of mutes and blocks, and a statement
// of reasons from the game's owner. A name a player wrote is kept apart
// from the words around it ({ player }), as in deckwords.ts. Nothing here
// ever says who reported anyone, or anyone's age.

import type { ChatRefusalTold, ReportReasonTold, TiedTold } from '../net/messages';
import type { Words } from './deckwords';

/** A player's text among words. */
function p(text: string): { player: string } {
  return { player: text };
}

export const CHAT_ABOARD = 'Chat aboard';
export const OPEN_CHAT = 'Open the chat';
export const FOLD_CHAT = 'Fold the chat';
export const SAY_SOMETHING = 'Say something aboard';
export const LINE_FIELD = 'Your line';
export const SEND = 'Send';
export const NOTHING_SAID = 'Nothing said aboard yet';
export const MACHINE_SAILOR = 'machine sailor';
export const MORE_FOR = 'Mute, block or report';

/** Why a line was not said, in the strip, to its sender. */
export function refusedText(why: Exclude<ChatRefusalTold, ''>): string {
  switch (why) {
    case 'contact':
      return 'Links and contact details can’t be sent aboard';
    case 'long':
      return 'That line is too long: 200 characters at most';
    case 'fast':
      return 'Too fast: wait a moment';
    case 'silent':
      return 'You can’t chat just now';
    case 'nobody':
      return 'Nobody is aboard to hear you';
    case 'away':
      return 'They aren’t in the game; messages aren’t kept for later';
    case 'resting':
      return 'Messages between shipmates are resting';
  }
}

/** An own line that never came back. */
export const LINE_LOST = 'That line didn’t reach the boat. Try again.';

/** A mute or a block as the server has it now. */
export function tiedWords(t: Pick<TiedTold, 'name' | 'muted' | 'blocked' | 'full'>): Words {
  if (t.full) {
    return ['Your list of mutes and blocks is full (1,000). End some on the account page first.'];
  }
  if (t.blocked) {
    return [p(t.name), ' is blocked.'];
  }
  if (t.muted) {
    return [p(t.name), ' is muted: you won’t see their lines.'];
  }
  return [p(t.name), ' is no longer muted or blocked.'];
}

export const REPORTED = 'Thanks: the owner will look';
export const NOT_REPORTED = 'That report didn’t reach the owner. Try again.';

/** The owner's switch is off. */
export const CHAT_RESTING = 'Chat is resting';
/** The player's own switch is off. */
export const CHAT_OFF_FOR_YOU = 'Chat is off for you.';
export const TURN_CHAT_ON = 'Turn chat on';
export const KEEP_IT_OFF = 'Keep it off';

/** Within this of its end, a rest is "a few minutes", ms. */
const FEW_MINUTES = 15 * 60_000;

/**
 * The player's chat resting: until a time (ms of UTC), or until the owner
 * looks (0), said gently.
 */
export function restingText(until: number, now: number, zone?: string): string {
  if (until <= 0) {
    return 'Your chat is resting for now';
  }
  if (until - now <= FEW_MINUTES) {
    return 'Your chat is resting for a few minutes';
  }
  return `Your chat is resting until ${whenText(until, now, zone)}`;
}

/** A time to come, as a player reads it: "14:05" today, "12 November, 14:05" on another day. */
export function whenText(at: number, now: number, zone?: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: zone,
  });
  const day = (t: number) =>
    new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: zone });
  return day(at) === day(now) ? time : `${day(at)}, ${time}`;
}

/** An owner watching their own machine sailor aboard a boat: they read, and say nothing. */
export function ownerReadsWords(machine: string): Words {
  return ['Watching ', p(machine), ': you read its chat aboard'];
}

/** Someone's line, whole, for a screen reader: "Iron Mary: fair winds". */
export function lineWords(name: string, text: string): Words {
  return [p(name), ': ', p(text)];
}

export const MUTE = 'Mute';
export const UNMUTE = 'Unmute';
export const BLOCK = 'Block';
export const UNBLOCK = 'Unblock';
export const REPORT = 'Report';
export const CANCEL = 'Cancel';
export const CLOSE = 'Close';
export const MUTED = 'muted';
export const BLOCKED = 'blocked';

export const MUTE_DETAIL =
  'Mute: you won’t see their lines. Block: neither of you sees the other’s, and they can’t knock on your boat. They are never told.';

/** The one question before a block. */
export function blockWords(name: string): Words {
  return ['Block ', p(name), '?'];
}
export const BLOCK_DETAIL = 'You won’t see each other’s lines, and they can’t knock on your boat.';
/** A skipper's block, of someone aboard their own boat. */
export const BLOCK_ASHORE = 'They go ashore too.';

/** The report form's title. */
export function reportWords(name: string): Words {
  return ['Report ', p(name)];
}
export const REPORT_WHY = 'What is wrong?';

/** The reasons a player may give, in the order offered: a child at risk first. */
export const REPORT_REASONS: readonly { reason: ReportReasonTold; text: string }[] = [
  { reason: 'child', text: 'A child may be at risk' },
  { reason: 'sexual', text: 'Sexual content' },
  { reason: 'bullying', text: 'Bullying or harassment' },
  { reason: 'hate', text: 'Hate' },
  { reason: 'threats', text: 'Threats or self-harm' },
  { reason: 'scam', text: 'Scams or spam' },
  { reason: 'cheating', text: 'Cheating' },
  { reason: 'other', text: 'Something else' },
];

export const REPORT_NOTE = 'Anything to add? Only the game’s owner reads it.';
/** The longest note, in characters. */
export const MAX_NOTE = 200;
export const REPORT_DETAIL =
  'What was said aboard lately goes with your report, for the owner to read. Nobody is ever told who reported them.';
export const SEND_REPORT = 'Send the report';
export const CHOOSE_REASON = 'Choose what is wrong.';

/** The card a player of 13 to 17 reads before turning chat on. */
export const CARD_TITLE = 'Chat aboard';
export const CARD_LINES: readonly string[] = [
  'Only people aboard the same boat as you can read your lines, and every one of them was let aboard by its skipper.',
  'Press and hold a name or a line to mute someone, block them, or report them. Muting and blocking are never told.',
  'Nobody here needs your contact details, and nobody should ask for them. If anyone does, report them.',
];

/** The account page's part of chat. */
export const CHAT_HEADING = 'Chat';

/** The account's switch, and what it means. */
export const CHAT_SWITCH = 'Chat with other players';
export const CHAT_SWITCH_DETAIL = 'Lines said aboard the same boat. Never kept.';
export const CHAT_SWITCH_OFF = 'Chat is resting for everyone just now.';

/** The account's list of mutes and blocks. */
export const TIES_TITLE = 'Muted and blocked';
export const NO_TIES = 'You haven’t muted or blocked anyone.';
export const READING_TIES = 'Reading your list…';

/** A row of the list: "muted", "blocked". */
export function tieKindText(kind: 'mute' | 'block'): string {
  return kind === 'mute' ? MUTED : BLOCKED;
}

/** The key that ends a mute or a block. */
export function endTieText(kind: 'mute' | 'block'): string {
  return kind === 'mute' ? UNMUTE : UNBLOCK;
}

export const PRIVACY_TITLE = 'Chat and your privacy';
export const PRIVACY_PAGE = '/privacy.html';

/** A statement of reasons waiting to be read. */
export const STATEMENT_WAITING = 'A word from the game’s owner about chat';
export const READ_IT = 'Read';
export const STATEMENT_TITLE = 'From the game’s owner';

/** What the owner did, in a statement of reasons. */
export function actionText(action: string, until: number, now: number, zone?: string): string {
  switch (action) {
    case 'warn':
      return 'This is a warning about something you said aboard.';
    case 'mute-chat':
      return until > now
        ? `Your chat rests until ${whenText(until, now, zone)}.`
        : 'Your chat was rested for a while.';
    case 'remove-line':
      return 'A line of yours was removed.';
    case 'stop':
      return 'Your account has been stopped.';
    default:
      return 'The owner looked at something you said aboard.';
  }
}

export const THE_RULE = 'The rule';
export const WHAT_WAS_SEEN = 'What was seen';
export const ASK_AGAIN =
  'If you think this is wrong, tell the owner once, in up to 500 characters. The owner reads every answer.';
/** The longest answer, in characters. */
export const MAX_ANSWER = 500;
export const YOUR_ANSWER = 'Your answer';
export const SEND_ANSWER = 'Send your answer';
export const ANSWER_SENT = 'Your answer is with the owner.';
export const LATER = 'Later';

/** How many characters are left of max, shown near the end: "12 left"; "" before. */
export function leftText(used: number, max: number): string {
  const left = max - used;
  return left <= Math.min(40, max / 5) ? `${Math.max(0, left)} left` : '';
}
