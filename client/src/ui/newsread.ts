// SPDX-License-Identifier: AGPL-3.0-only

// The news as the phone reads it, a day's edition from the server; and
// what of it has been read: the phone keeps the stories it has shown,
// so a story not yet read carries a small "new", and the chart screen's
// News tab a dot while today's edition has one. Kept in the browser's own
// storage, which may be refused (a private window, blocked site data): then
// for this page only.

import { signal } from '@preact/signals';
import { type Edition, storiesOf } from './newswords';

/** The news, a day's edition: today's for null, or a day's (2006-01-02); null when it cannot be had. */
export type NewsSource = (day: string | null) => Promise<Edition | null>;

/** The news as the server serves it, to a signed-in sailor: GET /api/news. */
export const serverNews: NewsSource = async (day) => {
  try {
    const res = await fetch(`/api/news${day === null ? '' : `?day=${encodeURIComponent(day)}`}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as Edition;
  } catch {
    return null;
  }
};

/** Where the stories read are kept. */
const KEY = 'keel.news.read';

/** How many stories read are kept, the latest: a world's editions, many times over. */
export const KEEP = 400;

/** The stories read this page, when the browser keeps none. */
let held: string[] = [];

/** The stories read, the earliest first. */
function readList(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY) ?? null;
    if (raw === null) {
      return globalThis.localStorage === undefined ? held : [];
    }
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : held;
  } catch {
    return held;
  }
}

/** The stories read. */
export function readStories(): Set<string> {
  return new Set(readList());
}

/** Notes stories as read, keeping the latest KEEP. */
export function markRead(ids: readonly string[]): void {
  const list = readList();
  const had = new Set(list);
  const added = ids.filter((id) => !had.has(id));
  if (added.length === 0) {
    return;
  }
  const next = [...list, ...added].slice(-KEEP);
  held = next;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept for this page only.
  }
}

/** The stories of an edition not yet read. */
export function unreadOf(e: Edition, read: ReadonlySet<string> = readStories()): string[] {
  return storiesOf(e)
    .map((s) => s.id)
    .filter((id) => !read.has(id));
}

/** Whether today's edition has a story not yet read: the News tab's dot. */
export const unread = signal(false);

/** Reads today's edition and sets the dot by it; a failure leaves it as it was. */
export async function checkUnread(today: () => Promise<Edition | null>): Promise<void> {
  const e = await today();
  if (e !== null) {
    unread.value = unreadOf(e).length > 0;
  }
}
