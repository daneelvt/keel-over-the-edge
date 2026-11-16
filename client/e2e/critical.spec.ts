// SPDX-License-Identifier: AGPL-3.0-only

// The critical download: every byte on the wire from the first request to
// the reveal, for a new player who makes a sailor on the start screen and
// sets sail from Port Royal, on the built page as keel serves it, opened
// at / as a player opens it (no test hooks: the page draws, and its cover
// lifts only once the world under it is ready). The page, its code, fonts,
// models, portraits and the land's chunks; not the game's connection, nor
// the passkey's own requests. It fails over 4 MB.
//
// Counted as Cloudflare sends it: keel compresses nothing, and tools/e2e's
// stand-in for Cloudflare's edge in front of it gzips what Cloudflare
// would (Cloudflare's zstd is a little smaller), so the bytes counted are
// those the browser received. The models and the other binary assets under
// /assets/ are compressed by the zone's Compression Rule
// (infra/tofu/rules.tf), and the table says what they would cost without
// it, as Cloudflare sent them before; and what keel sends, uncompressed.
//
// The network is throttled to DevTools' Fast 4G, or Slow 4G with
// CRITICAL_NETWORK=slow4g, for the times: from the navigation's start to
// the start screen, the taps, and the reveal. CI's runners are not phones:
// the bytes are the check, the times are told. The table goes to the
// job's summary.

import { appendFileSync } from 'node:fs';
import { type BrowserContext, expect, type Request, test } from '@playwright/test';
import { answerBorn, stamp } from './helpers';

/** The critical download's budget, bytes on the wire to the reveal. */
const BUDGET = 4 * 1024 * 1024;

