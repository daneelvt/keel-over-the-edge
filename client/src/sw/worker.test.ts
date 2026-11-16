// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
  type Answer,
  ART_CACHE,
  activate,
  asset,
  clear,
  codeCache,
  type Deps,
  install,
  type Plan,
  page,
  route,
  type Store,
  type Stores,
  top,
} from './worker';

const ORIGIN = 'https://play.example';

/** A cache in memory, keyed by the request's whole address, as CacheStorage is. */
class FakeCache implements Store {
  readonly entries = new Map<string, Response>();

  async match(request: RequestInfo): Promise<Response | undefined> {
    return this.entries.get(href(request))?.clone();
  }
  async put(request: RequestInfo, response: Response): Promise<void> {
    this.entries.set(href(request), response);
  }
  async keys(): Promise<readonly Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
  async delete(request: RequestInfo): Promise<boolean> {
    return this.entries.delete(href(request));
  }
  paths(): string[] {
    return [...this.entries.keys()].map((u) => new URL(u).pathname).sort();
  }
}

function href(request: RequestInfo): string {
  return new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
}

/** CacheStorage in memory: its names in the order the caches were made. */
class FakeCaches implements Stores {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (c === undefined) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  /** A cache filled with paths, each answered with its own path as its body. */
  fill(name: string, paths: string[]): void {
    const c = new FakeCache();
    for (const p of paths) {
      c.entries.set(new URL(p, ORIGIN).href, new Response(`kept ${p}`));
    }
    this.caches.set(name, c);
  }
}

/** The server: its files by path, and every path asked of it. */
class FakeServer {
  readonly files = new Map<string, { body: string; status?: number }>();
  readonly asked: string[] = [];
  down = false;
  /** Holds every answer until let go. */
  hold: Promise<void> | null = null;

  readonly fetch = async (request: RequestInfo): Promise<Response> => {
    const path = new URL(typeof request === 'string' ? request : request.url, ORIGIN).pathname;
    this.asked.push(path);
    if (this.hold !== null) {
      await this.hold;
    }
    if (this.down) {
      throw new TypeError('Failed to fetch');
    }
    const f = this.files.get(path);
    if (f === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(f.body, { status: f.status ?? 200 });
  };
}

const plan = (build: string, code: string[], art: string[] = []): Plan => ({
  build,
  code: ['/', '/icon-192.png', ...code],
  art,
  entry: code[0] ?? '',
});

function setUp(p: Plan, waits: (ms: number) => Promise<void> = () => new Promise(() => {})) {
  const caches = new FakeCaches();
  const server = new FakeServer();
  server.files.set('/', { body: `<script src="${p.entry}"></script>` });
  server.files.set('/icon-192.png', { body: 'icon' });
  for (const f of [...p.code.slice(2), ...p.art]) {
    server.files.set(f, { body: `served ${f}` });
  }
  const deps: Deps = { plan: p, caches, fetch: server.fetch, origin: ORIGIN, wait: waits };
  return { caches, server, deps };
}

const req = (path: string) => new Request(new URL(path, ORIGIN));

describe('what the worker answers', () => {
  const ask = (
    path: string,
    more: { method?: string; mode?: string; range?: string } = {},
  ): Answer =>
    route(
      {
        url: new URL(path, ORIGIN).href,
        method: more.method ?? 'GET',
        mode: more.mode ?? 'cors',
        range: more.range ?? null,
      },
      ORIGIN,
    );
  const nav = (path: string) => ask(path, { mode: 'navigate' });

  test('the game’s page, network first: plain, with a link to watch, a fleet or a race', () => {
    expect(nav('/')).toBe('page');
    expect(nav('/?w=abc')).toBe('page');
    expect(nav('/?f=abc')).toBe('page');
    expect(nav('/?r=abc')).toBe('page');
    expect(nav('/?test')).toBe('page');
  });

  test('a skipper’s link is never answered from the kept page', () => {
    expect(nav('/?s=AbC_d-19')).toBe('network');
    expect(nav('/?test&s=x')).toBe('network');
    expect(nav('/?s=')).toBe('network');
  });

  test('the game’s files, from the cache first; a part of one from the server', () => {
    expect(ask('/assets/main-BmL3Vph-.js')).toBe('asset');
    expect(ask('/assets/physics-vEkzvVVf.wasm')).toBe('asset');
    expect(ask('/assets/jolly-boat-x.glb')).toBe('asset');
    expect(ask('/assets/worker-x.js', { mode: 'same-origin' })).toBe('asset');
    expect(ask('/assets/sea-x.m4a', { range: 'bytes=0-' })).toBe('network');
  });

  test('the icons and the manifest, stale while revalidate', () => {
    expect(ask('/icon-192.png')).toBe('top');
    expect(ask('/icon-512.png')).toBe('top');
    expect(ask('/apple-touch-icon.png')).toBe('top');
    expect(ask('/manifest.webmanifest')).toBe('top');
  });

  test('everything else straight to the network, untouched', () => {
    for (const path of [
      '/api/me',
      '/api/version',
      '/api/client-report',
      '/ws',
      '/w/7/12/3',
      '/oauth/authorize?client_id=x',
      '/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/passkey/begin',
      '/account/new',
      '/signin/begin',
      '/recovery',
      '/logout',
      '/mcp',
      '/report',
      '/sw.js',
      '/third-party-licences.txt',
      '/rules.html',
      '/dev.html',
      '/sailors.html',
      '/owner/',
      '/',
    ]) {
      expect(ask(path), path).toBe('network');
    }
    for (const path of [
      '/rules.html',
      '/privacy.html',
      '/report',
      '/oauth/authorize',
      '/dev.html',
    ]) {
      expect(nav(path), path).toBe('network');
    }
  });

  test('nothing but GET, and nothing from another site', () => {
    expect(ask('/assets/main-x.js', { method: 'POST' })).toBe('network');
    expect(ask('/assets/main-x.js', { method: 'HEAD' })).toBe('network');
    expect(nav('https://other.example/')).toBe('network');
    expect(ask('https://other.example/assets/main-x.js')).toBe('network');
  });
});

describe('installing a build', () => {
  test('every file of its code kept in its own cache', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/log-1.js'], ['/assets/boat-1.glb']);
    const { caches, server, deps } = setUp(p);
    await install(deps);
    const c = caches.caches.get(codeCache('b2'));
    expect(c?.paths()).toEqual(['/', '/assets/log-1.js', '/assets/main-2.js', '/icon-192.png']);
    // The art waits until it is used.
    expect(server.asked).not.toContain('/assets/boat-1.glb');
    expect(await (await c?.match('/assets/main-2.js'))?.text()).toBe('served /assets/main-2.js');
  });

  test('a file the previous build kept is copied, not fetched', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/log-1.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b1'), ['/', '/assets/main-1.js', '/assets/log-1.js']);
    await install(deps);
    expect(server.asked).not.toContain('/assets/log-1.js');
    expect(server.asked).toContain('/assets/main-2.js');
    // The page is always this build's, from the server.
    expect(server.asked).toContain('/');
  });

