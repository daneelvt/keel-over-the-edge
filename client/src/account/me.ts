// SPDX-License-Identifier: AGPL-3.0-only

// The session check: the page's first question to the server, asked while
// the scene loads. A player with a session goes straight to sea; one
// without gets the start screen; and when the server cannot answer, the
// page says so and asks again.

/** The player's own account, as GET /api/me gives it. */
export interface Me {
  name: string;
  /** The catalog sailor the player looks like, by id. */
  look: string;
  kind: string;
  /** False for a guest, kept only by this browser's cookie. */
  saved: boolean;
}

export type SessionCheck = { kind: 'sailor'; me: Me } | { kind: 'none' } | { kind: 'failed' };

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Asks the server whose session this browser holds. */
export async function checkSession(fetcher: Fetch = fetch): Promise<SessionCheck> {
  try {
    const res = await fetcher('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 401) {
      return { kind: 'none' };
    }
    if (res.status !== 200) {
      return { kind: 'failed' };
    }
    const me = (await res.json()) as Me;
    if (typeof me.name !== 'string' || typeof me.look !== 'string') {
      return { kind: 'failed' };
    }
    return { kind: 'sailor', me };
  } catch {
    return { kind: 'failed' };
  }
}

/** The waits between asking again, in milliseconds: doubling to 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export interface SailorPaths {
  fetch?: Fetch;
  /** Shows the start screen; resolves with the sailor made there. */
  start: () => Promise<Me>;
  /** Shows that the server cannot be reached, or hides it with false. */
  backSoon: (shown: boolean) => void;
  wait?: (ms: number) => Promise<void>;
}

/**
 * The sailor this browser sails as: the session's, or one made on the start
 * screen. While the server cannot answer it shows "Back soon" and asks
 * again, waiting longer each time.
 */
export async function resolveSailor(paths: SailorPaths): Promise<Me> {
  const wait = paths.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const check = await checkSession(paths.fetch);
    if (check.kind !== 'failed') {
      paths.backSoon(false);
      return check.kind === 'sailor' ? check.me : paths.start();
    }
    paths.backSoon(true);
    await wait(retryDelay(attempt));
  }
}
