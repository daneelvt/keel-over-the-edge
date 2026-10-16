// SPDX-License-Identifier: AGPL-3.0-only

// The mesh worker: the land's chunks fetched, kept, unpacked and built into
// meshes off the page's thread, so a chunk arriving never costs a frame.
// The page sends it ToMesh records and gets FromMesh records back, with
// their buffers transferred, not copied.

import { type FromMesh, MeshWorker, type ToMesh } from './mesh';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const worker = new MeshWorker({
  fetch: (path) => fetch(path, { credentials: 'omit' }),
  caches: typeof caches === 'undefined' ? null : caches,
  post: (m: FromMesh, transfer: Transferable[]) => scope.postMessage(m, transfer),
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => scope.setTimeout(resolve, ms)),
});

scope.onmessage = (ev: MessageEvent<ToMesh>) => {
  // Only the page that started the worker posts to it (as the net worker).
  if (ev.origin !== '' && ev.origin !== scope.location.origin) {
    return;
  }
  void worker.handle(ev.data);
};
