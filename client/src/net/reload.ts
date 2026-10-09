// SPDX-License-Identifier: AGPL-3.0-only

// A client whose protocol, catalog or physics differ from the server's is
// closed with 4002, and reloads to get the server's. During a deploy, or a
// rebuild in development, the two can differ for a while: a mark in
// sessionStorage lets the page reload once a minute at most, so it cannot
// reload in a loop.

const KEY = 'keel-reloaded-for-version';
/** How long after one reload another is held back, ms. */
export const RELOAD_EVERY = 60_000;

/** The part of sessionStorage used; null where storage is refused. */
export type Marks = Pick<Storage, 'getItem' | 'setItem'> | null;

/** Whether to reload now, at now (ms since the Unix epoch), marking it if so. */
export function reloadForVersion(marks: Marks, now: number): boolean {
  let last = 0;
  try {
    last = Number(marks?.getItem(KEY) ?? 0);
  } catch {
    // Storage refused: reload regardless; the server closes again.
  }
  if (now - last < RELOAD_EVERY) {
    return false;
  }
  try {
    marks?.setItem(KEY, String(now));
  } catch {
    // As above.
  }
  return true;
}
