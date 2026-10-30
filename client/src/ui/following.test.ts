// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Fetch } from '../account/me';
import { ASK_EVERY, followSailing, sailingNow, setSail } from './following';

/** A server whose follows are the answers given, one an ask. */
function server(answers: (object | number)[]): { f: Fetch; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const f: Fetch = async (input) => {
    asked.push(input);
    const a = answers[Math.min(i++, answers.length - 1)];
    return typeof a === 'number'
      ? new Response('{}', { status: a })
      : new Response(JSON.stringify(a), { status: 200 });
  };
  return { f, asked };
}

const page = (names: string[], gone: string[] = [], more = false) => ({
  sailors: [
    ...names.map((name) => ({ name, followed: true })),
    ...gone.map((name) => ({ name, followed: true, gone: 'cannot' })),
  ],
  more,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the sailors followed setting sail', () => {
  test('only those that may be watched are sailing, over every page', async () => {
    const { f, asked } = server([page(['Iron Mary'], [], true), page(['Tin Tom'], ['Ann Bonny'])]);
    expect(await sailingNow(f)).toEqual(new Set(['Iron Mary', 'Tin Tom']));
    expect(asked[0]).toBe('/api/watch?who=following&sort=name&page=0');
    expect(asked[1]).toContain('page=1');
  });

  test('an answer that cannot be read is none', async () => {
    expect(await sailingNow(server([503]).f)).toBeNull();
  });

  test('the first answer raises nothing; after it, those newly on it', () => {
    expect(setSail(null, new Set(['Iron Mary']))).toEqual([]);
    expect(setSail(new Set(['Iron Mary']), new Set(['Iron Mary', 'Ann Bonny']))).toEqual([
      'Ann Bonny',
    ]);
    expect(setSail(new Set(['Iron Mary', 'Ann Bonny']), new Set(['Ann Bonny']))).toEqual([]);
  });

  test('asked every 30 s, told once a sailor sets sail, not while hidden', async () => {
    vi.useFakeTimers();
    let hidden = false;
    const { f, asked } = server([
      page(['Iron Mary']),
      page(['Iron Mary']),
      page([], ['Iron Mary']),
      page(['Iron Mary', 'Ann Bonny']),
    ]);
    const told: string[] = [];
    const stop = followSailing(
      (n) => told.push(n),
      f,
      () => hidden,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(told).toEqual([]);
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(told).toEqual([]);
    // Iron Mary leaves the water, then sails again with Ann Bonny.
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    hidden = true;
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(asked).toHaveLength(3);
    hidden = false;
    await vi.advanceTimersByTimeAsync(ASK_EVERY);
    expect(told).toEqual(['Iron Mary', 'Ann Bonny']);
    stop();
    await vi.advanceTimersByTimeAsync(ASK_EVERY * 3);
    expect(asked).toHaveLength(4);
  });
});
