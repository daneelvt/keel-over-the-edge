// SPDX-License-Identifier: AGPL-3.0-only

// A date in the player's words. Apart from the screens that show it, so
// the approval page, which shows one too, loads none of the game's code
// with it.

/** A date as the player reads it: 23 October, or 23 October 2025 in another year. */
export function dayOf(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
