// SPDX-License-Identifier: AGPL-3.0-only

// Making a guest: a name and a look sent to POST /guest. The server sets the
// session cookie itself (HttpOnly: no script ever holds it), so the answer
// carries only the sailor made, or a reason code for the refusal.

import type { Fetch, Me } from './me';

export type GuestResult = { ok: true; me: Me } | { ok: false; reason: string };

export async function createGuest(
  name: string,
  look: string,
  fetcher: Fetch = fetch,
): Promise<GuestResult> {
  let res: Response;
  try {
    res = await fetcher('/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, look }),
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, reason: 'offline' };
  }
  if (res.status === 201) {
    const made = (await res.json()) as { name: string; look: string };
    return { ok: true, me: { name: made.name, look: made.look, kind: 'human', saved: false } };
  }
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') {
      return { ok: false, reason: body.error };
    }
  } catch {
    // Not the server's JSON: a proxy's page, say.
  }
  return { ok: false, reason: 'unavailable' };
}
