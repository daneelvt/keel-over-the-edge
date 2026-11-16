// SPDX-License-Identifier: AGPL-3.0-only

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as bindings } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import { CSP } from '../src/headers';
import { answer, type Env, fetchStatus, KEPT, KEYS, KV, type Outside, refresh } from '../src/index';
import { RESTING } from '../src/map/draw';
import type { Status } from '../src/status';
import { seed1 } from './seed';

const ID = 'website-id';
const SECRET = 'website-secret';

/** keel: answering with the status, or not at all; each call counted, with what it was sent. */
function keel(status: Status | null) {
  const calls: { url: string; headers: Headers }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    if (status === null) {
      return new Response('{"error":"starting"}', { status: 503 });
    }
    return Response.json(status);
  }) as typeof fetch;
  return { calls, fetch: f };
}

/** A KV that counts its writes, over the test's own. */
function counted(kv: KVNamespace): KVNamespace & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    get: kv.get.bind(kv) as KVNamespace['get'],
    put: async (key: string, value: string) => {
      puts.push(key);
      await kv.put(key, value);
    },
    delete: kv.delete.bind(kv),
  };
}

let cacheName = 0;
let cache: Cache;
let kv: ReturnType<typeof counted>;

beforeEach(async () => {
  // Each test its own cache and its own KV.
  cache = await caches.open(`test-${cacheName++}`);
  kv = counted(bindings.WEBSITE);
  for (const k of Object.values(KV)) {
    await bindings.WEBSITE.delete(k);
  }
});

function envWith(): Env {
  return {
    ASSETS: { fetch: async () => new Response('<!doctype html><p>The page</p>', { headers: { 'Content-Type': 'text/html' } }) },
    WEBSITE: kv,
    STATUS_URL: 'https://play.keelovertheedge.com/api/status',
    ACCESS_CLIENT_ID: ID,
    ACCESS_CLIENT_SECRET: SECRET,
  };
}

function outside(k: ReturnType<typeof keel>): Outside {
  return { fetch: k.fetch, now: () => Date.parse('2026-11-17T21:30:00Z'), cache: () => cache };
}

/** Asks the Worker for a path, and waits for what it does after answering (its cache's writes). */
async function ask(path: string, e: Env, out: Outside, method = 'GET'): Promise<Response> {
  const ctx = createExecutionContext();
  const r = await answer(new Request(`https://keelovertheedge.com${path}`, { method }), e, ctx, out);
  await waitOnExecutionContext(ctx);
  return r;
}

describe('keel’s status, through Access', () => {
  test('sent with the service token', async () => {
    const k = keel(seed1());
    expect(await fetchStatus(envWith(), outside(k))).not.toBeNull();
    expect(k.calls).toHaveLength(1);
    expect(k.calls[0]?.url).toBe('https://play.keelovertheedge.com/api/status');
    expect(k.calls[0]?.headers.get('CF-Access-Client-Id')).toBe(ID);
    expect(k.calls[0]?.headers.get('CF-Access-Client-Secret')).toBe(SECRET);
  });

  test('anything but a status taken as no answer', async () => {
    const odd = { fetch: (async () => Response.json({ error: 'access' }, { status: 403 })) as typeof fetch, now: Date.now, cache: () => cache };
    expect(await fetchStatus(envWith(), odd)).toBeNull();
    const wrong = { fetch: (async () => Response.json({ hello: 1 })) as typeof fetch, now: Date.now, cache: () => cache };
    expect(await fetchStatus(envWith(), wrong)).toBeNull();
    const down = { fetch: (async () => { throw new Error('down'); }) as typeof fetch, now: Date.now, cache: () => cache };
    expect(await fetchStatus(envWith(), down)).toBeNull();
    const k = keel(seed1());
    expect(await fetchStatus({ ...envWith(), ACCESS_CLIENT_SECRET: '' }, outside(k))).toBeNull();
    expect(k.calls).toHaveLength(0);
  });
});

describe('/live', () => {
  test('the numbers, kept 30 s in the cache under the apex', async () => {
    const k = keel(seed1());
    const r = await ask('/live', envWith(), outside(k));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ atSea: 0, machinesAtSea: 0, world: 7, charted: 368, resting: false, turn: { weekday: 'Sunday', time: '18:00', zone: 'America/New_York' } });
    const kept = await cache.match(KEYS.status);
    expect(kept?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.status}`);
    await ask('/live', envWith(), outside(k));
    expect(k.calls).toHaveLength(1);
  });

  test('resting when keel does not answer, with nothing kept', async () => {
    const r = await ask('/live', envWith(), outside(keel(null)));
    expect(await r.json()).toEqual({ resting: true });
    expect((await cache.match(KEYS.status))?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.resting}`);
  });

  test('resting with the last good numbers when keel does not answer', async () => {
    await refresh(envWith(), outside(keel(seed1())));
    const r = await ask('/live', envWith(), outside(keel(null)));
    expect(await r.json()).toMatchObject({ world: 7, charted: 368, resting: true });
  });
});

