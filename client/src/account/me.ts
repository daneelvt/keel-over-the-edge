// SPDX-License-Identifier: AGPL-3.0-only

// The session check: the page's first question to the server, asked while
// the scene loads. A player with a session goes straight to sea, or, with
// machine sailors, to the start screen that shows them; one without gets
// the start screen; one whose session came from the recovery code is
// asked for a new passkey first; and when the server cannot answer, the
// page says so and asks again.

/** The player's own account, as GET /api/me gives it. */
export interface Me {
  name: string;
  /** The catalog sailor the player looks like, by id. */
  look: string;
  kind: string;
  /** A session made by the recovery code, which may only add a passkey until it has. */
  addPasskey?: boolean;
  /** The kinds of notice the sailor has switched off, by the catalog's ids; none for a new sailor. */
  noticesOff?: string[];
  /** How many machine sailors the account has; none when absent. */
  machines?: number;
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
  /** Shows the start screen; resolves with the sailor made or signed in there. */
  start: () => Promise<Me>;
  /** Asks for a new passkey, the session the recovery code's; resolves once it is added. */
  addPasskey: (me: Me) => Promise<Me>;
  /** Shows that the server cannot be reached, or hides it with false. */
  backSoon: (shown: boolean) => void;
  /** Shows the player's machine sailors before the sea, to one who has any; resolves on Set sail. */
  machines?: (me: Me) => Promise<Me>;
  wait?: (ms: number) => Promise<void>;
}

/**
 * The sailor this browser sails as: the session's, its machine sailors
 * shown first when it has any, or one made or signed in on the start
 * screen. While the server cannot answer it shows "Back soon"
 * and asks again, waiting longer each time.
 */
export async function resolveSailor(paths: SailorPaths): Promise<Me> {
  const wait = paths.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const check = await checkSession(paths.fetch);
    if (check.kind !== 'failed') {
      paths.backSoon(false);
      if (check.kind === 'none') {
        return paths.start();
      }
      if (check.me.addPasskey === true) {
        return paths.addPasskey(check.me);
      }
      return (check.me.machines ?? 0) > 0 && paths.machines !== undefined
        ? paths.machines(check.me)
        : check.me;
    }
    paths.backSoon(true);
    await wait(retryDelay(attempt));
  }
}
