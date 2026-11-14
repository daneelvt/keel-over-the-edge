// SPDX-License-Identifier: AGPL-3.0-only

// Races ashore's routes, as the page reads them: a link's code from the
// query, a card or a refusal with its reason and when it lifts, the
// network's fault as "offline", the calendar file fetched with the session
// and saved under the name the server gives it, and the races to watch
// remembered on the device.

import { describe, expect, test } from 'vitest';
import type { Fetch } from '../account/me';
import {
  fileNameOf,
  makeRace,
  raceAct,
  raceFromQuery,
  readCard,
  saveCalendar,
  suggestName,
  watchedRaces,
  watchRace,
} from './raceapi';

/** A server that answers one status and body, and records what it was asked. */
function server(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Fetch & { asked: { url: string; init?: RequestInit }[] } {
  const asked: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    asked.push({ url, ...(init === undefined ? {} : { init }) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers,
    });
  }) as Fetch & { asked: typeof asked };
  f.asked = asked;
  return f;
}

describe('a race’s link', () => {
  test('its code from the query: ten letters and digits of base32', () => {
    expect(raceFromQuery(new URLSearchParams('r=abcdefgh23'))).toBe('abcdefgh23');
    expect(raceFromQuery(new URLSearchParams('r=ABCDEFGH23'))).toBeNull();
    expect(raceFromQuery(new URLSearchParams('r=abcdefgh19'))).toBeNull();
    expect(raceFromQuery(new URLSearchParams('w=abcdefgh23'))).toBeNull();
  });
});

describe('the routes', () => {
  test('a card read, with the session', async () => {
    const f = server(200, { code: 'abcdefghij', name: 'Tuesday Triangle' });
    const a = await readCard('abcdefghij', f);
    expect(a.ok && a.value.name).toBe('Tuesday Triangle');
    expect(f.asked[0]?.url).toBe('/api/race/abcdefghij');
    expect(f.asked[0]?.init?.credentials).toBe('same-origin');
  });

  test('a refusal’s reason and when it lifts', async () => {
    const a = await raceAct(
      'abcdefghij',
      'enter',
      { crew: false },
      server(409, { error: 'daily', until: 1763160000000 }),
    );
    expect(a).toEqual({
      ok: false,
      refusal: { status: 409, reason: 'daily', until: 1763160000000 },
    });
    const n = await makeRace(
      { kind: 'race', course: 'c', boat: 'b', at: 1, who: 'everyone', name: 'x' },
      server(409, { error: 'name', name: 'short' }),
    );
    expect(n.ok ? null : n.refusal).toEqual({ status: 409, reason: 'name', name: 'short' });
  });

  test('a race made is 201; a proxy’s page or a fault of the network is read as such', async () => {
    const made = await makeRace(
      { kind: 'race', course: 'c', boat: 'b', at: 1, who: 'everyone', name: '' },
      server(201, { code: 'abcdefghij' }),
    );
    expect(made.ok).toBe(true);
    const page = await readCard('abcdefghij', server(502, '<html>'));
    expect(page.ok ? null : page.refusal.reason).toBe('unread');
    const down = await readCard('abcdefghij', (async () => {
      throw new TypeError('failed');
    }) as Fetch);
    expect(down.ok ? null : down.refusal.reason).toBe('offline');
  });

  test('an act’s body goes as JSON; one without goes bare', async () => {
    const f = server(200, {});
    await raceAct('abcdefghij', 'remove', { number: 3 }, f);
    await raceAct('abcdefghij', 'withdraw', undefined, f);
    expect(f.asked[0]?.url).toBe('/api/race/abcdefghij/remove');
    expect(f.asked[0]?.init?.body).toBe('{"number":3}');
    expect(f.asked[1]?.init?.body).toBeUndefined();
  });

  test('a name suggested; none when the server gives none', async () => {
    const f = server(200, { name: 'the Gannet Holm Gallop' });
    expect(await suggestName({ kind: 'race', course: 'island:3', boat: 'b', at: 5.4 }, f)).toBe(
      'the Gannet Holm Gallop',
    );
    expect(f.asked[0]?.url).toBe('/api/race/name?kind=race&course=island%3A3&boat=b&at=5');
    expect(
      await suggestName({ kind: 'race', course: 'c', boat: 'b', at: 0 }, server(500, {})),
    ).toBe('');
  });
});

describe('Add to calendar', () => {
  test('the file fetched with the session, saved under the server’s name', async () => {
    const f = server(200, 'BEGIN:VCALENDAR', {
      'Content-Disposition': 'attachment; filename="Tuesday Triangle.ics"',
    });
    const saved: string[] = [];
    expect(await saveCalendar('abcdefghij', f, (_b, name) => saved.push(name))).toBe(true);
    expect(saved).toEqual(['Tuesday Triangle.ics']);
    expect(f.asked[0]?.url).toBe('/api/race/abcdefghij/calendar.ics');
    expect(f.asked[0]?.init?.credentials).toBe('same-origin');
    expect(await saveCalendar('abcdefghij', server(404, {}), () => {})).toBe(false);
  });

  test('the file’s name from a Content-Disposition, or the fallback', () => {
    expect(fileNameOf('attachment; filename="a b.ics"', 'x')).toBe('a b.ics');
    expect(fileNameOf("attachment; filename*=UTF-8''caf%C3%A9.ics", 'x')).toBe('café.ics');
    expect(fileNameOf(null, 'race.ics')).toBe('race.ics');
  });
});

describe('Watch when it starts', () => {
  test('remembered on the device, the newest last, each once', () => {
    const m = new Map<string, string>();
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as unknown as Storage;
    watchRace('aaaaaaaaaa', storage);
    watchRace('bbbbbbbbbb', storage);
    watchRace('aaaaaaaaaa', storage);
    expect(watchedRaces(storage)).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa']);
    expect(watchedRaces(null)).toEqual([]);
  });
});
