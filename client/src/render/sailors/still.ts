// SPDX-License-Identifier: AGPL-3.0-only

// Whether the sailors keep still: the player's reduced-motion setting,
// read afresh every frame, so a change made while playing is followed at
// once. Read where there is no window (a test, a worker): never.

let query: MediaQueryList | null | undefined;

/** Whether less motion is asked for now. */
export function stillNow(): boolean {
  if (query === undefined) {
    query =
      typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  }
  return query?.matches === true;
}
