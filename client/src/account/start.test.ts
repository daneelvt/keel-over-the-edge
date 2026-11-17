// SPDX-License-Identifier: AGPL-3.0-only

// The start screen's part in keeping new sailors human: the check's token
// sent with the first step, and spent after every answer to it; the words
// for the server's refusals and the check's own; and a returning
// browser's panel, signing in first and New sailor second.

import { type ComponentChildren, h, type VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { MAKE_TO_RACE, SIGN_IN_TO_RACE } from '../ui/racewords';
import { MAKE_TO_WATCH, SIGN_IN_TO_WATCH } from '../ui/watchwords';
import type { Fetch } from './me';
import { makeSailor, type Reach, reasonOf } from './passkeys';
import { CHECK_FAILED, CHECKING, REASONS, reasonText } from './reasons';
import { NEW_HERE, NEW_SAILOR, WELCOME_BACK, WelcomeBack } from './start';

const LOOK = { look: 'anne', version: 'v1', colour: 'red' };
const BORN = { year: 2001, month: 4 };

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

/** A server answering begin as told, the prompt making a passkey, finish making the sailor. */
function stand(begin: () => Response): Reach & { sent: unknown[]; log: string[] } {
  const sent: unknown[] = [];
  const log: string[] = [];
  const f: Fetch = async (url, init) => {
    log.push(String(url));
    if (url === '/account/begin') {
      sent.push(JSON.parse(String(init?.body)));
      return begin();
    }
    if (url === '/account/finish') {
      return answer(201, { name: 'Anne', ...LOOK, recoveryCode: 'CODE' });
    }
    throw new TypeError('offline');
  };
  return {
    fetch: f,
    prompt: {
      create: async () => {
        log.push('prompt');
        return { id: 'AQI', type: 'public-key', toJSON: () => ({ id: 'AQI' }) };
      },
      get: async () => Promise.reject(new Error('no get')),
    },
    pkc: { parseCreationOptionsFromJSON: (o) => o },
    sent,
    log,
  };
}

describe('the check’s token at Set sail', () => {
  test('sent as check with the first step, and spent as soon as it is answered, whatever the answer', async () => {
    const answers: [() => Response, string | null][] = [
      [() => answer(200, { publicKey: { challenge: 'AQID', user: { id: 'AQ' } } }), null],
      [() => answer(403, { error: 'check' }), 'check'],
      [() => answer(429, { error: 'often' }), 'often'],
      [() => answer(503, { error: 'check-unavailable' }), 'check-unavailable'],
      [() => answer(422, { error: 'taken' }), 'taken'],
      // Cloudflare's own 429: a page, not the server's JSON.
      [() => answer(429, '<html>Too many requests</html>'), 'unavailable'],
    ];
    for (const [begin, reason] of answers) {
      const r = stand(begin);
      const told: string[] = [];
      const res = await makeSailor('Anne', LOOK, BORN, r, {
        token: 'XXXX.DUMMY.TOKEN.XXXX',
        answered: () => told.push(`answered after ${r.log.join(', ')}`),
      });
      expect(r.sent).toEqual([
        { name: 'Anne', ...LOOK, born: BORN, check: 'XXXX.DUMMY.TOKEN.XXXX' },
      ]);
      // Spent once begin answered: before the passkey's prompt, which may be cancelled.
      expect(told).toEqual(['answered after /account/begin']);
      if (reason === null) {
        expect(res.ok).toBe(true);
        expect(r.log).toEqual(['/account/begin', 'prompt', '/account/finish']);
      } else {
        expect(res).toEqual({ ok: false, reason });
      }
    }
  });

  test('with no check, no token sent', async () => {
    const r = stand(() => answer(403, { error: 'check' }));
    await makeSailor('Anne', LOOK, BORN, r);
    expect(r.sent).toEqual([{ name: 'Anne', ...LOOK, born: BORN }]);
  });
});

describe('the words', () => {
  test('a new sailor’s limits, the check’s refusals and its own failure', () => {
    expect(reasonText('often')).toBe(
      'Lots of new sailors have come from this connection today. Sailed before? Sign in with your passkey.',
    );
    expect(reasonText('check')).toBe('We couldn’t check this browser. Tap Set sail to try again.');
    expect(reasonText('check-unavailable')).toBe(
      'The check isn’t answering just now. Try again in a moment.',
    );
    expect(CHECK_FAILED).toBe(
      'We couldn’t check this browser. Try again, or open the game in your usual browser.',
    );
    expect(CHECKING).toBe('Checking…');
    // Cloudflare's 429 page keeps the harbour's line.
    expect(reasonText(reasonOf({ status: 429, body: null }))).toBe(REASONS.unavailable);
    expect(REASONS.unavailable).toBe('The harbour cannot answer just now. Try again in a moment.');
  });

  test('a returning browser’s: welcomed back, and a link’s line asking it to sign in', () => {
    expect(WELCOME_BACK).toBe('Welcome back');
    expect(NEW_HERE).toBe('New here?');
    expect(NEW_SAILOR).toBe('New sailor');
    expect(SIGN_IN_TO_WATCH).toBe('Sign in, and you will be watching.');
    expect(SIGN_IN_TO_RACE).toBe('Sign in, and you can enter the race.');
    // The same promise as a new player's line.
    expect(SIGN_IN_TO_WATCH.replace('Sign in', 'Make a sailor')).toBe(MAKE_TO_WATCH);
    expect(SIGN_IN_TO_RACE.replace('Sign in', 'Make a sailor')).toBe(MAKE_TO_RACE);
  });

  test('short and plain: no codes, no times, nothing gruff', () => {
    for (const w of [
      REASONS.often,
      REASONS.check,
      REASONS['check-unavailable'],
      CHECK_FAILED,
      WELCOME_BACK,
      NEW_HERE,
      NEW_SAILOR,
    ]) {
      expect(w?.length ?? 0).toBeLessThan(110);
      expect(w).not.toMatch(/\d|error|denied|blocked|limit|captcha|robot|bot\b/i);
    }
  });
});

/** Every element of a tree, each component called through to what it draws. */
function expand(node: ComponentChildren): ComponentChildren {
  if (Array.isArray(node)) {
    return node.map(expand);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return node;
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  if (typeof v.type === 'function') {
    return expand((v.type as (p: unknown) => ComponentChildren)(v.props));
  }
  return { ...v, props: { ...v.props, children: expand(v.props.children) } } as VNode;
}

/** The text of a tree. */
function text(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(text).join('');
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) {
    return '';
  }
  return text((node as VNode<{ children?: ComponentChildren }>).props.children);
}

/** The tree's headings, fields and keys in order, as a player meets them. */
function parts(node: ComponentChildren): string[] {
  if (Array.isArray(node)) {
    return node.flatMap(parts);
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren; type?: string }>;
  switch (v.type) {
    case 'h1':
      return [`heading ${text(v)}`];
    case 'input':
      return [`field ${(v.props as { autocomplete?: string }).autocomplete}`];
    case 'button':
      return [`${v.props.type} ${text(v)}`];
  }
  return parts(v.props.children);
}

describe('a returning browser’s panel', () => {
  const panel = (busy: boolean) =>
    expand(
      WelcomeBack({
        lines: h('p', { class: 'start-watching' }, 'To watch, make a sailor.'),
        warning: null,
        field: h('input', { id: 'start-name', autocomplete: 'username webauthn' }),
        problem: '',
        busy,
        signIn: () => {},
        lost: () => {},
        newSailor: () => {},
      }),
    );

  test('Welcome back, signing in first with the browser’s offer on the name field, New sailor second', () => {
    expect(parts(panel(false))).toEqual([
      'heading Welcome back',
      'field username webauthn',
      'submit Sign in with a passkey',
      'button Lost your passkey? Use your recovery code',
      'button New sailor',
    ]);
  });

  test('a link’s line stays at its head', () => {
    const t = text(panel(false));
    expect(t.indexOf('To watch, make a sailor.')).toBeGreaterThan(t.indexOf(WELCOME_BACK));
    expect(t.indexOf('To watch, make a sailor.')).toBeLessThan(t.indexOf('Sign in with a passkey'));
  });

  test('while the prompt is open, its keys wait', () => {
    const disabled: boolean[] = [];
    const walk = (n: ComponentChildren): void => {
      if (Array.isArray(n)) {
        n.forEach(walk);
      } else if (n !== null && typeof n === 'object' && 'type' in n) {
        const v = n as VNode<{ children?: ComponentChildren; disabled?: boolean }>;
        if (v.type === 'button' && v.props.disabled !== undefined) {
          disabled.push(v.props.disabled);
        }
        walk(v.props.children);
      }
    };
    walk(panel(true));
    expect(disabled).toEqual([true, true]);
    expect(text(panel(true))).toContain('Choose your passkey.');
  });
});
