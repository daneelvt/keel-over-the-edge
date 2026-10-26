// SPDX-License-Identifier: AGPL-3.0-only

// The server refuses with a code, and the browser's passkey prompt fails
// with an error's name; these are the words the player reads. The name
// rules are the server's: the page checks only the length, counting as the
// server counts.

/** A name's length, in characters, and its bounds. */
export const MIN_NAME = 3;
export const MAX_NAME = 20;

/** A sailor stopped by the game's operator, as the player reads it at sign-in. */
const STOPPED = 'This sailor has been stopped. It cannot sign in or sail.';

/** A machine sailor stopped on its own, its player not. */
const MACHINE_STOPPED = 'That machine sailor has been stopped.';

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
  // The passkey's ceremonies.
  again: 'That took too long. Try again.',
  refused: 'That passkey could not be checked. Try again, or use another.',
  'unknown-passkey':
    'That passkey is not one of a sailor here: its sailor was deleted, or the passkey removed.',
  stopped: STOPPED,
  code: 'That is not a recovery code we know. Check it and try again: each code works once.',
  'add-passkey': 'Add a passkey first.',
  confirm: 'Confirm with your passkey first.',
  'last-passkey': 'Your last passkey stays: add another before you remove it.',
  'not-found': 'That passkey is gone already.',
  name: 'Type your sailor’s name exactly to delete it.',
  account: 'This began as another sailor. Reload and try again.',
  'passkey-here': 'This device already holds a passkey for your sailor.',
  'passkey-domain': 'This address cannot hold a passkey. Open the game at its usual address.',
  'no-passkeys': 'This browser cannot make passkeys. Try your phone’s own browser.',
  'passkey-failed': 'The passkey could not be made. Try again.',
  // Machine sailors.
  cap: 'You have as many machine sailors as you may.',
  'too-many-apps':
    'That machine sailor has as many AI apps approved as it may. Revoke one on the account page first.',
};

/**
 * The machine sailors' words, where a code means something of its own
 * there: the look is a machine's, and what is not found is a machine
 * sailor or its app.
 */
export const MACHINE_REASONS: Readonly<Record<string, string>> = {
  look: 'That look is not one of ours. Draw another.',
  'not-found': 'That machine sailor, or its app, is gone already.',
  name: 'Type the machine sailor’s name exactly to delete it.',
  stopped: MACHINE_STOPPED,
};

/**
 * The approval page's passkey step refused as stopped: there it is the
 * player's own sailor that is stopped, not the machine sailor chosen.
 */
export const SAILOR_STOPPED = 'sailor-stopped';

/**
 * The approval page's words, where a code means something of its own
 * there: the request is the AI app's, the passkey confirms it for a few
 * minutes, and stopped is the machine sailor chosen unless the passkey's
 * step says the player's own sailor is.
 */
export const APPROVE_REASONS: Readonly<Record<string, string>> = {
  [SAILOR_STOPPED]: STOPPED,
  again: 'This request has ended. Go back to your AI app and connect again.',
  confirm: 'Your passkey’s confirmation has lapsed. Continue with your passkey again.',
  'add-passkey': 'Your recovery code was used: open the game and add a passkey first.',
  'not-found': 'That machine sailor is gone. Choose another.',
  window: 'Passkeys don’t work in this window.',
};

/** The words for a reason code on the approval page. */
export function approveReasonText(code: string): string {
  return APPROVE_REASONS[code] ?? machineReasonText(code);
}

/** The words for a reason code about a machine sailor. */
export function machineReasonText(code: string): string {
  return MACHINE_REASONS[code] ?? reasonText(code);
}

/** Added to taken on the start screen: the player may be the sailor's. */
export const TAKEN_SIGN_IN = 'If that’s you, sign in with your passkey.';

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
