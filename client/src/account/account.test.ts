// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test } from 'vitest';
import { catalog } from '../catalog';
import { SailingAs } from '../ui/menu';
import { PlayerText } from '../ui/player';
import { createGuest } from './guest';
import { drawLook } from './looks';
import { checkSession, type Fetch, type Me, resolveSailor, retryDelay } from './me';
import { displayForm, lengthProblem, nameLength, REASONS, reasonText } from './reasons';

// Every code the server answers a guest's start with (internal/api).
const SERVER_CODES = [
  'short',
  'long',
  'characters',
  'scripts',
  'words',
  'taken',
  'session',
  'look',
  'malformed',
  'content-type',
  'too-large',
  'cross-origin',
  'unavailable',
];

describe('reasons', () => {
  test('every server code has words of its own', () => {
    for (const code of [...SERVER_CODES, 'offline']) {
      expect(REASONS[code], code).toBeDefined();
      expect(reasonText(code)).toBe(REASONS[code]);
    }
    expect(reasonText('something new')).toBe('Something went wrong. Try again.');
  });

  // internal/moderation's tests write the server's counts of these names
  // (testdata/lengths.json); the page must count the same.
  test("names are counted as the server counts them, from the server's table", () => {
    const table = JSON.parse(
      readFileSync(
        new URL('../../../internal/moderation/testdata/lengths.json', import.meta.url),
        'utf8',
      ),
    ) as { name: string; length: number; reason?: 'short' | 'long' }[];
    expect(table.length).toBeGreaterThan(10);
    for (const row of table) {
      expect(nameLength(row.name), row.name).toBe(row.length);
      expect(lengthProblem(row.name), row.name).toBe(row.reason ?? null);
    }
  });

  test('the display form trims and collapses spaces and folds width', () => {
    expect(displayForm('  Sea    Wolf ')).toBe('Sea Wolf');
    expect(displayForm('Ｓｅａ')).toBe('Sea');
  });
});

describe('looks', () => {
  const sailors = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];

  test('are drawn from the sailors given, another each time', () => {
    let current = drawLook(sailors);
    for (let i = 0; i < 100; i++) {
      const next = drawLook(sailors, current);
      expect(sailors).toContain(next);
      expect(next).not.toBe(current);
      current = next;
    }
    expect(drawLook(sailors, null, () => 0)).toBe(sailors[0]);
    expect(drawLook(sailors, null, () => 0.999)).toBe(sailors[2]);
  });

  test("with one sailor, that one; the catalog's sailors are all drawn", () => {
    const one = sailors.slice(0, 1);
    expect(drawLook(one, one[0])).toBe(one[0]);
    expect(catalog.sailors).toContain(drawLook(catalog.sailors));
    expect(() => drawLook([])).toThrow();
  });
});

// Expands function components, so a test can see the elements they make.
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

function findAll(node: ComponentChildren, type: string): VNode<{ children?: ComponentChildren }>[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, type));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as VNode<{ children?: ComponentChildren }>;
  return [...(v.type === type ? [v] : []), ...findAll(v.props.children, type)];
}

describe("a player's name", () => {
  test('is text inside a <bdi>', () => {
    for (const name of ['Ann Bonny', 'نور', '<b>Ann</b>']) {
      const bdi = findAll(expand(PlayerText({ text: name })), 'bdi');
      expect(bdi).toHaveLength(1);
      expect(bdi[0]?.props.children).toBe(name);
    }
    const menu = expand(SailingAs({ sailor: 'נועה' }));
    expect(findAll(menu, 'bdi')[0]?.props.children).toBe('נועה');
    expect(SailingAs({ sailor: null })).toBeNull();
  });
});

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const ann: Me = { name: 'Ann Bonny', look: 'a', kind: 'human', saved: false };

describe('the session check', () => {
  test('a session, none, or a failure', async () => {
    expect(await checkSession(async () => answer(200, ann))).toEqual({ kind: 'sailor', me: ann });
    expect(await checkSession(async () => answer(401, { error: 'session' }))).toEqual({
      kind: 'none',
    });
    expect(await checkSession(async () => answer(503, 'down'))).toEqual({ kind: 'failed' });
    expect(await checkSession(async () => answer(200, 'not json'))).toEqual({ kind: 'failed' });
    expect(
      await checkSession(async () => {
        throw new TypeError('offline');
      }),
    ).toEqual({ kind: 'failed' });
  });

  test('chooses the sea, the start screen or "Back soon"', async () => {
    const run = async (answers: (() => Response)[]) => {
      const log: string[] = [];
      let i = 0;
      const fetcher: Fetch = async () => {
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a === undefined) {
          throw new TypeError('offline');
        }
        return a();
      };
      const me = await resolveSailor({
        fetch: fetcher,
        start: async () => {
          log.push('start');
          return { ...ann, name: 'New' };
        },
        backSoon: (shown) => log.push(shown ? 'back soon' : 'hidden'),
        wait: async (ms) => {
          log.push(`wait ${ms}`);
        },
      });
      return { me, log };
    };
    expect(await run([() => answer(200, ann)])).toEqual({ me: ann, log: ['hidden'] });
    expect(await run([() => answer(401, {})])).toEqual({
      me: { ...ann, name: 'New' },
      log: ['hidden', 'start'],
    });
    const offline = () => {
      throw new TypeError('offline');
    };
    expect(await run([offline, () => answer(502, 'x'), () => answer(200, ann)])).toEqual({
      me: ann,
      log: ['back soon', 'wait 1000', 'back soon', 'wait 2000', 'hidden'],
    });
    expect(retryDelay(10)).toBe(30_000);
  });
});

describe('making a guest', () => {
  test('made, refused with a reason, or failed', async () => {
    let sent: RequestInit | undefined;
    const made = await createGuest('Ann Bonny', 'a', async (_url, init) => {
      sent = init;
      return answer(201, { name: 'Ann Bonny', look: 'a' });
    });
    expect(made).toEqual({ ok: true, me: ann });
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(String(sent?.body))).toEqual({ name: 'Ann Bonny', look: 'a' });
    expect(await createGuest('Ann', 'a', async () => answer(422, { error: 'taken' }))).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(await createGuest('Ann', 'a', async () => answer(502, '<html>'))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(
      await createGuest('Ann', 'a', async () => {
        throw new TypeError('offline');
      }),
    ).toEqual({ ok: false, reason: 'offline' });
  });
});
