// SPDX-License-Identifier: AGPL-3.0-only

// The bytes a built page's load takes on the wire, and the page's own
// marks as it goes, for the tests of the built page (critical.spec.ts,
// kept.spec.ts): every request the context makes, the service worker's
// too, measured as Cloudflare sends it; the start screen, the taps on Set
// sail, and the reveal, the html element's class "covered" going
// (boot/cover.ts) and nowhere before.

import type { BrowserContext, Page, Request } from '@playwright/test';

/** DevTools' network presets: latency in ms, throughput in bytes a second. */
export const NETWORKS = {
  fast4g: {
    name: 'Fast 4G',
    latency: 165,
    downloadThroughput: (9_000_000 / 8) * 0.9,
    uploadThroughput: (1_500_000 / 8) * 0.9,
  },
  slow4g: {
    name: 'Slow 4G',
    latency: 562.5,
    downloadThroughput: (1_600_000 / 8) * 0.9,
    uploadThroughput: (750_000 / 8) * 0.9,
  },
} as const;

/** What the zone's Compression Rule adds: these types, under /assets/. */
const RULE_COMPRESSES = new Set(['model/gltf-binary', 'application/octet-stream']);

export interface Response {
  path: string;
  kind: string;
  /** Bytes as keel sent them, uncompressed: headers and body. */
  raw: number;
  /** As Cloudflare sends it with the rule, and as it did without. */
  sent: number;
  before: number;
  /** When it was asked for and when it ended, ms from the navigation's start. */
  start: number;
  end: number;
  /** Whether it could not be read in time, its bytes unknown (and 0 here). */
  unread?: true;
}

/** How long a finished request's reading may take. */
const READ_WITHIN = 10_000;

/**
 * The counted files (the build's assets and the land's chunks) whose bytes
 * could not be read: a tally with any is short.
 */
export function unreadFiles(all: readonly Response[]): string[] {
  return all
    .filter((r) => r.unread && (r.path.startsWith('/assets/') || r.path.startsWith('/w/')))
    .map((r) => r.path);
}

/** What a response is, for the table, by its path and type. */
export function kindOf(path: string, type: string): string {
  if (path.startsWith('/w/')) {
    return 'land';
  }
  if (path.startsWith('/api/')) {
    return 'API';
  }
  // The human check's script and its token, tools/e2e's stand-in for
  // Cloudflare Turnstile's on the page's own origin.
  if (path.startsWith('/turnstile/')) {
    return 'human check';
  }
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1] ?? '';
  if (type === 'text/html') {
    return 'page';
  }
  const kinds: Record<string, string> = {
    js: 'scripts',
    css: 'styles',
    wasm: 'WebAssembly',
    woff2: 'fonts',
    woff: 'fonts',
    glb: 'models',
    bin: 'sky and terrain',
    terrain: 'sky and terrain',
    avif: 'pictures',
    webp: 'pictures',
    png: 'pictures',
    svg: 'pictures',
    webmanifest: 'manifest',
    m4a: 'sounds',
    webm: 'sounds',
    ogg: 'sounds',
  };
  return kinds[ext] ?? 'other';
}

/** The passkey's own requests and the game's connection: not counted. */
export function counted(path: string, type: string): boolean {
  return (
    type !== 'websocket' &&
    !path.startsWith('/account/') &&
    !path.startsWith('/signin/') &&
    path !== '/ws'
  );
}

/**
 * A finished request: as the wire carried it, as it would have without the
 * rule, and uncompressed; its times from the navigation's start.
 */
export async function measure(
  taken: Promise<Response | null>,
  origin: number,
): Promise<Response | null> {
  const r = await taken;
  return r === null ? null : { ...r, start: r.start - origin, end: r.end - origin };
}

/**
 * A request read as it finishes, its times from the clock's zero: a
 * service worker's request can be read only while the worker runs, and
 * the browser stops an idle worker soon after. Even so a worker's request
 * may never answer (its own script's, seen on CI): after a while it is
 * told as unread rather than awaited for ever.
 */
