// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { fillText, type NoticeKind, Notices, saveNoticesOff } from './notices';

const kinds: NoticeKind[] = [
  {
    id: 'own',
    name: 'Yours',
    on: 'charted-own',
    level: 'active',
    switchable: true,
    stays: 8,
    text: 'You charted {name}',
    folded: 'You charted {count} places',
  },
  {
    id: 'great',
    name: 'Great',
    on: 'charted-great',
    level: 'passive',
    switchable: true,
    stays: 5,
    text: '{who} charted {name}',
    folded: '{count} great discoveries',
  },
  {
    id: 'other',
    name: 'Other',
    on: 'other',
    level: 'passive',
    switchable: false,
    stays: 5,
    text: 'other {name}',
    folded: '{count} others',
  },
  {
    id: 'fourth',
    name: 'Fourth',
    on: 'fourth',
    level: 'passive',
    switchable: false,
    stays: 5,
    text: 'fourth',
    folded: '{count} fourths',
  },
  {
    id: 'fifth',
    name: 'Fifth',
    on: 'fifth',
    level: 'passive',
    switchable: false,
    stays: 5,
    text: 'fifth',
    folded: '{count} fifths',
  },
];

describe('the notices', () => {
  it('fills in their words', () => {
    expect(fillText('{who} charted {name}', { who: 'Mira', name: 'Keyhole Rock' })).toBe(
      'Mira charted Keyhole Rock',
    );
    expect(fillText('{missing}', {})).toBe('{missing}');
  });

  it('shows one, queues at most three, and folds the same kind', () => {
    const n = new Notices(kinds, 3);
    n.raise('charted-own', { name: 'A' }, 0);
    n.raise('charted-own', { name: 'B' }, 100);
    expect(n.shown.value?.text).toBe('You charted 2 places');
    n.raise('charted-great', { who: 'Mira', name: 'C' }, 200);
    n.raise('other', { name: 'D' }, 300);
    n.raise('fourth', {}, 300);
    n.raise('fifth', {}, 300);
    expect(n.waiting).toBe(3);
    n.raise('charted-great', { who: 'Tom', name: 'E' }, 400);
    expect(n.waiting).toBe(3);
    n.dismiss(500);
    expect(n.shown.value?.text).toBe('2 great discoveries');
    expect(n.shown.value?.kind.level).toBe('passive');
  });

  it('goes by itself once its time is up, the active ones later than the passive', () => {
    const n = new Notices(kinds, 3);
    n.raise('charted-great', { who: 'Mira', name: 'C' }, 0);
    n.tick(4_999);
    expect(n.shown.value).not.toBeNull();
    n.tick(5_000);
    expect(n.shown.value).toBeNull();
    n.raise('charted-own', { name: 'A' }, 10_000);
    n.tick(17_000);
    expect(n.shown.value).not.toBeNull();
    n.tick(18_000);
    expect(n.shown.value).toBeNull();
  });

  it('shows none of a kind switched off, and saves the switches', async () => {
    const n = new Notices(kinds, 3);
    const saved: string[][] = [];
    n.save = async (off) => {
      saved.push(off);
      return true;
    };
    expect(await n.set('great', false)).toBe(true);
    n.raise('charted-great', { who: 'Mira', name: 'C' }, 0);
    expect(n.shown.value).toBeNull();
    await n.set('great', true);
    expect(saved).toEqual([['great'], []]);
  });

  it('keeps the switches on the account: POST /api/me/notices', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = await saveNoticesOff(['great'], (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    expect(ok).toBe(true);
    expect(calls[0]?.[0]).toBe('/api/me/notices');
    expect(calls[0]?.[1]?.method).toBe('POST');
    expect(calls[0]?.[1]?.body).toBe('{"off":["great"]}');
  });
});
