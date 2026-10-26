// SPDX-License-Identifier: AGPL-3.0-only

// The players' accounts in words, as the world page's Accounts tab tells
// them: the counts at its head, an account's card, and the owner's hand on
// an account, each action that cannot be taken back first checked, the
// server's words of what it would do shown, and done only once those are
// confirmed. A confirmation open closes as soon as what it was asked for
// changes, so that no stray click does what was not read.

import type { AccountCard, AccountsData, CardApp, Sort } from './api';
import { machinesWords, plural } from './machines';

/** How the accounts found may be ordered, in words. */
export const SORTS: Record<Sort, string> = {
  'active-new': 'Last active, newest first',
  'active-old': 'Last active, oldest first',
  made: 'Made, newest first',
  machines: 'Machine sailors’ latest call',
};

/** The accounts the server lists a page. */
export const PAGE = 50;

/** A reason's bounds, in characters. */
export const MAX_REASON = 500;

/** The Accounts tab's head: the humans, the machine sailors and the grants live, and those stopped. */
export function countsWords(a: AccountsData): string {
  const words = [`${plural(a.total, 'human')}: ${a.week} made this week, ${a.today} seen today`];
  if (a.machines !== undefined) {
    words.push(machinesWords(a.machines));
  }
  if (a.stopped !== undefined) {
    words.push(
      `stopped: ${plural(a.stopped.human, 'human')}, ${plural(a.stopped.ai, 'machine sailor')}`,
    );
  }
  return words.join('; ');
}

const days = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const moments = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** A day in the owner's zone, "26 Oct 2026"; never for none. */
export function dayWords(ms: number): string {
  return ms > 0 ? days.format(ms) : 'never';
}

/** A moment in the owner's zone, "26 Oct 2026, 18:05"; never for none. */
export function momentWords(ms: number): string {
  return ms > 0 ? moments.format(ms) : 'never';
}

/** An account's kind, as the owner and the players say it. */
export function kindWords(kind: AccountCard['kind']): string {
  return kind === 'ai' ? 'machine sailor' : 'human';
}

/** Why a reason will not do, or "" when it will: required for all but starting again. */
export function reasonProblem(reason: string, required: boolean): string {
  const n = [...reason.trim()].length;
  if (n === 0) {
    return required ? `A reason is needed, up to ${MAX_REASON} characters.` : '';
  }
  return n > MAX_REASON ? `A reason is at most ${MAX_REASON} characters: this is ${n}.` : '';
}

/** An account stopped: when, why, and whether only because its human is. */
export function stoppedWords(s: NonNullable<AccountCard['stopped']>): string {
  const why = s.reason.trim() === '' ? '' : `: ${s.reason.trim()}`;
  const human = s.byOwner ? ', because its human is stopped' : '';
  return `stopped on ${momentWords(s.at)}${human}${why}`;
}

/** The fleet in one line, by the boats' ids: "2 jolly-boat". */
export function fleetWords(fleet: Record<string, number>): string {
  const parts = Object.entries(fleet)
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${n} ${id}`);
  return parts.length === 0 ? 'none' : parts.join(', ');
}

/** An app approved: where it returns to, when approved and last used, and when its grant ends or how it ended. */
export function appWords(a: CardApp): string {
  const where = a.loopback ? 'an app on its owner’s computer' : a.returnHost;
  const end = a.ended
    ? `ended${a.endedHow === undefined || a.endedHow === '' ? '' : `, ${a.endedHow}`}`
    : `ends ${dayWords(a.ends)}`;
  return `${where}; approved ${dayWords(a.approved)}, last used ${dayWords(a.lastUsed)}, ${end}`;
}

/** What the owner may do to an account. */
export type Verb = 'stop' | 'start' | 'revoke' | 'delete';

/** Each action's button. */
export const VERBS: Record<Verb, string> = {
  stop: 'Stop',
  start: 'Start again',
  revoke: 'Revoke tokens',
  delete: 'Delete',
};

/** What the owner typed for an action: the reason, and for deleting the sailor's name again. */
export interface Typed {
  reason: string;
  name: string;
}

/** Why an action cannot be asked yet, or "". */
export function typedProblem(verb: Verb, t: Typed): string {
  const r = reasonProblem(t.reason, verb !== 'start');
  if (r !== '') {
    return r;
  }
  return verb === 'delete' && t.name.trim() === ''
    ? 'Type the sailor’s name again to delete it.'
    : '';
}

/** An action's body, as the server takes it: the reason trimmed, and none for starting again without one. */
export function actionBody(verb: Verb, account: string, t: Typed): Record<string, string> {
  const body: Record<string, string> = { account };
  const reason = t.reason.trim();
  if (verb !== 'start' || reason !== '') {
    body.reason = reason;
  }
  if (verb === 'delete') {
    body.name = t.name.trim();
  }
  return body;
}

/** Whether an action is first checked by the server, its words shown, before it is done. */
export function checked(verb: Verb): boolean {
  return verb !== 'start';
}

/** The words of an action the server does not check: starting again. */
export function startWords(name: string, reason: string): string {
  const why = reason.trim() === '' ? '' : ` The reason kept: ${reason.trim()}`;
  return `Start ${name} again? It may sign in and sail once more.${why}`;
}

/** An action done, as the page's message says it. */
export function doneWords(verb: Verb, name: string): string {
  switch (verb) {
    case 'stop':
      return `${name} stopped`;
    case 'start':
      return `${name} started again`;
    case 'revoke':
      return `${name}'s tokens revoked`;
    case 'delete':
      return `${name} deleted`;
  }
}

/**
 * An action on its way: being checked, asked of the owner with the words
 * of what it does and the body that was checked, or being sent.
 */
export type Flow =
  | { step: 'idle' }
  | { step: 'checking'; verb: Verb }
  | { step: 'asked'; verb: Verb; body: Record<string, string>; words: string }
  | { step: 'sending'; verb: Verb; body: Record<string, string>; words: string };

export type FlowEvent =
  | { kind: 'check'; verb: Verb }
  | { kind: 'ask'; verb: Verb; body: Record<string, string>; words: string }
  | { kind: 'refused' }
  | { kind: 'edit' }
  | { kind: 'cancel' }
  | { kind: 'confirm' }
  | { kind: 'done' };

/**
 * The next step. A check is asked only from rest; its answer is shown only
 * for the action being checked, and not once what was typed has changed
 * since; confirming sends only what is asked; nothing closes what is on
 * its way.
 */
export function nextFlow(f: Flow, e: FlowEvent): Flow {
  switch (e.kind) {
    case 'check':
      return f.step === 'idle' || f.step === 'asked' ? { step: 'checking', verb: e.verb } : f;
    case 'ask':
      return (f.step === 'checking' && f.verb === e.verb) || (f.step === 'idle' && !checked(e.verb))
        ? { step: 'asked', verb: e.verb, body: e.body, words: e.words }
        : f;
    case 'refused':
      return f.step === 'checking' ? { step: 'idle' } : f;
    case 'edit':
      return f.step === 'asked' || f.step === 'checking' ? { step: 'idle' } : f;
    case 'cancel':
      return f.step === 'asked' ? { step: 'idle' } : f;
    case 'confirm':
      return f.step === 'asked' ? { ...f, step: 'sending' } : f;
    case 'done':
      return f.step === 'sending' ? { step: 'idle' } : f;
  }
}
