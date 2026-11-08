// SPDX-License-Identifier: AGPL-3.0-only

// Every word about sailing together, in one place: the skipper's link and
// its keys, the knocks on the skipper's boat, the knocker's own knock as
// it stands, the bar while aboard, who is aboard and what each may do, and
// the controls handed over. A name or a boat's name a player wrote is
// kept apart from the words around it ({ player }), so that the screen
// shows it as player text; plain() reads the words whole.

import type { KnockStateTold } from '../net/messages';

/** Words with a player's text among them: a name, or a boat's name. */
export type Words = readonly (string | { player: string })[];

/** The words as one string, a player's text as written. */
export function plain(words: Words): string {
  return words.map((w) => (typeof w === 'string' ? w : w.player)).join('');
}

/** A player's text among words. */
function p(text: string): { player: string } {
  return { player: text };
}

/** A skipper's boat: by its name in «», a player's, or else by its kind: "Iron Mary’s keelboat". */
function boatOf(skipper: string, boat: string, kind: string): Words {
  return boat === ''
    ? [p(skipper), `’s ${kind.toLowerCase()}`]
    : [p(skipper), '’s «', p(boat), '»'];
}

/** A link ended, or a knock by one. */
const ENDED = 'This link has ended.';

export const SAIL_WITH_ME = 'Sail with me';
export const SAIL_WITH_ME_DETAIL =
  'Share a link. Whoever opens it can ask to come aboard, and you choose who comes.';
export const SHARE = 'Share';
export const COPY = 'Copy';
export const COPIED = 'Copied';
export const NEW_LINK = 'New link';
export const LINKS_OFF = 'Links off';
export const CLOSE = 'Close';
export const READING_LINK = 'Reading your link…';
export const NO_LINK = 'You have no link out.';
export const LINK_NOT_HERE =
  'Your link is out, but this device does not have it. A new link ends the old one.';
export const LINK_ENDED = 'Your link has ended. No one can knock with it now.';
export const LINKS_RESTING = 'Links are resting for now.';
export const LINK_UNREADABLE = 'Your link cannot be read just now. Try again.';
export const CLOSED_TO_KNOCKS = 'Closed to knocks';
export const CLOSED_DETAIL = 'For this voyage: no one can ask to come aboard.';

/** How long a link has left: "Ends in 23 hours"; "This link has ended." once it has. */
export function endsText(expiresMs: number, nowMs: number): string {
  const left = expiresMs - nowMs;
  if (left <= 0) {
    return ENDED;
  }
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) {
    return `Ends in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const hours = Math.round(left / 3_600_000);
  if (hours < 48) {
    return `Ends in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `Ends in ${Math.round(left / 86_400_000)} days`;
}

/** A knock on the skipper's boat. */
export function asksWords(sailor: string): Words {
  return [p(sailor), ' asks to come aboard'];
}
export const LET_ABOARD = 'Let aboard';
export const NOT_NOW = 'Not now';

/** How many more knocks wait behind the one shown: "2 more waiting"; "" for none. */
export function moreWaitingText(n: number): string {
  return n > 0 ? `${n} more waiting` : '';
}

/** The knocker's own knock as it stands, or why it was refused; the boat by its name or kind. */
export function knockingWords(
  state: KnockStateTold,
  skipper: string,
  boat: string,
  kind: string,
): Words {
  switch (state) {
    case 'waiting':
      return ['Asking to come aboard ', ...boatOf(skipper, boat, kind), '…'];
    case 'let':
      return ['Coming aboard ', ...boatOf(skipper, boat, kind), '…'];
    case 'not-now':
      return [p(skipper), ' can’t take you aboard now.'];
    case 'lapsed':
      return ['The skipper didn’t answer.'];
    case 'ended':
      return [ENDED];
    case 'not-at-sea':
      return [p(skipper), '’s boat isn’t in the water now.'];
    case 'full':
      return [p(skipper), '’s boat has no room aboard.'];
    case 'closed':
      return [p(skipper), ' isn’t taking crew now.'];
    case 'busy':
      return ['The skipper has knocks waiting; try again soon.'];
    case 'often':
      return ['You’ve knocked a lot; try again later.'];
    case 'crowded':
      return ['Many are sailing together just now; try again soon.'];
    case 'own':
      return ['That is your own boat.'];
    case 'first':
      return ['Answer the questions before your first knock, then try again.'];
    case 'try-again':
      return ['That knock didn’t reach the skipper; try again.'];
    case 'withdrawn':
      return ['Your knock was withdrawn.'];
    case 'away':
      return ['Your machine sailor isn’t in the water now.'];
    default:
      return ['You can’t come aboard now.'];
  }
}

export const DISMISS = 'Dismiss';

export const ABOARD = 'Aboard';
/** The bar while aboard: "Aboard Iron Mary’s Jolly boat". */
export function aboardWords(skipper: string, boat: string, kind: string): Words {
  return [`${ABOARD} `, ...boatOf(skipper, boat, kind)];
}

/** The boat aboard under the bar's "Aboard": "Iron Mary’s Jolly boat". */
export function whoseBoatWords(skipper: string, boat: string, kind: string): Words {
  return boatOf(skipper, boat, kind);
}

export const GO_ASHORE = 'Go ashore';
export const GO_ASHORE_QUESTION = 'Go ashore?';
export const GO_ASHORE_DETAIL = 'Your boat goes in the water at the nearest port.';
export const STAY_ABOARD = 'Stay aboard';

export const CREW = 'Crew';
export const WHO_IS_ABOARD = 'Who’s aboard';
export const YOU = 'you';
export const SKIPPER = 'skipper';
export const HOLDS = 'Holds the controls';
export const YOU_HOLD = 'You have the controls';
export const AT_THE_HELM = 'At the helm';

/** How many are aboard: "3 aboard". */
export function aboardCountText(n: number): string {
  return `${n} aboard`;
}

export const HAND_OVER = 'Hand over the controls';
export const TAKE_BACK = 'Take back the controls';
export const GIVE_BACK = 'Give them back';
export const PUT_ASHORE = 'Put ashore';
export const KEEP_ABOARD = 'Keep aboard';

/** The one line before the skipper puts someone ashore. */
export function putAshoreWords(name: string): Words {
  return ['Put ', p(name), ' ashore?'];
}

/** A key's full name for a screen reader, the person it acts on named. */
export function actionName(action: string, name: string): string {
  return `${action}: ${name}`;
}

/** The controls offered: "Iron Mary hands you the controls". */
export function handedWords(from: string): Words {
  return [p(from), ' hands you the controls'];
}
export const TAKE_THEM = 'Take them';

/** The seconds left to take the controls offered: "12 s". */
export function secondsText(s: number): string {
  return `${Math.max(0, Math.ceil(s))} s`;
}
