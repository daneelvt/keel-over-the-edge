// SPDX-License-Identifier: AGPL-3.0-only

// The menu's place at sea, beside the boat, holds one window at a time:
// the menu, a page it opened, a race's window, the list of sailors to
// watch, the windows of sailing together, the way home's questions.
// Whichever opens last stays; every other one open closes, with no
// question asked: the menu's button over Make a race closes Make a race,
// and a race's card opened from a notice closes the menu.

/** A window in the menu's place: whether it is open now, and how it closes. */
export interface SideWindow {
  name: string;
  open: boolean;
  close: () => void;
}

/**
 * The windows to close so that only one stands in the menu's place: every
 * one open but the one just opened (the last listed, if two opened at
 * once). Nothing closes while none has just opened. Before is the names
 * open the last time it was asked.
 */
export function crowded(windows: readonly SideWindow[], before: ReadonlySet<string>): SideWindow[] {
  const opened = windows.filter((w) => w.open && !before.has(w.name));
  const keep = opened.at(-1);
  if (keep === undefined) {
    return [];
  }
  return windows.filter((w) => w.open && w !== keep);
}

/** The names of the windows open now. */
export function openNames(windows: readonly SideWindow[]): Set<string> {
  return new Set(windows.filter((w) => w.open).map((w) => w.name));
}

/**
 * The boat's half breadth on a screen held sideways, as a share of the
 * screen's height: the chase camera frames every boat alike, her sail
 * eased right out reaching a fifth of the height from the middle.
 */
const BOAT_HALF = 0.2;

/** The room kept between the boat and a window beside her, CSS px. */
const BOAT_ROOM = 12;

/**
 * How far down a screen held sideways the boat's sail head reaches, as a
 * share of its height: a part on the left above it, the instruments' case,
 * may stand over the head of her mast, as it does held upright.
 */
export const HEAD_BELOW = 0.3;

/**
 * How far the picture moves left, CSS px, so that the boat in the middle of
 * a screen width × height held sideways stands clear of a window in the
 * menu's place whose left edge is left: 0 where she already does. Beside
 * is the right edge of the parts on the left that reach down past her
 * sail's head (the chat's strip), 0 for none: she moves no nearer them.
 */
export function asideOf(width: number, height: number, left: number, beside = 0): number {
  const half = height * BOAT_HALF + BOAT_ROOM;
  const wanted = width / 2 + half - left;
  const room = beside > 0 ? width / 2 - half - beside : wanted;
  return Math.max(0, Math.round(Math.min(wanted, room)));
}
