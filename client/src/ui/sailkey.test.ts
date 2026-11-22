// SPDX-License-Identifier: AGPL-3.0-only

// The menu's key for the skipper's link: its words for each state of the
// link, and the first link it gets: kept on the device, and refused while
// anything is still to be asked or the server says no.

import { describe, expect, test } from 'vitest';
import { firstLink, sailKey, sailKeyText } from './sailkey';
import { keptLink, type LinkServer, type LinkStore, type Made } from './sailwithme';

const link = { url: 'https://play.example/?s=abc', expires: Date.parse('2026-11-24T12:00:00Z') };

function server(asks: LinkServer['asks'], made: Made): LinkServer & { made: number } {
  const s = {
    made: 0,
    asks,
    status: async () => null,
    make: async () => {
      s.made++;
      return made;
    },
    end: async () => true,
  };
  return s;
}

function memory(): LinkStore {
  const kept = new Map<string, string>();
  return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) };
}

describe('the menu’s key for the link to sail with me', () => {
  test('its words: get one, copy the one out, copied; the page for the rest', () => {
    expect(sailKeyText(sailKey({ kind: 'none', ended: false }), false)).toBe(
      'Get a Sail with me link',
    );
    expect(sailKeyText(sailKey({ kind: 'reading' }), false)).toBe('Get a Sail with me link');
    expect(sailKeyText(sailKey({ kind: 'here', link }), false)).toBe('Copy my Sail with me link');
    expect(sailKeyText(sailKey({ kind: 'here', link }), true)).toBe('Sail with me link copied');
    // A new link would end one out elsewhere: the page says so first.
    expect(sailKey({ kind: 'elsewhere', expires: link.expires })).toBe('page');
    expect(sailKey({ kind: 'unread' })).toBe('page');
    expect(sailKeyText('page', false)).toBe('Sail with me link');
  });

  test('a first link is made and kept on the device', async () => {
    const store = memory();
    const s = server(async () => [], { link });
    expect(await firstLink(s, 'Iron Mary', store)).toEqual(link);
    expect(keptLink('Iron Mary', store)).toEqual(link);
  });

  test('none is made while anything is still to be asked', async () => {
    const store = memory();
    const s = server(async () => ['rules'], { link });
    await expect(firstLink(s, 'Bosun Bly', store)).rejects.toThrow('rules');
    expect(s.made).toBe(0);
    expect(keptLink('Bosun Bly', store)).toBeNull();
  });

  test('a link refused is not kept', async () => {
    const store = memory();
    const s = server(async () => null, { error: 'links-off' });
    await expect(firstLink(s, 'Gull', store)).rejects.toThrow('links-off');
    expect(keptLink('Gull', store)).toBeNull();
  });
});
