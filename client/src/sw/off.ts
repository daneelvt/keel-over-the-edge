// SPDX-License-Identifier: AGPL-3.0-only

// The service worker switched off (a build with KEEL_SW=off): built to
// /sw.js in place of sw.ts. The browser checks /sw.js at every visit, so
// this one reaches every phone that has the worker: it takes over at once,
// every page with it, deletes every cache the worker kept, and unregisters
// itself. It answers nothing, so the page comes from the network, and the
// page built with it registers no worker.

import { clear, SETTLE } from './worker';

const scope = self as unknown as ServiceWorkerGlobalScope;

scope.addEventListener('install', () => {
  void scope.skipWaiting();
});

scope.addEventListener('activate', (e) => {
  // Every page taken over first, so the worker before answers nothing
  // more; its caches deleted, and again once what it was answering when
  // taken over is done, in case it kept a file as they went.
  e.waitUntil(
    scope.clients
      .claim()
      .then(() => clear(scope.caches))
      .then(() => new Promise((resolve) => scope.setTimeout(resolve, SETTLE)))
      .then(() => clear(scope.caches))
      .then(() => scope.registration.unregister())
      .then(() => undefined),
  );
});
