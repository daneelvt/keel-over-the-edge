// SPDX-License-Identifier: AGPL-3.0-only

// The service worker's logic: what it answers and how, and what it keeps.
// sw.ts wires it to the worker's events; the tests give it a fake
// CacheStorage and fetch.
//
// It answers only what it knows (an allow-list): the game's page at /, its
// files under /assets/, and its icons and manifest. Everything else goes to
// the network untouched: the API, the game connection, sign-in, the
// world's chunks (the mesh worker keeps its own), the other pages, and a
// skipper's link (?s=), which must come from the server with its own
// headers.
//
// It keeps the game's code (every script, worker, WebAssembly, style sheet
// and font the page can reach, lazy ones too) in a cache named by the
// build, filled when it installs; and the art (models, portraits, images,
// sounds) in one art cache as it is used. A new build's worker takes over
// at once and keeps the previous build's code, so a page still running the
// previous build finds every file it loads late; older builds' code is
// deleted, and the art no build of the two names.

/** What the build tells the worker: written in by the build (build/sw.ts). */
export interface Plan {
  /** The build's id; its code cache is named by it. */
  build: string;
  /** The game's code, and the page and its icons, by path: kept at install. */
  code: readonly string[];
  /** The build's art, by path: kept in the art cache once used. */
  art: readonly string[];
  /** The page's entry script's path: the page at / must name it to be this build's. */
  entry: string;
}

/** The prefix of every cache the worker keeps; the land's chunks have their own. */
export const PREFIX = 'keel-';
/** The prefix of the code caches, one a build: keel-code-<build>. */
export const CODE_PREFIX = `${PREFIX}code-`;
/** The art cache, for every build. */
export const ART_CACHE = `${PREFIX}art`;

/** How long a page waits on the network before the kept page is shown, ms. */
export const SHELL_WAIT = 3000;
/** How many files the worker fetches at once at install. */
const AT_ONCE = 4;

/** The icons and the manifest: kept, and refreshed after each answer. */
export const TOP = new Set([
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
]);

/** A skipper's link to come aboard: never answered from the kept page. */
const SAIL_PARAM = 's';

/** How a request is answered. */
export type Answer = 'page' | 'asset' | 'top' | 'network';

/** The parts of a request the worker reads. */
export interface Asked {
  url: string;
  method: string;
  mode: string;
  /** The Range header, if any. */
  range: string | null;
}

/** How the worker answers what is asked, from the worker's origin. */
export function route(asked: Asked, origin: string): Answer {
  if (asked.method !== 'GET') {
    return 'network';
  }
  const url = new URL(asked.url);
  if (url.origin !== origin) {
    return 'network';
  }
  if (asked.mode === 'navigate') {
    return url.pathname === '/' && !url.searchParams.has(SAIL_PARAM) ? 'page' : 'network';
  }
  if (url.pathname.startsWith('/assets/')) {
    // A part of a file (a sound or a film seeking) goes to the server,
    // which answers ranges.
    return asked.range === null ? 'asset' : 'network';
  }
  return TOP.has(url.pathname) ? 'top' : 'network';
}

/** The part of a cache the worker uses. */
export interface Store {
  match(request: RequestInfo): Promise<Response | undefined>;
  put(request: RequestInfo, response: Response): Promise<void>;
  keys(): Promise<readonly Request[]>;
  delete(request: RequestInfo): Promise<boolean>;
}

