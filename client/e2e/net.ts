// SPDX-License-Identifier: AGPL-3.0-only

// A page that runs only the net worker, for the browser tests of the
// upgrade from a worker: the cookie and the Origin it carries, on Chromium
// and WebKit. Nothing is drawn.

import { CATALOG_VERSION } from '../src/catalog';
import type { FromWorker } from '../src/net/messages';
import { LAYOUT_VERSION } from '../src/predict/layout.gen';

const result = document.getElementById('result') as HTMLElement;
const seen: string[] = [];
const worker = new Worker(new URL('../src/workers/net/worker.ts', import.meta.url), {
  type: 'module',
});
worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  if (m.type === 'welcome') {
    seen.push(`welcome ${m.boat}`);
  } else if (m.type === 'snapshot' && !seen.includes('snapshot')) {
    seen.push('snapshot');
  } else if (m.type === 'status') {
    seen.push(m.status);
  }
  result.textContent = seen.join(', ');
};
worker.postMessage({
  type: 'start',
  url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  versions: { catalog: CATALOG_VERSION, physicsLayout: LAYOUT_VERSION, build: 'net.html' },
});
