// SPDX-License-Identifier: AGPL-3.0-only

// The net worker: the game connection, off the page's thread, so the times
// messages arrive are not blurred by long frames, and the page's frames are
// not held up by the socket. The page sends it ToWorker records; it sends
// back FromWorker records, snapshots as transferred buffers.

import { nowUs } from '../../net/clock';
import type { FromWorker, ToWorker } from '../../net/messages';
import { NetWorker } from './net';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const net = new NetWorker({
  socket: (url) => new WebSocket(url),
  post: (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer ?? []),
  me: async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
      return res.status;
    } catch {
      return 0;
    }
  },
  now: nowUs,
  setTimeout: (f, ms) => scope.setTimeout(f, ms),
  clearTimeout: (id) => scope.clearTimeout(id),
  random: Math.random,
});

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  // Only the page that started a dedicated worker can post to it, through
  // the worker's own port, whose messages carry an empty origin (HTML
  // Standard, "message port post message steps"). Anything else is not the
  // page's, and is ignored.
  if (ev.origin !== '' && ev.origin !== scope.location.origin) {
    return;
  }
  net.handle(ev.data);
};
