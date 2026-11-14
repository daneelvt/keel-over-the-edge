// SPDX-License-Identifier: AGPL-3.0-only

// What of the news has been read: kept in the browser's storage, the latest
// few hundred; for the page alone when the browser refuses it; and the News
// tab's dot while today's edition has a story not yet read.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkUnread, KEEP, markRead, readStories, unread, unreadOf } from './newsread';
import type { Edition, NewsStory } from './newswords';

const story = (id: string): NewsStory => ({
  id,
  kind: 'great',
  at: 0,
  head: 'KEYHOLE ROCK',
  text: 'First sighted by {0}.',
  names: [{ kind: 'human', name: 'Mira' }],
  number: 7,
});

const edition = (ids: { lead?: string[]; stories?: string[]; shipmates?: string[] }): Edition => ({
  world: 14,
  day: '2026-11-12',
  number: 4,
  zone: 'America/New_York',
  set: false,
  figures: { boats: 0, machines: 0, run: 0, charted: 0, crews: 0, over: 0 },
  figuresText: '',
  lead: (ids.lead ?? []).map(story),
  stories: (ids.stories ?? []).map(story),
  shipmates: (ids.shipmates ?? []).map(story),
  notices: [],
  days: [],
});

/** A browser's storage, kept in a map. */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('the stories read', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('kept in the browser, so a story read stays read after a reload', () => {
    markRead(['a', 'b']);
    markRead(['b', 'c']);
    expect([...readStories()]).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(localStorage.getItem('keel.news.read') ?? '[]')).toEqual(['a', 'b', 'c']);
    expect(unreadOf(edition({ lead: ['a'], stories: ['c', 'd'], shipmates: ['e'] }))).toEqual([
      'd',
      'e',
    ]);
  });

  test('the latest few hundred kept, the earliest let go', () => {
    markRead(Array.from({ length: KEEP + 50 }, (_, i) => `s${i}`));
    const read = readStories();
    expect(read.size).toBe(KEEP);
    expect(read.has('s0')).toBe(false);
    expect(read.has(`s${KEEP + 49}`)).toBe(true);
  });

  test('for this page alone when the browser refuses its storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('refused');
      },
    });
    markRead(['x']);
    expect(readStories().has('x')).toBe(true);
    expect(unreadOf(edition({ stories: ['x', 'y'] }))).toEqual(['y']);
  });

  test('a stored list not of names is no list', () => {
    localStorage.setItem('keel.news.read', '{"a":1}');
    expect(() => readStories()).not.toThrow();
    localStorage.setItem('keel.news.read', 'not json');
    expect(() => markRead(['z'])).not.toThrow();
  });
});

describe('the News tab’s dot', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('on while today’s edition has a story not yet read; as it was when the news cannot be had', async () => {
    unread.value = false;
    await checkUnread(async () => edition({ stories: ['p', 'q'] }));
    expect(unread.value).toBe(true);
    await checkUnread(async () => null);
    expect(unread.value).toBe(true);
    markRead(['p', 'q']);
    await checkUnread(async () => edition({ stories: ['p', 'q'] }));
    expect(unread.value).toBe(false);
  });
});
