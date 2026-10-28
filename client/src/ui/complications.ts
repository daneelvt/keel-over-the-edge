// SPDX-License-Identifier: AGPL-3.0-only

// The instruments' case and what slides out of it, as rules apart from the
// page: which complications are out, kept in the order they were opened,
// so that when the case would reach the pocket chart the oldest folds back
// in; the world clock out by itself in the world's last days until the
// sailor puts it away; and the disclosure each pusher is, its state and
// what it shows.

/** What slides out of the case. */
export type Complication = 'barometer' | 'clock';

/** The complications in the order they are laid out of the case. */
export const LAID: readonly Complication[] = ['barometer', 'clock'];

/** The open complications, oldest opened first, after one is opened or put away. */
export function pressed(
  order: readonly Complication[],
  c: Complication,
  out: boolean,
): Complication[] {
  const rest = order.filter((o) => o !== c);
  return out ? [...rest, c] : rest;
}

/**
 * The open complications that fit: while fits says the case with them out
 * would reach past its room, the oldest opened folds back in.
 */
export function fitted(
  order: readonly Complication[],
  fits: (open: readonly Complication[]) => boolean,
): Complication[] {
  let open = [...order];
  while (open.length > 0 && !fits(open)) {
    open = open.slice(1);
  }
  return open;
}

/**
 * Whether the world clock is out: by the sailor's choice, or by itself in
 * the world's last days unless they have put it away since.
 */
export function clockOut(chosen: boolean, closing: boolean, putAway: boolean): boolean {
  return chosen || (closing && !putAway);
}

/** A pusher's state as a disclosure button: whether what it shows is out, and which it is. */
export function disclosure(
  controls: string,
  out: boolean,
): { 'aria-expanded': boolean; 'aria-controls': string } {
  return { 'aria-expanded': out, 'aria-controls': controls };
}
