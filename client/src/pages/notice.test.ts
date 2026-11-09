// SPDX-License-Identifier: AGPL-3.0-only

// The notice page's form: what it needs before it is sent, what it sends,
// and the server's answers in words.

import { describe, expect, test } from 'vitest';
import { NOTICE_REASONS, type Notice, noticeOf, noticeProblem, SENT, sendNotice } from './notice';

const filled: Notice = {
  who: 'A parent',
  contact: 'parent@example.org',
  sailor: 'Iron Mary',
  happened: 'Aboard Gull’s keelboat, Sunday evening',
  reason: 'child',
  what: 'Asked my child for their phone number.',
};

describe('the notice page', () => {
  test('the form’s values, trimmed', () => {
    const values: Record<string, string> = { ...filled, who: '  A parent ' };
    expect(noticeOf((k) => values[k] ?? '')).toEqual(filled);
  });

  test('who, how to reach them, a reason and what happened are needed; the rest may be left out', () => {
    expect(noticeProblem(filled)).toBe('');
    expect(noticeProblem({ ...filled, sailor: '', happened: '' })).toBe('');
    for (const k of ['who', 'contact', 'what', 'reason'] as const) {
      expect(noticeProblem({ ...filled, [k]: '' })).not.toBe('');
    }
    expect(noticeProblem({ ...filled, reason: 'young' })).not.toBe('');
    expect(noticeProblem({ ...filled, what: 'x'.repeat(2001) })).toMatch(/too long/);
    expect(NOTICE_REASONS[0]).toBe('child');
  });

  test('sent as JSON with no cookie; the answers in words', async () => {
    const asked: RequestInit[] = [];
    const answer = (status: number) => async (_: string, init?: RequestInit) => {
      asked.push(init ?? {});
      return new Response(status === 204 ? null : '{}', { status });
    };
    expect(await sendNotice(filled, answer(204))).toBe('');
    expect(JSON.parse(String(asked[0]?.body))).toEqual(filled);
    expect(asked[0]?.credentials).toBe('omit');
    expect(await sendNotice(filled, answer(400))).toMatch(/who you are/);
    expect(await sendNotice(filled, answer(429))).toMatch(/this hour/);
    expect(await sendNotice(filled, answer(503))).toMatch(/cannot answer/);
    expect(
      await sendNotice(filled, async () => {
        throw new Error('offline');
      }),
    ).toMatch(/cannot be reached/);
    expect(SENT).toBe('Thanks: the owner will read it.');
  });
});
