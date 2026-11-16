// SPDX-License-Identifier: AGPL-3.0-only

// The service worker, built to /sw.js with its build's id and file lists
// written in (build/sw.ts). It keeps the game on the phone and answers the
// game's page and files from there (worker.ts says what and how). A new
// build's worker takes over at once; the page asks it to (a message
// "take-over") when the server says the page is out of date.

import { activate, asset, type Deps, install, page, route, top } from './worker';

declare const __SW_BUILD__: string;
declare const __SW_CODE__: readonly string[];
declare const __SW_ART__: readonly string[];
declare const __SW_ENTRY__: string;

const scope = self as unknown as ServiceWorkerGlobalScope;

const deps: Deps = {
  plan: { build: __SW_BUILD__, code: __SW_CODE__, art: __SW_ART__, entry: __SW_ENTRY__ },
  caches: scope.caches,
  fetch: (request, init) => scope.fetch(request, init),
  origin: scope.location.origin,
  wait: (ms) => new Promise((resolve) => scope.setTimeout(resolve, ms)),
};

scope.addEventListener('install', (e) => {
  e.waitUntil(install(deps).then(() => scope.skipWaiting()));
});

scope.addEventListener('activate', (e) => {
  e.waitUntil(activate(deps).then(() => scope.clients.claim()));
});

scope.addEventListener('message', (e) => {
  if (e.origin !== '' && e.origin !== scope.location.origin) {
    return;
  }
  if ((e.data as { type?: unknown } | null)?.type === 'take-over') {
    void scope.skipWaiting();
  }
});

scope.addEventListener('fetch', (e) => {
  const r = e.request;
  const answer = route(
    { url: r.url, method: r.method, mode: r.mode, range: r.headers.get('range') },
    scope.location.origin,
  );
  if (answer === 'network') {
    // Not the worker's: the browser fetches it as if there were no worker.
    return;
  }
  const answered =
    answer === 'page'
      ? page(deps, r)
      : answer === 'asset'
        ? asset(deps, r)
        : top(deps, r, (p) => e.waitUntil(p));
  // A fault in the worker's own keeping never stands between the page and
  // its file.
  e.respondWith(answered.catch(() => scope.fetch(r)));
});
