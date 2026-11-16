// SPDX-License-Identifier: AGPL-3.0-only

// The service worker switched off (a build with KEEL_SW=off): built to
// /sw.js in place of sw.ts. The browser checks /sw.js at every visit, so
// this one reaches every phone that has the worker: it takes over at once,
// deletes every cache the worker kept, and unregisters itself. It answers
// nothing, so the page comes from the network, and the page built with it
// registers no worker.

import { clear } from './worker';

const scope = self as unknown as ServiceWorkerGlobalScope;

scope.addEventListener('install', () => {
  void scope.skipWaiting();
});

scope.addEventListener('activate', (e) => {
  e.waitUntil(
    clear(scope.caches)
      .then(() => scope.registration.unregister())
      .then(() => undefined),
  );
});
