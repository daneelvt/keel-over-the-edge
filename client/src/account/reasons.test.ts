// SPDX-License-Identifier: AGPL-3.0-only

// No refusal the player can put right is shown by its words alone. Every
// page that shows a reason's words from a code it was given is listed here
// with the codes its routes can answer; each of those the player can put
// right themselves has its cure on that page, named in reasons.ts's CURES,
// and the page's code holds it. A page that shows a reason's words and is
// not listed fails, until what it can meet is read and written here.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CURES, MACHINE_REASONS, REASONS, reasonText } from './reasons';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** The calls that turn a reason's code into words. */
const CALL =
  /(?<!function )\b(?:reasonText|machineReasonText|approveReasonText|madeProblem)\(\s*([^)]*)\)/g;

/**
 * Each page that shows a reason's words from a code it was given, and the
 * codes the routes it calls can answer with (the server's own lists, in
 * internal/api), save those the page answers some other way before the
 * words: a first ask's card, the age question's step.
 */
const SHOWN: Readonly<Record<string, readonly string[]>> = {
  // The account page: passkeys added and removed, the recovery code made
  // anew, the sailor deleted.
  'account/account.tsx': [
    'unavailable',
    'offline',
    'confirm',
    'last-passkey',
    'not-found',
    'name',
    'passkey-failed',
    'no-passkeys',
    'refused',
    'again',
  ],
  // Following a sailor by a link to watch: too many is said its own way.
  'account/yourlink.tsx': ['not-found', 'unavailable', 'offline'],
  // Chat's card and the account's chat switch: a first ask is a step of the card.
  'account/chatcard.tsx': ['unavailable', 'offline'],
  'account/chataccount.tsx': ['unavailable', 'offline'],
  // The age question's own card, and the Rules' card.
  'account/firstasks.tsx': ['born', 'unavailable', 'offline'],
  // The fleet's boats: a boat's own refusals, said with the boat.
  'account/fleet.ts': ['unavailable', 'offline'],
  // The machine sailors: made, deleted, a token made.
  'account/machines.tsx': [
    'unavailable',
    'offline',
    'short',
    'long',
    'characters',
    'scripts',
    'words',
    'taken',
    'look',
    'cap',
    'confirm',
    'name',
    'not-found',
    'stopped',
  ],
  // A passkey added after a recovery code.
  'account/recovery.tsx': ['passkey-failed', 'no-passkeys', 'passkey-here', 'unavailable'],
  // The start screen: a sailor made, signed in, or a recovery code used.
  'account/start.tsx': [
    'short',
    'long',
    'characters',
    'scripts',
    'words',
    'taken',
    'born',
    'often',
    'check',
    'check-unavailable',
    'session',
    'refused',
    'unknown-passkey',
    'stopped',
    'code',
    'again',
    'unavailable',
    'offline',
  ],
  // A skipper's link, the player's own or their machine sailor's: the age
  // question and the Rules are asked on their cards, and a link made after;
  // too many links lately, and links resting, have words of their own.
  'ui/sailwithme.tsx': ['born', 'rules', 'human', 'unavailable'],
  // A statement's answer; the spectators' switch; a follow by name.
  'ui/statements.tsx': ['unavailable', 'offline', 'not-found'],
  'ui/watch.tsx': ['unavailable', 'offline'],
  'ui/watchcard.tsx': ['unavailable', 'offline', 'not-found'],
};

/** Every source file under src, not a test, by its path from src. */
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'gen') {
        out.push(...sources(p));
      }
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(relative(SRC, p));
    }
  }
  return out;
}

/** The calls in a file that turn a code into words: each one's argument. */
function calls(text: string): string[] {
  return [...text.matchAll(CALL)].map((m) => (m[1] ?? '').trim());
}

describe('a refusal the player can put right', () => {
  const files = sources();
  const texts = new Map(files.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));

  test('is found on the pages the sweep lists, and every page that shows a reason is listed', () => {
    const unlisted: string[] = [];
    for (const [f, text] of texts) {
      if (f === 'account/reasons.ts' || f.startsWith('owner/')) {
        continue;
      }
      const given = calls(text).filter((a) => !/^'[^']*'$/.test(a));
      if (given.length > 0 && SHOWN[f] === undefined) {
        unlisted.push(`${f}: ${given.join(', ')}`);
      }
    }
    expect(unlisted).toEqual([]);
    for (const f of Object.keys(SHOWN)) {
      expect(texts.has(f), f).toBe(true);
    }
  });

  test('has its cure on every page that can meet it, and the page holds the cure', () => {
    const missing: string[] = [];
    for (const [f, codes] of Object.entries(SHOWN)) {
      for (const code of codes) {
        const cure = CURES[code];
        if (cure !== undefined && cure.at[f] === undefined) {
          missing.push(`${f} can meet ${code} with no cure`);
        }
      }
    }
    for (const [code, cure] of Object.entries(CURES)) {
      for (const [f, mark] of Object.entries(cure.at)) {
        if (!(texts.get(f) ?? '').includes(mark)) {
          missing.push(`${code}: ${f} has no ${mark}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('is never given its words by name where its cure is not', () => {
    const bare: string[] = [];
    for (const [f, text] of texts) {
      for (const a of calls(text)) {
        const code = /^'([^']*)'$/.exec(a)?.[1];
        if (code !== undefined && CURES[code] !== undefined && CURES[code].at[f] === undefined) {
          bare.push(`${f}: ${code}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  test('the Rules of the sea have no words of their own to be printed: their card is the answer', () => {
    expect(REASONS.rules).toBeUndefined();
    expect(MACHINE_REASONS.rules).toBeUndefined();
    expect(reasonText('rules')).not.toMatch(/Rules/);
    expect(CURES.rules?.what).toMatch(/card/);
    expect(CURES.born?.what).toMatch(/card/);
  });
});
