// SPDX-License-Identifier: AGPL-3.0-only

// A link to watch, opened once signed in: the sailor it opens, or why
// none, for a sailor's link and a fleet's. On the player's own panel:
// their link to share, with its faint line while the box is unticked; a
// link that opened no watch, in words, with ☆ Follow for a sailor's, and
// word once the sailor followed may be watched. And a link taken out of
// the address once used, the rest kept.

import type { ComponentChildren, VNode } from 'preact';
import { describe, expect, test, vi } from 'vitest';
import { voyage } from './letwatch';
import { withoutParams } from './links';
import type { Fetch, LinkNote, Me } from './me';
import { openLink } from './openlink';
import { LinkRefused, refusedState, toggleFollow, YourLink } from './yourlink';
import { YourSailor } from './yoursailor';

vi.stubGlobal('location', { origin: 'https://play.example' });

const daneel: Me = {
  name: 'Daneel',
  look: 'a',
  version: 'v',
  colour: 'c',
  kind: 'human',
  watchCode: 'k3x7q2mbwa',
  fleetCode: 'abcdefgh23',
};

/** A server answering every request with status and body, recording what it was asked. */
function server(status: number, body: unknown): { f: Fetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    f: async (input, init) => {
      asked.push(`${init?.method ?? 'GET'} ${input}${init?.body ? ` ${String(init.body)}` : ''}`);
      return new Response(JSON.stringify(body), { status });
    },
  };
}

