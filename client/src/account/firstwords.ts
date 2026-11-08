// SPDX-License-Identifier: AGPL-3.0-only

// What a sailor is asked before the sea is shared: when they were born
// (asked as a sailor is made, and once of a sailor made before it was), and
// the Rules of the sea, accepted once before the first knock or link. The
// question gives no hint of an answer: both its boxes start empty, and every
// answer takes the same steps. Nothing here ever shows an age.

import type { Me } from './me';

/** The question, as a sailor is made and once of an older sailor. */
export const AGE_QUESTION = 'When were you born?';

/** The line under the question asked once of an older sailor. */
export const AGE_ONCE = 'Every sailor is asked this once. Nobody else ever sees it.';

/** The boxes' empty choices, which say only what goes in them. */
export const MONTH = 'Month';
export const YEAR = 'Year';

/** The months, by name, January first. */
export const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** How far back the years go from this one. */
export const YEARS_BACK = 120;

/** The years a sailor may be born in: this year first, back YEARS_BACK years. */
export function bornYears(now: Date = new Date()): number[] {
  const y = now.getFullYear();
  const out: number[] = [];
  for (let i = 0; i <= YEARS_BACK; i++) {
    out.push(y - i);
  }
  return out;
}

/** The answer as the server takes it. */
export interface Born {
  year: number;
  /** 1 for January. */
  month: number;
}

/** The answer from the boxes' values, or null while either is empty or not a choice of theirs. */
export function bornOf(month: string, year: string, now: Date = new Date()): Born | null {
  const m = Number(month);
  const y = Number(year);
  if (month === '' || year === '' || !Number.isInteger(m) || !Number.isInteger(y)) {
    return null;
  }
  if (m < 1 || m > 12 || !bornYears(now).includes(y)) {
    return null;
  }
  return { year: y, month: m };
}

/** The answer to an under-age sailor being made, and all it says. */
export const CANT_BE_MADE = 'Sorry, a sailor can’t be made.';

/** The answer to an older sailor's under-age answer, and all it says. */
export const CANT_SAIL = 'Sorry, this sailor can’t sail.';

/** The cookie the server sets with that answer, which the page reads to give it again. */
export const YOUNG_COOKIE = 'keel-young';

/** Whether the browser's cookies hold the under-age answer. */
export function youngCookie(cookie: string): boolean {
  return cookie.split(';').some((c) => c.trim() === `${YOUNG_COOKIE}=1`);
}

export const GO_ON = 'Go on';
export const NOT_NOW = 'Not now';

/** The Rules of the sea, in short, on the card a sailor accepts them on. */
export const RULES_TITLE = 'The Rules of the sea';

export const RULES_LINES: readonly string[] = [
  'Be decent to everyone you meet.',
  'No contact details or links: nobody needs yours, and nobody should ask for them.',
  'No harassment, hate, sexual content, scams or cheating.',
  'You answer for what your machine sailor says, as for yourself.',
  'Every skipper approves who comes aboard, and can put anyone ashore.',
  'The game’s owner may remove what is said and stop any sailor’s account.',
];

export const RULES_IN_FULL = 'The Rules in full';
export const STAYING_SAFE = 'Staying safe';
export const KEEP_TO_THEM = 'I’ll keep to them';
export const CANCEL = 'Cancel';

/** The game's own pages of the Rules and of staying safe. */
export const RULES_PAGE = '/rules.html';
export const SAFETY_PAGE = '/safety.html';

/** What a sailor is still to be asked before a knock or a link. */
export type FirstAsk = 'age' | 'rules';

/**
 * What is still to be asked before a knock or a link, in order: when the
 * sailor was born, then the Rules. Each is asked unless the server's
 * answer to GET /api/me says it is done.
 */
export function firstAsks(me: Pick<Me, 'born' | 'rules'>): FirstAsk[] {
  const out: FirstAsk[] = [];
  if (me.born !== true) {
    out.push('age');
  }
  if (me.rules !== true) {
    out.push('rules');
  }
  return out;
}
