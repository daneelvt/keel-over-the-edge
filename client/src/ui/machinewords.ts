// SPDX-License-Identifier: AGPL-3.0-only

// Every word about a player's machine sailors sailing together, in one
// place: coming aboard one's own, its link, sending one aboard another's
// boat, and the knock of another player's machine sailor.

/** The watch plate's key to come aboard one's own machine sailor's boat, and its label. */
export const COME_ABOARD = 'Come aboard';

/** The plate key's label: whose boat it brings the player aboard. */
export function comeAboardText(machine: string): string {
  return `Come aboard ${machine}’s boat`;
}
