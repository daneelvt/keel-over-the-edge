// SPDX-License-Identifier: AGPL-3.0-only

// The instruments' case and what slides out of it, as rules apart from the
// page: which complications are out, kept in the order they were opened,
// so that when the case would reach the pocket chart, or held upright the
// controls at the foot of the screen, the oldest folds back in; how a
// complication slides, out as it opens and back as it folds, never as it
// is merely drawn again; the disclosure each pusher is, its state and what
// it shows; and what the case's last line says, which the screen says
// nowhere else.

/** What slides out of the case. */
export type Complication = 'barometer' | 'clock';

/** The complications in the order they are laid out of the case. */
export const LAID: readonly Complication[] = ['barometer', 'clock'];

/** Where a complication is: out, sliding out, sliding back in, or in. */
export type Slide = 'opening' | 'out' | 'folding' | 'in';

/**
 * The slide a change of a complication's place begins: opening as it comes
 * out, folding as it goes back in; none where nothing changed, or where
 * the reader asks for less motion. A complication drawn again, laid out
 * again or shown again after a measurement slides nowhere.
 */
export function slideOf(
  before: boolean,
  out: boolean,
  reduced: boolean,
): 'opening' | 'folding' | null {
  if (before === out || reduced) {
    return null;
  }
  return out ? 'opening' : 'folding';
}

/** A box on the screen, CSS pixels. */
export interface Box {
  right: number;
  bottom: number;
}

/** Whether a box stays within the room it is given: short of its right edge and of its foot. */
export function within(box: Box, room: Box): boolean {
  return box.right <= room.right && box.bottom <= room.bottom;
}

/** The open complications, oldest opened first, after one is opened or put away. */
export function pressed<C extends string>(order: readonly C[], c: C, out: boolean): C[] {
  const rest = order.filter((o) => o !== c);
  return out ? [...rest, c] : rest;
}

/**
 * The open complications that fit: while fits says the case with them out
 * would reach past its room, the oldest opened folds back in.
 */
export function fitted<C extends string>(
  order: readonly C[],
  fits: (open: readonly C[]) => boolean,
): C[] {
  let open = [...order];
  while (open.length > 0 && !fits(open)) {
    open = open.slice(1);
  }
  return open;
}

/** A pusher's state as a disclosure button: whether what it shows is out, and which it is. */
export function disclosure(
  controls: string,
  out: boolean,
): { 'aria-expanded': boolean; 'aria-controls': string } {
  return { 'aria-expanded': out, 'aria-controls': controls };
}

/**
 * The case's last line: the autopilot where no control on the screen says
 * what it holds (a boat watched has none), else the boat's tack while the
 * right-of-way overlay is on, else nothing. Its place is kept on a boat
 * watched and while the overlay is on, so the case keeps its size.
 */
export function caseLine(pilot: string, tack: string, controls: boolean): string {
  if (pilot !== '' && !controls) {
    return `Autopilot ${pilot}`;
  }
  return tack;
}
