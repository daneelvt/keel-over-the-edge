// SPDX-License-Identifier: AGPL-3.0-only

// The shipmates' routes as the page reads them: the list, read strictly;
// an offer and each of its answers, by account or by seat; accepting, a
// lapsed offer; declining, ending, blocking, reporting and appearing
// offline; and a server that cannot answer.

import { describe, expect, test } from 'vitest';
import { listOf, shipmatesServer } from './shipmatesapi';

/** A server answering by method and path, the bodies sent written down. */
function serverOf(answers: Record<string, () => Response>) {
  const sent: string[] = [];
  const s = shipmatesServer(async (input, init) => {
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

const done = () => new Response(null, { status: 204 });

describe('the list', () => {
  test('read as the server sends it', async () => {
    const { s } = serverOf({
      'GET /api/shipmates': () =>
        Response.json({
          offline: true,
          messages: false,
          shipmates: [
            { id: 'a', name: 'Iron Mary', look: 12, presence: 'sea', skipper: true },
            { id: 'b', name: 'Bosun Bly', look: 3, presence: 'game', skipper: false },
            { id: 'c', name: 'Meg', look: 4, presence: '' },
          ],
          offers: [{ id: 'd', name: 'Captain Quill', look: 5 }],
          recent: [
            { id: 'e', name: 'Tarry Tom', look: 6, shipmate: false, offered: true, can: false },
          ],
        }),
    });
    expect(await s.list()).toEqual({
      offline: true,
      messages: false,
      shipmates: [
        { id: 'a', name: 'Iron Mary', look: 12, presence: 'sea', skipper: true },
        { id: 'b', name: 'Bosun Bly', look: 3, presence: 'game', skipper: false },
        { id: 'c', name: 'Meg', look: 4, presence: '', skipper: false },
      ],
      offers: [{ id: 'd', name: 'Captain Quill', look: 5 }],
      recent: [{ id: 'e', name: 'Tarry Tom', look: 6, shipmate: false, offered: true, can: false }],
    });
  });

  test('anything not the list’s is left out: no ID, a presence unknown, a look unreadable', () => {
    expect(
      listOf({
        shipmates: [{ name: 'no id' }, { id: 'a', name: 'Mary', look: 'x', presence: 'moon' }, 7],
        offers: 'none',
      }),
    ).toEqual({
      offline: false,
      messages: true,
      shipmates: [{ id: 'a', name: 'Mary', look: -1, presence: '', skipper: false }],
      offers: [],
      recent: [],
    });
    expect(listOf(null)).toBeNull();
    expect(listOf([])).toBeNull();
  });

  test('a server that cannot answer: null', async () => {
    const { s } = serverOf({ 'GET /api/shipmates': () => new Response('down', { status: 502 }) });
    expect(await s.list()).toBeNull();
    const gone = shipmatesServer(async () => {
      throw new TypeError('offline');
    });
    expect(await gone.list()).toBeNull();
    expect(await gone.offer({ id: 'a' })).toBe('offline');
  });
});

describe('offering, and answering an offer', () => {
  test('an offer by account or by seat, and each answer', async () => {
    let result = 'offered';
    const { s, sent } = serverOf({
      'POST /api/shipmates/offer': () => Response.json({ result }),
    });
    expect(await s.offer({ id: 'a' })).toBe('offered');
    for (const r of ['made', 'not-yet', 'full', 'offers', 'already']) {
      result = r;
      expect(await s.offer({ seat: 2 })).toBe(r);
    }
    result = 'something new';
    expect(await s.offer({ seat: 2 })).toBe('unavailable');
    expect(sent[0]).toBe('POST /api/shipmates/offer {"id":"a"}');
    expect(sent[1]).toBe('POST /api/shipmates/offer {"seat":2}');
  });

  test('accepted, lapsed, full', async () => {
    let answer = () => Response.json({ result: 'made' });
    const { s, sent } = serverOf({ 'POST /api/shipmates/accept': () => answer() });
    expect(await s.accept('d')).toBe('made');
    answer = () => Response.json({ error: 'gone' }, { status: 409 });
    expect(await s.accept('d')).toBe('gone');
    answer = () => Response.json({ error: 'full' }, { status: 409 });
    expect(await s.accept('d')).toBe('full');
    expect(sent[0]).toBe('POST /api/shipmates/accept {"id":"d"}');
  });

  test('declined, ended, blocked, reported and offline: each said to the server', async () => {
    const { s, sent } = serverOf({
      'POST /api/shipmates/decline': done,
      'POST /api/shipmates/end': done,
      'POST /api/shipmates/block': done,
      'POST /api/shipmates/report': done,
      'POST /api/me/offline': done,
    });
    expect(await s.decline('d')).toBe(true);
    expect(await s.end({ id: 'a' })).toBe(true);
    expect(await s.end({ seat: 1 })).toBe(true);
    expect(await s.block('b')).toBe(true);
    expect(await s.report('b', 'bullying', 'unkind')).toBe(true);
    expect(await s.offline(true)).toBe(true);
    expect(sent).toEqual([
      'POST /api/shipmates/decline {"id":"d"}',
      'POST /api/shipmates/end {"id":"a"}',
      'POST /api/shipmates/end {"seat":1}',
      'POST /api/shipmates/block {"id":"b"}',
      'POST /api/shipmates/report {"id":"b","reason":"bullying","note":"unkind"}',
      'POST /api/me/offline {"on":true}',
    ]);
  });

  test('a route that fails: false', async () => {
    const { s } = serverOf({
      'POST /api/shipmates/end': () => new Response(null, { status: 500 }),
    });
    expect(await s.end({ id: 'a' })).toBe(false);
  });
});
