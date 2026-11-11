// SPDX-License-Identifier: AGPL-3.0-only

// The notice page's form, for anyone, signed in or not: who they are, how
// to reach them, the sailor's name if they know it, where and when, a
// reason and what happened, sent to the game's owner (POST /api/notice).
// The words of its answers are here.

/** A notice as the server takes it. */
export interface Notice {
  who: string;
  contact: string;
  sailor: string;
  happened: string;
  reason: string;
  what: string;
}

/** The reasons, as the server names them. */
export const NOTICE_REASONS = [
  'child',
  'sexual',
  'bullying',
  'hate',
  'threats',
  'scam',
  'cheating',
  'other',
] as const;

/** The longest each part may be, in characters, as the server counts them. */
export const NOTICE_LIMITS: Record<keyof Notice, number> = {
  who: 200,
  contact: 200,
  sailor: 80,
  happened: 200,
  reason: 16,
  what: 2000,
};

export const SENT = 'Thanks: the owner will read it.';
const MISSING = 'Say who you are, how to reach you, what is wrong and what happened.';
const TOO_LONG = 'Something is too long: shorten it and send again.';
const OFTEN = 'Several notices have come from here this hour. Try again later.';
const UNAVAILABLE = 'The harbour cannot answer just now. Try again in a moment.';
const OFFLINE = 'The harbour cannot be reached. Check the connection and try again.';

/** The notice from the form's values, trimmed. */
export function noticeOf(get: (name: keyof Notice) => string): Notice {
  const n = (k: keyof Notice) => get(k).trim();
  return {
    who: n('who'),
    contact: n('contact'),
    sailor: n('sailor'),
    happened: n('happened'),
    reason: n('reason'),
    what: n('what'),
  };
}

/** What is wrong with a notice before it is sent, in words; '' for nothing. */
export function noticeProblem(n: Notice): string {
  if (
    n.who === '' ||
    n.contact === '' ||
    n.what === '' ||
    !(NOTICE_REASONS as readonly string[]).includes(n.reason)
  ) {
    return MISSING;
  }
  for (const k of Object.keys(NOTICE_LIMITS) as (keyof Notice)[]) {
    if ([...n[k]].length > NOTICE_LIMITS[k]) {
      return TOO_LONG;
    }
  }
  return '';
}

/** Sends a notice: '' once it is received, or why not, in words. */
export async function sendNotice(
  n: Notice,
  f: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await f('/api/notice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(n),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return OFFLINE;
  }
  switch (res.status) {
    case 204:
      return '';
    case 400:
      return MISSING;
    case 429:
      return OFTEN;
    default:
      return UNAVAILABLE;
  }
}
