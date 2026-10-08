// SPDX-License-Identifier: AGPL-3.0-only

// The server refuses a name with a code; these are the words the player
// reads. The name rules are the server's: the page checks only the length,
// counting as the server counts.

/** A name's length, in characters, and its bounds. */
export const MIN_NAME = 3;
export const MAX_NAME = 20;

export const REASONS: Readonly<Record<string, string>> = {
  short: `That name is too short: use at least ${MIN_NAME} letters.`,
  long: `That name is too long: use at most ${MAX_NAME} letters.`,
  characters:
    'Use letters and numbers, starting with a letter, with single spaces, hyphens, full stops or apostrophes between them.',
  scripts: 'Use the letters of one alphabet. Latin may go with Japanese, Chinese or Korean.',
  words: 'That name is not allowed. Try another.',
  taken: 'That name, or one that looks just like it, is taken.',
  session: 'This browser already has a sailor. Reload the page to sail.',
  look: 'That sailor is not one of ours. Draw another.',
  malformed: 'The page sent something the harbour could not read. Reload and try again.',
  'content-type': 'The page sent something the harbour could not read. Reload and try again.',
  'too-large': 'That name is far too long.',
  'cross-origin': 'The page sent something the harbour could not read. Reload and try again.',
  unavailable: 'The harbour cannot answer just now. Try again in a moment.',
  offline: 'The harbour cannot be reached. Check the connection and try again.',
};

/** The words for a reason code, or a general message for one unknown. */
export function reasonText(code: string): string {
  return REASONS[code] ?? 'Something went wrong. Try again.';
}

/**
 * A name as the server shows it: normalised (NFKC), its spaces trimmed and
 * collapsed.
 */
export function displayForm(name: string): string {
  return name.normalize('NFKC').split(/\s+/u).filter(Boolean).join(' ');
}

/** A name's length as the server counts it: a letter with its accents counts once. */
export function nameLength(name: string): number {
  let n = 0;
  for (const c of displayForm(name)) {
    if (!/\p{M}/u.test(c)) {
      n++;
    }
  }
  return n;
}

/** short or long when the name's length is wrong, or null. */
export function lengthProblem(name: string): 'short' | 'long' | null {
  const n = nameLength(name);
  return n < MIN_NAME ? 'short' : n > MAX_NAME ? 'long' : null;
}