/** The part of CacheStorage the worker uses; keys in the order the caches were made. */
export interface Stores {
  open(name: string): Promise<Store>;
  has(name: string): Promise<boolean>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/** What the worker works with. */
export interface Deps {
  plan: Plan;
  caches: Stores;
  fetch: (request: RequestInfo, init?: RequestInit) => Promise<Response>;
  /** The worker's origin. */
  origin: string;
  /** Waits ms, then resolves. */
  wait: (ms: number) => Promise<void>;
}

/** The name of a build's code cache. */
export function codeCache(build: string): string {
  return CODE_PREFIX + build;
}

/** A response worth keeping: the whole file, from this origin. */
function keepable(res: Response): boolean {
  return res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

/** The path of a request or URL. */
function pathOf(request: RequestInfo, origin: string): string {
  return new URL(typeof request === 'string' ? request : request.url, origin).pathname;
}

/** The worker's caches, in the order they were made: the code caches, then the art's. */
async function ours(c: Stores): Promise<string[]> {
  const names = await c.keys();
  return [
    ...names.filter((n) => n.startsWith(CODE_PREFIX)),
    ...names.filter((n) => n === ART_CACHE),
  ];
}

/** A kept answer to request: this build's code first, then the previous build's, then the art. */
async function kept(d: Deps, request: RequestInfo): Promise<Response | undefined> {
  const current = codeCache(d.plan.build);
  const names = await ours(d.caches);
  const order = [current, ...names.filter((n) => n !== current)];
  for (const name of order) {
    if (!names.includes(name)) {
      continue;
    }
    const hit = await (await d.caches.open(name)).match(request);
    if (hit !== undefined) {
      return hit;
    }
  }
  return undefined;
}

/**
 * The game's page: from the network, unless it takes longer than
 * SHELL_WAIT or fails, then the page this build kept. A server error
 * (a deploy's moment, the edge's error page) is answered with the kept
 * page too, which shows "Back soon" itself until the server is back.
 */
export async function page(d: Deps, request: Request): Promise<Response> {
  const store = await d.caches.open(codeCache(d.plan.build));
  const net = d.fetch(request);
  const late = d.wait(SHELL_WAIT).then(() => 'late' as const);
  const first = await Promise.race([
    net.then(
      (r) => r,
      () => 'failed' as const,
    ),
    late,
  ]);
  if (first !== 'late' && first !== 'failed' && first.status < 500) {
    return first;
  }
  const shell = await store.match('/');
  if (shell !== undefined) {
    return shell;
  }
  // Nothing kept: the network's answer, however long it takes.
  return net;
}

/** One of the game's files: kept, or fetched and kept, the code in its build's cache and the art in the art's. */
export async function asset(d: Deps, request: Request): Promise<Response> {
  const hit = await kept(d, request);
  if (hit !== undefined) {
    return hit;
  }
  const res = await d.fetch(request);
  if (keepable(res)) {
    const name = d.plan.code.includes(pathOf(request, d.origin))
      ? codeCache(d.plan.build)
      : ART_CACHE;
    const copy = res.clone();
    try {
      await (await d.caches.open(name)).put(request, copy);
    } catch {
      // Storage full or refused: answered all the same.
    }
  }
  return res;
}

/**
 * An icon or the manifest: the kept copy at once, and a fresh one fetched
 * for next time (stale while revalidate). later is given the fetch to wait on.
 */
export async function top(
  d: Deps,
  request: Request,
  later: (p: Promise<unknown>) => void,
): Promise<Response> {
  const hit = await kept(d, request);
  const store = await d.caches.open(codeCache(d.plan.build));
  const fresh = d.fetch(request).then(async (res) => {
    if (keepable(res)) {
      await store.put(request, res.clone());
    }
    return res;
  });
  if (hit !== undefined) {
    later(fresh.catch(() => {}));
    return hit;
  }
  return fresh;
}

/** Runs each of items through work, a few at once. */
async function each<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, lane));
}

/**
 * Installs the build: its code cache filled with every file of its list.
 * A file the previous build kept under the same name (hashed names change
 * only with their content) is copied, not fetched; the rest are fetched at
 * low priority, from the browser's own cache where the page loaded them.
 * The page at / must be this build's (it names this build's entry), or a
 * deploy is under way and the install fails, to be tried again at the next
 * visit. A failed install leaves no cache of its own behind.
 */
export async function install(d: Deps): Promise<void> {
  const name = codeCache(d.plan.build);
  const had = await d.caches.has(name);
  const store = await d.caches.open(name);
  try {
    await each(d.plan.code, async (path) => {
      if ((await store.match(path)) !== undefined) {
        return;
      }
      if (path.startsWith('/assets/')) {
        const before = await kept(d, path);
        if (before !== undefined) {
          await store.put(path, before);
          return;
        }
      }
      const res = await d.fetch(path, {
        priority: 'low',
        cache: path === '/' || TOP.has(path) ? 'no-cache' : 'default',
      });
      if (!keepable(res)) {
        throw new Error(`${path}: ${res.status}`);
      }
      if (path === '/') {
        const body = await res.text();
        if (!body.includes(d.plan.entry)) {
          throw new Error('the page at / is another build');
        }
        await store.put(
          path,
          new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
        );
        return;
      }
      await store.put(path, res);
    });
  } catch (err) {
    if (!had) {
      await d.caches.delete(name);
    }
    throw err;
  }
}

/**
 * Activates the build: its code cache and the previous build's (the one
 * made last before it) are kept, every older one deleted; the art cache
 * keeps only what this build names.
 */
export async function activate(d: Deps): Promise<void> {
  const current = codeCache(d.plan.build);
  const names = await d.caches.keys();
  const others = names.filter((n) => n.startsWith(CODE_PREFIX) && n !== current);
  const previous = others[others.length - 1];
  for (const n of others) {
    if (n !== previous) {
      await d.caches.delete(n);
    }
  }
  if (!names.includes(ART_CACHE)) {
    return;
  }
  const named = new Set([...d.plan.code, ...d.plan.art]);
  const art = await d.caches.open(ART_CACHE);
  for (const req of await art.keys()) {
    if (!named.has(pathOf(req, d.origin))) {
      await art.delete(req);
    }
  }
}

/** Every cache the worker keeps deleted: the off switch. */
export async function clear(c: Pick<Stores, 'keys' | 'delete'>): Promise<void> {
  for (const n of await c.keys()) {
    if (n.startsWith(PREFIX)) {
      await c.delete(n);
    }
  }
}
