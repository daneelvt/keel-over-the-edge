// SPDX-License-Identifier: AGPL-3.0-only

// Every word of the way home, in one place: the menu's item, its question
// and keys, and the answer to a lift asked for again too soon.

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