async function take(req: Request): Promise<Response | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      const t = req.timing();
      const path = new URL(req.url()).pathname;
      resolve({
        path,
        kind: 'unread',
        raw: 0,
        sent: 0,
        before: 0,
        start: t.startTime,
        end: t.startTime,
        unread: true,
      });
    }, READ_WITHIN);
  });
  try {
    return await Promise.race([read(req), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function read(req: Request): Promise<Response | null> {
  const res = await req.response();
  // A page's request the service worker answered: what it fetched from the
  // network, if anything, is the worker's own request, counted as such.
  if (res === null || res.fromServiceWorker()) {
    return null;
  }
  const url = new URL(req.url());
  // A blob or data URL is the page's own, made in memory.
  if (!url.protocol.startsWith('http') || !counted(url.pathname, req.resourceType())) {
    return null;
  }
  const sizes = await req.sizes();
  const headers = await res.allHeaders();
  const type = (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const sent = sizes.responseHeadersSize + sizes.responseBodySize;
  const encoded = (headers['content-encoding'] ?? '') !== '';
  const raw = encoded ? sizes.responseHeadersSize + (await res.body().then((b) => b.length)) : sent;
  const byRule = encoded && RULE_COMPRESSES.has(type) && url.pathname.startsWith('/assets/');
  const before = byRule ? raw : sent;
  const t = req.timing();
  return {
    path: url.pathname,
    kind: kindOf(url.pathname, type),
    raw,
    sent,
    before,
    start: t.startTime,
    end: t.startTime + t.responseEnd,
  };
}

/** Every request the context makes, read as it finishes, to be measured. */
export function record(context: BrowserContext): Promise<Response | null>[] {
  const finished: Promise<Response | null>[] = [];
  context.on('requestfinished', (r) => {
    const taken = take(r);
    // A tally that drops it is no failure; one that awaits it still fails.
    taken.catch(() => {});
    finished.push(taken);
  });
  return finished;
}

export const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
export const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
export const s = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(2)} s`);

/** What the page marks as it goes, from the navigation's start, ms. */
export interface Marks {
  /** The start screen's name field. */
  start: number | null;
  /** Each Set sail tapped: the first makes the sailor, the last sets sail. */
  taps: number[];
  /** The recovery code shown: the sailor made, the passkey's part over. */
  made: number | null;
  /** The cover lifted off the world. */
  reveal: number | null;
}

/**
 * Marks the page's start screen, its taps on Set sail and its reveal, at
 * every load, with no hooks of its own.
 */
export async function markPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const marks: Marks = { start: null, taps: [], made: null, reveal: null };
    Object.assign(globalThis, { criticalMarks: marks });
    const look = () => {
      const now = performance.now();
      if (marks.start === null && document.getElementById('start-name') !== null) {
        marks.start = now;
      }
      if (marks.made === null && document.querySelector('.recovery-code') !== null) {
        marks.made = now;
      }
      if (
        marks.reveal === null &&
        marks.taps.length > 0 &&
        !document.documentElement.classList.contains('covered')
      ) {
        marks.reveal = now;
      }
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    document.addEventListener(
      'click',
      (e) => {
        const b = (e.target as Element | null)?.closest?.('button');
        if (b && /^Set sail/.test(b.textContent ?? '')) {
          marks.taps.push(performance.now());
        }
      },
      true,
    );
  });
}

/** Waits for the page's reveal after a Set sail tapped. */
export async function revealed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (globalThis as unknown as { criticalMarks: Marks }).criticalMarks.reveal !== null,
    null,
    { timeout: 90_000 },
  );
}

/** The page's marks, and its navigation's start (ms since the epoch). */
export function readMarks(page: Page): Promise<{ marks: Marks; origin: number }> {
  return page.evaluate(() => ({
    marks: (globalThis as unknown as { criticalMarks: Marks }).criticalMarks,
    origin: performance.timeOrigin,
  }));
}

/** Throttles the page's network to a DevTools preset. */
export async function throttle(
  context: BrowserContext,
  page: Page,
  network: (typeof NETWORKS)[keyof typeof NETWORKS],
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: network.latency,
    downloadThroughput: network.downloadThroughput,
    uploadThroughput: network.uploadThroughput,
  });
}
