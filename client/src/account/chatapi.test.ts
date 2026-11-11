// SPDX-License-Identifier: AGPL-3.0-only

// The account's chat routes as the page reads them: the switch and its
// card, the mutes and blocks and their ends, the statements of reasons,
// read and answered once; and what the page makes of a server that
// cannot answer.

import { describe, expect, test } from 'vitest';
import { chatServer } from './chatapi';

/** A server answering by method and path, the bodies sent written down. */
function serverOf(answers: Record<string, () => Response>) {
  const sent: string[] = [];
  const s = chatServer(async (input, init) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    if (init?.body !== undefined) {
      sent.push(`${key} ${String(init.body)}`);
    }
    const a = answers[key];
    if (a === undefined) {
      throw new Error(`asked for ${key}`);
    }
    return a();
  });
  return { s, sent };
}

describe('the account’s chat', () => {
  test('the switch as read, and turned on and off', async () => {
    const { s, sent } = serverOf({
      'GET /api/me/chat': () => Response.json({ on: false, card: true, rules: true, asked: true }),
      'POST /api/me/chat': () => new Response(null, { status: 204 }),
    });
    expect(await s.read()).toEqual({ on: false, card: true, rules: true, asked: true });
    expect(await s.set(true)).toBe('ok');
    expect(await s.set(false)).toBe('ok');
    expect(sent).toEqual(['POST /api/me/chat {"on":true}', 'POST /api/me/chat {"on":false}']);
  });

  test('turned on before the age question: the server’s reason', async () => {
    const { s } = serverOf({
      'POST /api/me/chat': () => Response.json({ error: 'first' }, { status: 403 }),
    });
    expect(await s.set(true)).toBe('first');
  });

  test('the mutes and blocks, each ended', async () => {
    const { s, sent } = serverOf({
      'GET /api/me/ties': () =>
        Response.json([
          { id: 'a1', name: 'Iron Mary', kind: 'mute' },
          { id: 'b2', name: 'Gull', kind: 'block' },
          { name: 'no id' },
        ]),
      'POST /api/me/ties/end': () => new Response(null, { status: 204 }),
    });
    const ties = await s.ties();
    expect(ties).toEqual([
      { id: 'a1', name: 'Iron Mary', kind: 'mute' },
      { id: 'b2', name: 'Gull', kind: 'block' },
    ]);
    expect(await s.untie({ id: 'b2', name: 'Gull', kind: 'block' })).toBe(true);
    expect(sent).toEqual(['POST /api/me/ties/end {"id":"b2","kind":"block"}']);
  });

  test('the statements, read and answered once', async () => {
    const { s, sent } = serverOf({
      'GET /api/me/statements': () =>
        Response.json([
          {
            id: 's1',
            made: '2026-11-09T01:00:00Z',
            action: 'mute-chat',
            rule: 'No contact details or links',
            seen: 'a phone number',
            until: '2026-11-10T01:00:00Z',
            read: false,
          },
        ]),
      'POST /api/me/statements/read': () => new Response(null, { status: 204 }),
      'POST /api/me/statements/answer': () => Response.json({ error: 'answered' }, { status: 409 }),
    });
    expect(await s.statements()).toEqual([
      {
        id: 's1',
        made: Date.parse('2026-11-09T01:00:00Z'),
        action: 'mute-chat',
        rule: 'No contact details or links',
        seen: 'a phone number',
        until: Date.parse('2026-11-10T01:00:00Z'),
        read: false,
        answer: '',
        answered: 0,
      },
    ]);
    expect(await s.markRead('s1')).toBe(true);
    expect(await s.answer('s1', 'It was a ship’s number')).toBe('answered');
    expect(sent).toEqual([
      'POST /api/me/statements/read {"id":"s1"}',
      'POST /api/me/statements/answer {"id":"s1","answer":"It was a ship’s number"}',
    ]);
  });

  test('a server that cannot answer: nothing read, nothing done', async () => {
    const s = chatServer(async () => {
      throw new Error('offline');
    });
    expect(await s.read()).toBeNull();
    expect(await s.ties()).toBeNull();
    expect(await s.statements()).toBeNull();
    expect(await s.set(true)).toBe('offline');
    expect(await s.untie({ id: 'a', name: 'A', kind: 'mute' })).toBe(false);
  });
});
