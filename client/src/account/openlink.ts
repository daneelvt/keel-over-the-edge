// SPDX-License-Identifier: AGPL-3.0-only

// A link to watch, opened once the player is signed in: the server says
// which sailor it opens, or, for a fleet's, its machine sailors at sea,
// liveliest first, of which the first is watched; or why none is. A code
// is read only behind a session, so a visitor learns nothing of the link
// before making a sailor.

import type { LinkRefusal, WatchLink } from '../ui/watchwords';
import type { Fetch } from './me';

/** What a link opens: a sailor to watch by name, or why none. */
export type Opened = { watch: string } | { refusal: LinkRefusal };

/** GET /api/watch/link's answer, read. */
export async function openLink(
  link: WatchLink,
  f: Fetch = (input, init) => fetch(input, init),
): Promise<Opened> {
  const q = new URLSearchParams({ [link.kind === 'fleet' ? 'f' : 'w']: link.code });
  let status: number;
  let body: { name?: unknown; machine?: unknown; error?: unknown; sailors?: unknown };
  try {
    const res = await f(`/api/watch/link?${q}`, { cache: 'no-store', credentials: 'same-origin' });
    status = res.status;
    body = await res.json();
  } catch {
    return { refusal: { why: 'unread' } };
  }
  if (status === 200 && link.kind === 'fleet') {
    const first = Array.isArray(body.sailors) ? (body.sailors[0] as { name?: unknown }) : undefined;
    return typeof first?.name === 'string'
      ? { watch: first.name }
      : { refusal: { why: 'no-fleet' } };
  }
  if (status === 200 && typeof body.name === 'string') {
    return { watch: body.name };
  }
  if (status === 404 && body.error === 'no-link') {
    return { refusal: { why: 'no-link' } };
  }
  const why = body.error;
  if (
    status === 404 &&
    typeof body.name === 'string' &&
    (why === 'cannot' || why === 'not-at-sea' || why === 'own')
  ) {
    return { refusal: { why, name: body.name, machine: body.machine === true } };
  }
  return { refusal: { why: 'unread' } };
}
