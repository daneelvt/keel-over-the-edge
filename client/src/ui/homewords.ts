// SPDX-License-Identifier: AGPL-3.0-only

// Every word of the way home, in one place: the menu's item, its question
// and keys, and the answer to a lift asked for again too soon; and of
// Change boat beside it, which takes the boat out of the water for
// another chosen ashore.

/** The menu's item, and the question's key that lifts the boat. */
export const BACK_TO_PORT_ROYAL = 'Back to Port Royal';
export const HOME_QUESTION = 'Back to Port Royal?';
export const HOME_DETAIL =
  'Your boat is lifted to the start off Port Royal. This voyage ends here.';
export const HOME_RACING = 'You retire from the race.';
export const HOME_SHIPMATES = 'Your shipmates come too.';
export const HOME_STAY = 'Stay';

/** The notice when a lift is asked for again within the minute. */
export const LIFTED_SOON = 'You were lifted a moment ago.';

/** The question's lines under its head: what happens, and, racing or with shipmates aboard, what else. */
export function homeLines(racing: boolean, shipmates: boolean): string[] {
  const lines = [HOME_DETAIL];
  if (racing) {
    lines.push(HOME_RACING);
  }
  if (shipmates) {
    lines.push(HOME_SHIPMATES);
  }
  return lines;
}

/** The menu's item beside the way home, and its question's key. */
export const CHANGE_BOAT = 'Change boat';
export const CHANGE_QUESTION = 'Change boat?';
export const CHANGE_DETAIL =
  'Your boat comes out of the water and this voyage ends. You choose a boat ashore, and start afresh off Port Royal.';
export const CHANGE_SHIPMATES = 'Your shipmates go ashore at the nearest port.';
/** The question's line when the boat could not be taken out. */
export const CHANGE_FAILED = 'Your boat could not be taken out just now. Try again.';

/** The question's lines under its head: what happens, and, racing or with shipmates aboard, what else. */
export function changeLines(racing: boolean, shipmates: boolean): string[] {
  const lines = [CHANGE_DETAIL];
  if (racing) {
    lines.push(HOME_RACING);
  }
  if (shipmates) {
    lines.push(CHANGE_SHIPMATES);
  }
  return lines;
}