  test('a file missing fails the install, and leaves no cache', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/log-2.js']);
    const { caches, server, deps } = setUp(p);
    server.files.delete('/assets/log-2.js');
    await expect(install(deps)).rejects.toThrow();
    expect(await caches.has(codeCache('b2'))).toBe(false);
  });

  test('a page of another build at / fails the install: a deploy under way', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    server.files.set('/', { body: '<script src="/assets/main-3.js"></script>' });
    await expect(install(deps)).rejects.toThrow(/another build/);
    expect(await caches.has(codeCache('b2'))).toBe(false);
  });

  test('a failed install again keeps the cache it found', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b2'), ['/assets/main-2.js']);
    server.down = true;
    await expect(install(deps)).rejects.toThrow();
    expect(await caches.has(codeCache('b2'))).toBe(true);
  });
});

describe('activating a build', () => {
  test('the previous build’s code is kept, and older builds’ deleted', async () => {
    const p = plan('b3', ['/assets/main-3.js']);
    const { caches, deps } = setUp(p);
    caches.fill(codeCache('b1'), ['/assets/main-1.js']);
    caches.fill(codeCache('b2'), ['/assets/main-2.js']);
    caches.fill('chunks-world-9', ['/w/1/2/3']);
    caches.fill(codeCache('b3'), ['/assets/main-3.js']);
    await activate(deps);
    expect(await caches.keys()).toEqual([
      codeCache('b2'),
      'chunks-world-9',
      codeCache('b3'),
      ART_CACHE,
    ]);
  });

  test('a build back again keeps the build it follows', async () => {
    // b1 rolled back to after b2: b2 is the one pages are running.
    const p = plan('b1', ['/assets/main-1.js']);
    const { caches, deps } = setUp(p);
    caches.fill(codeCache('b0'), ['/assets/main-0.js']);
    caches.fill(codeCache('b1'), ['/assets/main-1.js']);
    caches.fill(codeCache('b2'), ['/assets/main-2.js']);
    await activate(deps);
    expect(await caches.keys()).toEqual([codeCache('b1'), codeCache('b2'), ART_CACHE]);
  });

  test('the art no longer named by the build is dropped', async () => {
    const p = plan('b2', ['/assets/main-2.js'], ['/assets/boat-1.glb', '/assets/look-2.glb']);
    const { caches, deps } = setUp(p);
    caches.fill(ART_CACHE, ['/assets/boat-1.glb', '/assets/look-1.glb', '/assets/look-2.glb']);
    await activate(deps);
    expect(caches.caches.get(ART_CACHE)?.paths()).toEqual([
      '/assets/boat-1.glb',
      '/assets/look-2.glb',
    ]);
  });
});

