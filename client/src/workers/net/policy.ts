// SPDX-License-Identifier: AGPL-3.0-only

// What the net worker does when a connection ends, by its close code
// (RFC 6455, 7.4; IANA's registry; the game's own 4000s). Waits are drawn
// uniformly under a ceiling that doubles with each failed attempt ("full
// jitter", AWS Architecture Blog, 2015), so a server's restart does not
// bring every client back at once.

/** The longest wait, ms. */
export const WAIT_CAP = 10_000;

export type Plan =
  /** Nothing more: the page closed it. */
  | { kind: 'stop' }
  /** Try again after ms. */
  | { kind: 'wait'; ms: number }
  /** It failed before its Welcome, which a browser cannot explain: ask whether the session lives. */
  | { kind: 'check' }
  | { kind: 'replaced' }
  | { kind: 'version' }
  | { kind: 'removed' };

/** The jitter of a reconnection after the world has ended, ms: every page at once, spread. */
export const ENDED_WAIT = [200, 2000] as const;

/** A wait under a ceiling of base × 2^attempt, at most WAIT_CAP. */
export function backoff(attempt: number, base: number, random: () => number): number {
  return random() * Math.min(WAIT_CAP, base * 2 ** attempt);
}

/**
 * The plan after a close with code (1006 when there was no close frame),
 * on the attempt-th failure in a row, before or after a Welcome.
 */
export function afterClose(
  code: number,
  attempt: number,
  welcomed: boolean,
  random: () => number,
): Plan {
  switch (code) {
    case 1000:
      return { kind: 'stop' };
    case 4001:
      return { kind: 'replaced' };
    case 4002:
      return { kind: 'version' };
    case 4003:
      return { kind: 'removed' };
    case 1012:
      // A restart: back in 0.5 to 5 s, spread out.
      return { kind: 'wait', ms: 500 + random() * 4500 };
    case 4004:
      // The falls have taken the world: the next is open, back in 0.2 to
      // 2 s, spread out.
      return { kind: 'wait', ms: ENDED_WAIT[0] + random() * (ENDED_WAIT[1] - ENDED_WAIT[0]) };
    case 1013:
      return { kind: 'wait', ms: backoff(attempt, 2000, random) };
    case 1003:
    case 1008:
    case 1009:
      return { kind: 'wait', ms: backoff(attempt, 1000, random) };
  }
  if (!welcomed) {
    return { kind: 'check' };
  }
  return { kind: 'wait', ms: backoff(attempt, 500, random) };
}
