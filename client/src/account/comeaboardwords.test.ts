// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  askAboardText,
  cantKnockText,
  LINK_ENDED,
  linkOf,
  OWN_LINK,
  sailFromQuery,
  theKind,
} from './comeaboardwords';

describe('a link to come aboard', () => {
  test('its token from the page’s query, and none from any other', () => {
    const q = (s: string) => sailFromQuery(new URL(s, 'https://play.example').searchParams);
    expect(q('/?s=AbC_d-19')).toBe('AbC_d-19');
    expect(q('/?test&s=AbC_d-19')).toBe('AbC_d-19');
    expect(q('/')).toBe('');
    expect(q('/?s=')).toBe('');
    expect(q('/?s=a/b')).toBe('');
    expect(q('/?s=a%20b')).toBe('');
    expect(q('/?w=abc')).toBe('');
    expect(q('/sail/abc')).toBe('');
  });

  test('read from the server’s answer', () => {
    const link = { skipper: 'Iron Mary', look: 3, kind: 1, boat: 'Saltpeter', can: 'ok' };
    expect(linkOf(200, link)).toEqual({ kind: 'link', link });
    expect(linkOf(200, { ...link, boat: undefined })).toEqual({
      kind: 'link',
      link: { ...link, boat: '' },
    });
    expect(linkOf(410, { error: 'ended' })).toEqual({ kind: 'ended' });
    expect(linkOf(200, { ...link, can: 'maybe' })).toEqual({ kind: 'failed' });
    expect(linkOf(200, null)).toEqual({ kind: 'failed' });
    expect(linkOf(401, { error: 'session' })).toEqual({ kind: 'failed' });
    expect(linkOf(503, null)).toEqual({ kind: 'failed' });
  });

  test('the knock’s button names the boat, or its kind, and the skipper', () => {
    expect(askAboardText('Keelboat', 'Saltpeter', 'Iron Mary')).toBe(
      'Ask to come aboard «Saltpeter» with Iron Mary',
    );
    expect(askAboardText('Keelboat', '', 'Iron Mary')).toBe(
      'Ask to come aboard the keelboat with Iron Mary',
    );
    expect(theKind('Tall ship')).toBe('the tall ship');
  });

  test('how the link stands, in a sailor’s words', () => {
    expect(cantKnockText('ok', 'Iron Mary')).toBe('');
    expect(cantKnockText('not-at-sea', 'Iron Mary')).toBe(
      'Iron Mary’s boat isn’t in the water now.',
    );
    expect(cantKnockText('full', 'Iron Mary')).toBe('Iron Mary’s boat has no room aboard.');
    expect(cantKnockText('closed', 'Iron Mary')).toBe('Iron Mary isn’t taking crew now.');
    expect(cantKnockText('own', 'Iron Mary')).toBe(OWN_LINK);
    expect(LINK_ENDED).toBe('This link has ended.');
  });
});