describe('a link opened', () => {
  test('a sailor’s: the sailor to watch, asked by its code', async () => {
    const s = server(200, { name: 'Daneel', machine: false });
    expect(await openLink({ kind: 'sailor', code: 'k3x7q2mbwa' }, s.f)).toEqual({
      watch: 'Daneel',
    });
    expect(s.asked).toEqual(['GET /api/watch/link?w=k3x7q2mbwa']);
  });

  test('a fleet’s: the first of its sailors at sea, or none', async () => {
    const s = server(200, { sailors: [{ name: 'Iron Mary' }, { name: 'Brass Bess' }] });
    expect(await openLink({ kind: 'fleet', code: 'abcdefgh23' }, s.f)).toEqual({
      watch: 'Iron Mary',
    });
    expect(s.asked).toEqual(['GET /api/watch/link?f=abcdefgh23']);
    expect(await openLink({ kind: 'fleet', code: 'x' }, server(200, { sailors: [] }).f)).toEqual({
      refusal: { why: 'no-fleet' },
    });
  });

  test('refused: why, and whose; a link no longer in use; one that cannot be read', async () => {
    const link = { kind: 'sailor', code: 'k3x7q2mbwa' } as const;
    expect(
      await openLink(link, server(404, { error: 'cannot', name: 'Daneel', machine: false }).f),
    ).toEqual({
      refusal: { why: 'cannot', name: 'Daneel', machine: false },
    });
    expect(
      await openLink(
        link,
        server(404, { error: 'not-at-sea', name: 'Iron Mary', machine: true }).f,
      ),
    ).toEqual({ refusal: { why: 'not-at-sea', name: 'Iron Mary', machine: true } });
    expect(await openLink(link, server(404, { error: 'no-link' }).f)).toEqual({
      refusal: { why: 'no-link' },
    });
    expect(await openLink(link, server(503, { error: 'unavailable' }).f)).toEqual({
      refusal: { why: 'unread' },
    });
    const down: Fetch = async () => {
      throw new Error('offline');
    };
    expect(await openLink(link, down)).toEqual({ refusal: { why: 'unread' } });
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

function textOf(node: ComponentChildren): string {
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node !== 'object') {
    return String(node);
  }
  return textOf((node as VNode<{ children?: ComponentChildren }>).props.children);
}

type Node = VNode<Record<string, unknown> & { children?: ComponentChildren }>;

function findAll(node: ComponentChildren, keep: (v: Node) => boolean): Node[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => findAll(n, keep));
  }
  if (node === null || typeof node !== 'object' || !('type' in node)) {
    return [];
  }
  const v = node as Node;
  return [...(keep(v) ? [v] : []), ...findAll(v.props.children, keep)];
}

const buttons = (t: ComponentChildren) => findAll(t, (v) => v.type === 'button').map(textOf);

describe('the player’s own link', () => {
  test('Share a link to watch me and Make a new link, the faint line while unticked', () => {
    const unticked = expand(YourLink({ me: daneel, ticked: false }));
    expect(buttons(unticked)).toEqual(['Share a link to watch me', 'Make a new link']);
    expect(textOf(unticked)).toContain(
      'Your link shows your boat only on voyages you let others watch.',
    );
    const ticked = expand(YourLink({ me: daneel, ticked: true }));
    expect(textOf(ticked)).not.toContain('Your link shows your boat');
    expect(YourLink({ me: { ...daneel, watchCode: '' }, ticked: false })).toBeNull();
  });

  test('on Your sailor, under Set sail, whether or not the box is ticked', () => {
    const v = voyage(daneel, async () => new Response('{}'));
    const t = expand(YourSailor({ me: daneel, voyage: v, sail: () => {}, watch: null }));
    expect(buttons(t)).toEqual([
      'Set sail as Daneel',
      'Share a link to watch me',
      'Make a new link',
      'Watch another sailor',
    ]);
  });
});

describe('a link that opened no watch, on the player’s own panel', () => {
  const note = (refusal: LinkNote['refusal'], code = 'k3x7q2mbwa'): LinkNote => ({ refusal, code });

  test('why, at the head of Your sailor; ☆ Follow for a sailor’s link only', () => {
    const v = voyage(daneel, async () => new Response('{}'));
    const visitor: Me = { ...daneel, name: 'Visitor', watchCode: 'zzzzzzzzzz' };
    const cases: [LinkNote, string, string[]][] = [
      [
        note({ why: 'cannot', name: 'Daneel', machine: false }),
        'Daneel cannot be watched now.',
        ['☆ Follow'],
      ],
      [
        note({ why: 'not-at-sea', name: 'Iron Mary', machine: true }),
        'Iron Mary is not at sea.',
        ['☆ Follow'],
      ],
      [note({ why: 'own', name: 'Visitor', machine: false }), 'That is your own boat.', []],
      [note({ why: 'no-link' }), 'This link is no longer in use.', []],
      [note({ why: 'no-fleet' }, ''), 'None of this fleet is at sea now.', []],
    ];
    for (const [n, words, keys] of cases) {
      const t = expand(
        YourSailor({ me: { ...visitor, linkNote: n }, voyage: v, sail: () => {}, watch: null }),
      );
      const head = findAll(t, (x) => x.props['data-readout'] === 'link-refused');
      expect(head).toHaveLength(1);
      expect(textOf(head)).toBe(`${words}${keys.join('')}`);
      expect(buttons(head)).toEqual(keys);
      // Set sail and Watch another sailor below it, as always.
      expect(buttons(t)).toContain('Set sail as Visitor');
      expect(buttons(t)).toContain('Watch another sailor');
    }
  });

  test('followed by its code; told here once the sailor may be watched, with Watch', async () => {
    const n = note({ why: 'cannot', name: 'Daneel', machine: false });
    const st = refusedState(n);
    const s = server(200, { following: 1 });
    let raise: (name: string) => void = () => {};
    let stopped = 0;
    const follows = (r: (name: string) => void) => {
      raise = r;
      return () => {
        stopped++;
      };
    };
    await toggleFollow(n, st, s.f, follows);
    expect(s.asked).toEqual(['POST /api/watch/follow {"code":"k3x7q2mbwa","on":true}']);
    expect(st.followed.value).toBe(true);
    const watched: string[] = [];
    const draw = () => expand(LinkRefused({ note: n, watch: (name) => watched.push(name) }));
    expect(buttons(draw())).toEqual(['★ Following']);
    raise('Somebody else');
    expect(st.sailing.value).toBe(false);
    raise('Daneel');
    expect(textOf(draw())).toBe('Daneel is sailing, and can be watched now.Watch');
    const watch = findAll(draw(), (v) => v.type === 'button')[0]?.props.onClick as () => void;
    watch();
    expect(watched).toEqual(['Daneel']);
    expect(stopped).toBe(1);
  });

  test('a follow refused says why; unfollowed, the asking stops', async () => {
    const n = note({ why: 'not-at-sea', name: 'Iron Mary', machine: true });
    const st = refusedState(n);
    await toggleFollow(n, st, server(409, { error: 'too-many' }).f, () => () => {});
    expect(st.followed.value).toBe(false);
    expect(st.problem.value).toBe('You follow 100 sailors: unfollow one first');
    let stopped = 0;
    await toggleFollow(n, st, server(200, { following: 1 }).f, () => () => stopped++);
    await toggleFollow(n, st, server(200, { following: 0 }).f, () => () => stopped++);
    expect(st.followed.value).toBe(false);
    expect(stopped).toBe(1);
  });
});

describe('a link taken out of the address once used', () => {
  test('its query alone, the rest kept', () => {
    expect(withoutParams('?test&w=abc&draw=off', 'w', 'f')).toBe('?test&draw=off');
    expect(withoutParams('?wind=12,45&w=abc', 'w')).toBe('?wind=12,45');
    expect(withoutParams('?f=abc', 'w', 'f')).toBe('');
    expect(withoutParams('', 's')).toBe('');
    expect(withoutParams('?s=tok&sky=dusk', 's')).toBe('?sky=dusk');
  });
});