describe('answering', () => {
  test('a file of this build, from its cache, with no network', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b2'), ['/assets/main-2.js']);
    server.down = true;
    expect(await (await asset(deps, req('/assets/main-2.js'))).text()).toBe(
      'kept /assets/main-2.js',
    );
    expect(server.asked).toEqual([]);
  });

  test('a page of the previous build finds its late files after a deploy', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/log-2.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b1'), ['/assets/main-1.js', '/assets/log-1.js']);
    caches.fill(codeCache('b2'), ['/assets/main-2.js', '/assets/log-2.js']);
    await activate(deps);
    // The server has b2's files only.
    const res = await asset(deps, req('/assets/log-1.js'));
    expect(await res.text()).toBe('kept /assets/log-1.js');
    expect(server.asked).toEqual([]);
  });

  test('a file not kept is fetched, and kept: code with its build, art with the art', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/news-2.js'], ['/assets/look-4.glb']);
    const { caches, deps } = setUp(p);
    caches.fill(codeCache('b2'), []);
    await activate(deps);
    await asset(deps, req('/assets/news-2.js'));
    await asset(deps, req('/assets/look-4.glb'));
    expect(caches.caches.get(codeCache('b2'))?.paths()).toEqual(['/assets/news-2.js']);
    expect(caches.caches.get(ART_CACHE)?.paths()).toEqual(['/assets/look-4.glb']);
  });

  test('a failed answer is passed on, and not kept', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    server.files.set('/assets/gone.js', { body: 'busy', status: 503 });
    expect((await asset(deps, req('/assets/gone.js'))).status).toBe(503);
    expect((await asset(deps, req('/assets/missing.js'))).status).toBe(404);
    expect(caches.caches.get(ART_CACHE)?.paths() ?? []).toEqual([]);
  });

  test('the page from the network while it answers', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b2'), ['/']);
    server.files.set('/', { body: 'fresh page' });
    expect(await (await page(deps, req('/'))).text()).toBe('fresh page');
  });

  test('the kept page when the network fails, or errs, or is slow', async () => {
    let late: () => void = () => {};
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(
      p,
      (ms) =>
        new Promise((resolve) => {
          expect(ms).toBe(3000);
          late = resolve;
        }),
    );
    caches.fill(codeCache('b2'), ['/']);
    server.down = true;
    expect(await (await page(deps, req('/'))).text()).toBe('kept /');
    server.down = false;
    server.files.set('/', { body: 'busy', status: 502 });
    expect(await (await page(deps, req('/'))).text()).toBe('kept /');
    server.files.set('/', { body: 'fresh page' });
    let go: () => void = () => {};
    server.hold = new Promise((resolve) => {
      go = resolve;
    });
    const answered = page(deps, req('/'));
    await Promise.resolve();
    late();
    expect(await (await answered).text()).toBe('kept /');
    go();
  });

  test('with no page kept, the network’s answer however long', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { server, deps } = setUp(p, () => Promise.resolve());
    server.files.set('/', { body: 'slow page' });
    let go: () => void = () => {};
    server.hold = new Promise((resolve) => {
      go = resolve;
    });
    const answered = page(deps, req('/'));
    setTimeout(go, 5);
    expect(await (await answered).text()).toBe('slow page');
  });

  test('an icon: the kept one at once, a fresh one kept for next time', async () => {
    const p = plan('b2', ['/assets/main-2.js']);
    const { caches, server, deps } = setUp(p);
    caches.fill(codeCache('b2'), ['/icon-192.png']);
    server.files.set('/icon-192.png', { body: 'new icon' });
    const later: Promise<unknown>[] = [];
    const res = await top(deps, req('/icon-192.png'), (w) => later.push(w));
    expect(await res.text()).toBe('kept /icon-192.png');
    await Promise.all(later);
    const kept = await caches.caches.get(codeCache('b2'))?.match('/icon-192.png');
    expect(await kept?.text()).toBe('new icon');
  });
});

describe('caches taken away', () => {
  test('are never made again by a worker still answering', async () => {
    const p = plan('b2', ['/assets/main-2.js', '/assets/news-2.js'], ['/assets/look-4.glb']);
    const { caches, server, deps } = setUp(p);
    server.files.set('/', { body: 'fresh page' });
    await asset(deps, req('/assets/news-2.js'));
    await asset(deps, req('/assets/look-4.glb'));
    await top(deps, req('/icon-192.png'), () => {});
    expect(await (await page(deps, req('/'))).text()).toBe('fresh page');
    expect(await caches.keys()).toEqual([]);
  });
});

describe('the off switch', () => {
  test('every cache the worker kept deleted, and the land’s left', async () => {
    const caches = new FakeCaches();
    caches.fill(codeCache('b1'), ['/']);
    caches.fill(codeCache('b2'), ['/']);
    caches.fill(ART_CACHE, ['/assets/a.glb']);
    caches.fill('chunks-world-9', ['/w/1']);
    await clear(caches);
    expect(await caches.keys()).toEqual(['chunks-world-9']);
  });
});