describe('/map.svg', () => {
  test('drawn from keel’s status, kept 10 minutes', async () => {
    const r = await ask('/map.svg', envWith(), outside(keel(seed1())));
    expect(r.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    const svg = await r.text();
    expect(svg).toContain("<title>The world’s chart now</title>");
    expect((await cache.match(KEYS.map))?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.picture}`);
  });

  test('the last good map, marked resting, when keel does not answer', async () => {
    await refresh(envWith(), outside(keel(seed1())));
    const good = await bindings.WEBSITE.get(KV.map, 'text');
    const svg = await (await ask('/map.svg', envWith(), outside(keel(null)))).text();
    expect(svg).toContain(`<title>The world’s chart: ${RESTING.toLowerCase()}</title>`);
    // The kept picture itself, from its definitions on.
    const from = (x: string) => x.slice(x.indexOf('<defs>'), x.indexOf('<defs>') + 4000);
    expect(from(svg)).toBe(from(good ?? ''));
    expect((await cache.match(KEYS.map))?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.resting}`);
  });

  test('with nothing kept either, a resting map with no world', async () => {
    const svg = await (await ask('/map.svg', envWith(), outside(keel(null)))).text();
    expect(svg).toContain(`<title>The world’s chart: ${RESTING.toLowerCase()}</title>`);
    expect(svg.length).toBeLessThan(60_000);
  });
});

describe('/share.png', () => {
  test('1200 × 630 and under a million bytes, kept 10 minutes', async () => {
    const r = await ask('/share.png', envWith(), outside(keel(seed1())));
    expect(r.headers.get('Content-Type')).toBe('image/png');
    const png = new Uint8Array(await r.arrayBuffer());
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new DataView(png.buffer, png.byteOffset + 16, 8);
    expect([ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual([1200, 630]);
    expect(png.length).toBeLessThan(1_000_000);
    expect((await cache.match(KEYS.share))?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.picture}`);
  });

  test('resting, when keel does not answer', async () => {
    const r = await ask('/share.png', envWith(), outside(keel(null)));
    const png = new Uint8Array(await r.arrayBuffer());
    expect(png.length).toBeGreaterThan(1000);
    expect((await cache.match(KEYS.share))?.headers.get('Cache-Control')).toBe(`public, max-age=${KEPT.resting}`);
  });
});

describe('/next.ics', () => {
  test('the calendar, from the status’s turn and end', async () => {
    const r = await ask('/next.ics', envWith(), outside(keel(seed1())));
    expect(r.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(r.headers.get('Content-Disposition')).toContain('attachment');
    const text = await r.text();
    expect(text).toContain('DTSTART;TZID=America/New_York:20261122T180000');
  });

  test('none to give with no status at all', async () => {
    const r = await ask('/next.ics', envWith(), outside(keel(null)));
    expect(r.status).toBe(503);
  });
});

describe('KV, the last good copy', () => {
  test('the cron writes the status and the map', async () => {
    expect(await refresh(envWith(), outside(keel(seed1())))).toBe(true);
    expect(kv.puts.sort()).toEqual([KV.map, KV.status].sort());
    expect(await bindings.WEBSITE.get(KV.map, 'text')).toContain('<svg');
  });

  test('the cron leaves it as it was when keel does not answer', async () => {
    await refresh(envWith(), outside(keel(seed1())));
    kv.puts.length = 0;
    expect(await refresh(envWith(), outside(keel(null)))).toBe(false);
    expect(kv.puts).toEqual([]);
  });

  test('a request never writes it, keel answering or not', async () => {
    for (const s of [seed1(), null]) {
      cache = await caches.open(`test-${cacheName++}`);
      for (const path of ['/', '/live', '/map.svg', '/share.png', '/next.ics', '/nowhere']) {
        await ask(path, envWith(), outside(keel(s)));
      }
    }
    expect(kv.puts).toEqual([]);
  });
});

describe('every answer carries the security headers', () => {
  test.each(['/', '/live', '/map.svg', '/share.png', '/next.ics', '/nowhere'])('%s', async (path) => {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const r = await ask(path, envWith(), outside(keel(seed1())), method);
      expect(r.headers.get('Content-Security-Policy')).toBe(CSP);
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      if (method === 'POST') {
        expect(r.status).toBe(405);
      }
      if (method === 'HEAD') {
        expect(await r.text()).toBe('');
      }
    }
  });

  test('the CSP is the static files’ too', async () => {
    const file = await import('../../site/_headers?raw');
    expect(file.default).toContain(`Content-Security-Policy: ${CSP}`);
  });
});
