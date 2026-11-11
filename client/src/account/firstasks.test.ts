// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { acceptRules, sendBorn } from './firstasks';
import {
  AGE_QUESTION,
  bornOf,
  bornYears,
  CANT_BE_MADE,
  CANT_SAIL,
  firstAsks,
  MONTHS,
  RULES_LINES,
  RULES_PAGE,
  SAFETY_PAGE,
  YEARS_BACK,
  youngCookie,
} from './firstwords';
import type { Fetch } from './me';
import { reasonText } from './reasons';

const NOW = new Date(2026, 10, 8);

/** A server that answers one status and body, keeping what it was sent. */
function server(
  status: number,
  body?: unknown,
): { f: Fetch; sent: { path: string; body: unknown }[] } {
  const sent: { path: string; body: unknown }[] = [];
  const f: Fetch = async (path, init) => {
    sent.push({ path, body: JSON.parse(String(init?.body ?? 'null')) });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { f, sent };
}

describe('when a sailor was born', () => {
  test('the months by name, January first', () => {
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[0]).toBe('January');
    expect(MONTHS[11]).toBe('December');
  });

  test('the years: this one first, back 120 years', () => {
    const years = bornYears(NOW);
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(2026 - YEARS_BACK);
    expect(years).toHaveLength(YEARS_BACK + 1);
  });

  test('an answer only once both boxes hold one of their choices', () => {
    expect(bornOf('', '', NOW)).toBeNull();
    expect(bornOf('4', '', NOW)).toBeNull();
    expect(bornOf('', '2001', NOW)).toBeNull();
    expect(bornOf('13', '2001', NOW)).toBeNull();
    expect(bornOf('0', '2001', NOW)).toBeNull();
    expect(bornOf('4', '1800', NOW)).toBeNull();
    expect(bornOf('4', '2030', NOW)).toBeNull();
    expect(bornOf('4.5', '2001', NOW)).toBeNull();
    expect(bornOf('4', '2001', NOW)).toEqual({ year: 2001, month: 4 });
    expect(bornOf('11', '2026', NOW)).toEqual({ year: 2026, month: 11 });
  });

  test('the words name no age and give no hint of one', () => {
    for (const w of [
      AGE_QUESTION,
      CANT_BE_MADE,
      CANT_SAIL,
      reasonText('born'),
      reasonText('young'),
    ]) {
      expect(w).not.toMatch(/\d|old|young|age|must|at least|under|over/i);
    }
    expect(reasonText('young')).toBe(CANT_BE_MADE);
  });

  test('the cookie of an under-age answer, and no other', () => {
    expect(youngCookie('keel-young=1')).toBe(true);
    expect(youngCookie('a=b; keel-young=1; c=d')).toBe(true);
    expect(youngCookie('')).toBe(false);
    expect(youngCookie('keel-young=0')).toBe(false);
    expect(youngCookie('not-keel-young=1')).toBe(false);
    expect(youngCookie('keel-young=10')).toBe(false);
  });

  test('sent once of an older sailor: answered, answered before, young, refused', async () => {
    const ok = server(204);
    expect(await sendBorn(ok.f, { year: 2001, month: 4 })).toBe('answered');
    expect(ok.sent).toEqual([{ path: '/api/me/born', body: { year: 2001, month: 4 } }]);
    expect(await sendBorn(server(409, { error: 'answered' }).f, { year: 2001, month: 4 })).toBe(
      'answered',
    );
    expect(await sendBorn(server(403, { error: 'young' }).f, { year: 2020, month: 1 })).toBe(
      'young',
    );
    expect(await sendBorn(server(400, { error: 'born' }).f, { year: 2001, month: 4 })).toBe('born');
    expect(await sendBorn(server(403, { error: 'stopped' }).f, { year: 2001, month: 4 })).toBe(
      'stopped',
    );
  });
});

describe('the Rules of the sea', () => {
  test('in short, with the pages in full', () => {
    const all = RULES_LINES.join(' ');
    for (const w of [
      'contact details',
      'links',
      'harassment',
      'hate',
      'sexual',
      'scams',
      'cheating',
    ]) {
      expect(all).toContain(w);
    }
    expect(all).toContain('machine sailor');
    expect(all).toContain('ashore');
    expect(all).toContain('stop');
    expect(RULES_PAGE).toBe('/rules.html');
    expect(SAFETY_PAGE).toBe('/safety.html');
  });

  test('accepted once', async () => {
    const ok = server(204);
    expect(await acceptRules(ok.f)).toBe('answered');
    expect(ok.sent).toEqual([{ path: '/api/me/rules', body: {} }]);
    expect(await acceptRules(server(503).f)).toBe('unavailable');
  });
});

describe('what is still to ask', () => {
  test('when born, then the Rules, each until it is done', () => {
    expect(firstAsks({ born: false, rules: false })).toEqual(['age', 'rules']);
    expect(firstAsks({ born: true, rules: false })).toEqual(['rules']);
    expect(firstAsks({ born: false, rules: true })).toEqual(['age']);
    expect(firstAsks({ born: true, rules: true })).toEqual([]);
    expect(firstAsks({})).toEqual(['age', 'rules']);
  });
});