/** DevTools' network presets: latency in ms, throughput in bytes a second. */
const NETWORKS = {
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

interface Response {
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
}

/** What a response is, for the table, by its path and type. */
function kindOf(path: string, type: string): string {
  if (path.startsWith('/w/')) {
    return 'land';
  }
  if (path.startsWith('/api/')) {
    return 'API';
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
function counted(path: string, type: string): boolean {
  return (
    type !== 'websocket' &&
    !path.startsWith('/account/') &&
    !path.startsWith('/signin/') &&
    path !== '/ws'
  );
}

/**
 * A finished request: as the wire carried it, as it would have without the
 * rule, and uncompressed.
 */
async function measure(req: Request, origin: number): Promise<Response | null> {
  const res = await req.response();
  if (res === null) {
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
    start: t.startTime - origin,
    end: t.startTime + t.responseEnd - origin,
  };
}

/** Every request the context makes, kept to be measured once it is over. */
function record(context: BrowserContext): Request[] {
  const finished: Request[] = [];
  context.on('requestfinished', (r) => finished.push(r));
  return finished;
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
const s = (ms: number | null): string => (ms === null ? '–' : `${(ms / 1000).toFixed(2)} s`);

/** What the page marks as it goes, from the navigation's start, ms. */
interface Marks {
  /** The start screen's name field. */
  start: number | null;
  /** Each Set sail tapped: the first makes the sailor, the last sets sail. */
  taps: number[];
  /** The recovery code shown: the sailor made, the passkey's part over. */
  made: number | null;
  /** The cover lifted off the world. */
  reveal: number | null;
}

test('a new sailor’s download to the reveal is under 4 MB on the wire', async ({
  context,
  page,
}) => {
  const network = NETWORKS[(process.env.CRITICAL_NETWORK as keyof typeof NETWORKS) ?? 'fast4g'];
  expect(network, 'CRITICAL_NETWORK is fast4g or slow4g').toBeDefined();
  // The browser's prompt, answered by Playwright: it holds no passkey yet.
  await context.credentials.install();
  // The page's own marks, with no hooks of its own: its start screen's
  // field, the taps, and the cover's lifting, the html element's class
  // "covered" going at the reveal (boot/cover.ts) and nowhere before.
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
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: network.latency,
    downloadThroughput: network.downloadThroughput,
    uploadThroughput: network.uploadThroughput,
  });
  const finished = record(context);

  await page.goto('/');
  const field = page.getByLabel('Your sailor’s name');
  await expect(field).toBeVisible({ timeout: 60_000 });
  const look = (await page.locator('.picker-look-name').textContent()) ?? '';
  await field.fill(`Critical ${stamp()}`);
  await answerBorn(page);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Set sail/ }).click({ timeout: 60_000 });
  await page.waitForFunction(
    () => (globalThis as unknown as { criticalMarks: Marks }).criticalMarks.reveal !== null,
    null,
    { timeout: 90_000 },
  );
  const { marks, origin } = await page.evaluate(() => ({
    marks: (globalThis as unknown as { criticalMarks: Marks }).criticalMarks,
    origin: performance.timeOrigin,
  }));
  // Let the requests that ended before the reveal be told.
  await page.waitForTimeout(1000);

  const all = (await Promise.all(finished.map((r) => measure(r, origin)))).filter(
    (r): r is Response => r !== null,
  );
  const reveal = marks.reveal ?? 0;
  const toReveal = all.filter((r) => r.end <= reveal);
  const toStart = all.filter((r) => r.end <= (marks.start ?? 0));
  const sum = (rs: Response[], k: 'raw' | 'sent' | 'before') => rs.reduce((n, r) => n + r[k], 0);
  const total = sum(toReveal, 'sent');

  const kinds = new Map<string, Response[]>();
  for (const r of toReveal) {
    kinds.set(r.kind, [...(kinds.get(r.kind) ?? []), r]);
  }
  const first = marks.taps[0] ?? 0;
  const last = marks.taps[marks.taps.length - 1] ?? 0;
  const passkey = marks.made === null ? 0 : marks.made - first;
  const lines = [
    `### The critical download, ${network.name}`,
    '',
    `A new sailor (the start screen's look: ${look}) from the first request to the reveal: **${mb(total)}** on the wire as Cloudflare sends it, ${((100 * total) / BUDGET).toFixed(1)}% of 4 MB; ${mb(sum(toReveal, 'before'))} without the Compression Rule; ${mb(sum(toReveal, 'raw'))} as keel sends it. By the start screen: ${mb(sum(toStart, 'sent'))}.`,
    '',
    '| Kind | Responses | As sent | Without the rule | Raw |',
    '|---|---|---|---|---|',
    ...[...kinds]
      .sort((a, b) => sum(b[1], 'sent') - sum(a[1], 'sent'))
      .map(
        ([kind, rs]) =>
          `| ${kind} | ${rs.length} | ${kb(sum(rs, 'sent'))} | ${kb(sum(rs, 'before'))} | ${kb(sum(rs, 'raw'))} |`,
      ),
    `| **All** | ${toReveal.length} | **${kb(total)}** | ${kb(sum(toReveal, 'before'))} | ${kb(sum(toReveal, 'raw'))} |`,
    '',
    `From the navigation's start: the start screen at ${s(marks.start)}, Set sail tapped at ${s(first)}, the sailor made at ${s(marks.made)} (the passkey's part ${s(passkey)}), Set sail to sea at ${s(last)}, the reveal at **${s(marks.reveal)}**; ${s(reveal - last)} from the tap to the reveal, ${s(reveal - passkey)} without the passkey's part.`,
    '',
    '<details><summary>Every response to the reveal</summary>',
    '',
    '| Asked | Ended | Path | As sent | Raw |',
    '|---|---|---|---|---|',
    ...toReveal
      .sort((a, b) => a.end - b.end)
      .map((r) => `| ${s(r.start)} | ${s(r.end)} | ${r.path} | ${kb(r.sent)} | ${kb(r.raw)} |`),
    '',
    '</details>',
    '',
  ];
  const table = `${lines.join('\n')}\n`;
  process.stdout.write(table);
  await test.info().attach('critical download', { body: table, contentType: 'text/markdown' });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, table);
  }

  // The way to sea was the one counted: the world's land fetched, and the
  // page's code with it.
  expect(kinds.get('land')?.length ?? 0, 'land chunks before the reveal').toBeGreaterThan(0);
  expect(kinds.get('scripts')?.length ?? 0).toBeGreaterThan(0);
  expect(total, `the critical download is ${mb(total)}, over 4 MB`).toBeLessThanOrEqual(BUDGET);
});
