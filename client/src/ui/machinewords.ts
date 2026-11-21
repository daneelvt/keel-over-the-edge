// SPDX-License-Identifier: AGPL-3.0-only

// Every word about a player's machine sailors sailing together, in one
// place: coming aboard one's own, its link in Invite friends, sending one
// aboard another's boat, and the knock of another player's machine sailor.

import type { KnockStateTold } from '../net/messages';
import { knockingWords, type Words } from './deckwords';

/** The watch plate's key to come aboard one's own machine sailor's boat, and its label. */
export const COME_ABOARD = 'Come aboard';

/** The plate key's label: whose boat it brings the player aboard. */
export function comeAboardText(machine: string): string {
  return `Come aboard ${machine}’s boat`;
}

/** A player's text among words. */
function p(text: string): { player: string } {
  return { player: text };
}

/** The mark of a machine sailor, after its name. */
export const COG = ' ⚙';

/**
 * The card of another player's machine sailor knocking on the player's
 * own machine sailor's boat: «Rover» ⚙, «Bob Read»’s machine sailor, asks
 * to come aboard «Iron Mary»’s boat.
 */
export function machineAsksWords(sailor: string, owner: string, skipper: string): Words {
  return [
    p(sailor),
    `${COG}, `,
    p(owner),
    '’s machine sailor, asks to come aboard ',
    p(skipper),
    '’s boat',
  ];
}

/** The player's own machine sailor's knock as it stands, or why it was refused. */
export function machineKnockingWords(
  state: KnockStateTold,
  machine: string,
  skipper: string,
  boat: string,
  kind: string,
): Words {
  switch (state) {
    case 'waiting':
      return ['Sending ', p(machine), ' aboard ', p(skipper), '’s boat: its owner chooses…'];
    case 'let':
      return [p(machine), ' is coming aboard ', p(skipper), '’s boat.'];
    case 'not-now':
      return [p(skipper), '’s owner can’t take ', p(machine), ' aboard now.'];
    case 'lapsed':
      return [p(skipper), '’s owner didn’t answer.'];
    case 'away':
      return [p(machine), ' isn’t in the water: its AI app sails it there first.'];
    case 'closed':
      return [p(skipper), ' isn’t taking ', p(machine), ' aboard now.'];
    case 'own':
      return ['That is ', p(machine), '’s own boat.'];
  }
  return knockingWords(state, skipper, boat, kind);
}

/** The link's page: send one of the player's machine sailors aboard instead. */
export function sendAboardText(machine: string): string {
  return `Send ${machine} aboard`;
}

/** Why one of the player's machine sailors cannot be sent aboard now, by the server's word; "" for it can. */
export function cantSendText(can: string, machine: string, skipper: string): string {
  switch (can) {
    case 'ok':
      return '';
    case 'away':
      return `${machine} isn’t in the water: its AI app sails it there first.`;
    case 'aboard':
      return `${machine} is aboard ${skipper}’s boat.`;
    case 'own':
      return `That is ${machine}’s own boat.`;
    case 'full':
      return `${skipper}’s boat has no room aboard.`;
    case 'not-at-sea':
      return `${skipper}’s boat isn’t in the water now.`;
  }
  return `${skipper} isn’t taking ${machine} aboard now.`;
}

/** The link's page of a machine sailor's link: no person comes aboard a machine sailor's boat. */
export const MACHINE_TAKES_NO_ONE = 'A machine sailor’s boat takes no one aboard but its owner.';

/** Invite friends' part for one's machine sailor watched, its link to come aboard: "Sail with Iron Mary". */
export function sailWithFor(machine: string): string {
  return `Sail with ${machine}`;
}

/** What that link does. */
export const SAIL_WITH_MACHINE_DETAIL =
  'Whoever opens the link can send an AI sailor of theirs aboard, and you choose who comes.';

/** Invite friends' key, while one's machine sailor is crew aboard another's boat, to call it ashore. */
export const CALL_ASHORE = 'Call ashore';
export function callAshoreText(machine: string): string {
  return `Call ${machine} ashore`;
}
