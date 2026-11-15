// SPDX-License-Identifier: AGPL-3.0-only

// Sail to: a sailor's boat made the course, from the shipmates' panel (a
// shipmate at sea) and the machine sailors' panel (each of the player's
// own machine sailors at sea). The chart is the host, once the game is at
// sea: it keeps the course and asks the server where the boat is. Nothing
// offers it while the player watches another's boat, whose compass is not
// theirs, nor on the start screen, where there is no compass at all.

/** What sets a boat as the course. */
export interface SailToHost {
  /** Whether Sail to may be offered now: the player's own compass is shown. */
  able(): boolean;
  /** Whether the course set is the boat of this sailor, by account. */
  is(sailor: string): boolean;
  /** Makes the boat of a sailor the course: a shipmate's, or (machine) the player's own machine sailor's. */
  sail(sailor: string, name: string, machine: boolean): void;
  /** Clears the course. */
  clear(): void;
}

let host: SailToHost | null = null;

/** Sets what Sail to sets the course on; null for nothing. */
export function setSailToHost(h: SailToHost | null): void {
  host = h;
}

/** What Sail to sets the course on, while it may be offered; null otherwise. */
export function sailTo(): SailToHost | null {
  return host?.able() ? host : null;
}
