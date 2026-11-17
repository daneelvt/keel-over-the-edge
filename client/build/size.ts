// SPDX-License-Identifier: AGPL-3.0-only

// The sizes of the game's parts loaded apart from its first download,
// gzipped, against their budgets: the approval page, which AI apps open,
// often on a phone's data: its page, script and styles, held under 30 KB;
// the log's chunk, loaded when the log is first opened, held under 60 KB;
// and the news sheet's, loaded when the news is first opened, held under
// 20 KB. And a sailor's files' budgets, which build/size.test.ts holds the
// art to. The first download itself, every byte on the wire to the reveal,
// is counted by a browser test of the built page (e2e/critical.spec.ts).
//
//   node build/size.ts   (after vite build, in client/)

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * A sailor's files' budgets, gzipped, in bytes, a look and version: its deck
 * and far levels together (they load together, when a boat with the look
 * first comes into view), its close level (when the camera comes near the
 * boat in view), its clips (when a boat with it first comes near), and its
 * clips at a wheel with them on a boat steered by one; and what
 * the first download carries of sailors: one look's deck, far and clips,
 * the player's own. And its portraits, as files (images
 * gain nothing by gzip): the colour portrait's base (AVIF) and mask
 * together, every look and version's together, and the inked portrait.
 */
export const SAILOR_BUDGETS = {
  deckFar: 150 * 1024,
  close: 300 * 1024,
  clips: 150 * 1024,
  /** Its clips at a wheel: a file of their own, loaded with the clips for a boat steered by one. */
  wheel: 50 * 1024,
  /** A person's look's deck, far and clips together: the player's own, the first download's. */
  critical: 280 * 1024,
  /** The texture transcoder, which loads with the first sailor. */
  transcoder: 270 * 1024,
  portrait: 14 * 1024,
  portraits: 200 * 1024,
  ink: 40 * 1024,
};

/** The log's budget, in bytes gzipped: its script and styles, loaded when the log is first opened. */
export const LOG_BUDGET = 60 * 1024;

/** Whether a built asset is the log's own chunk, its script or its styles. */
export function logAsset(name: string): boolean {
  return /^log-[\w-]+\.(js|css)$/.test(name);
}

/** The news sheet's budget, in bytes gzipped: its script and styles, loaded when the news is first opened. */
export const NEWS_BUDGET = 20 * 1024;

/** Whether a built asset is the news sheet's own chunk, its script or its styles. */
export function newsAsset(name: string): boolean {
  return /^news-[\w-]+\.(js|css)$/.test(name);
}

/** The approval page's budget, in bytes: the page with what it loads before it runs. */
export const APPROVE_BUDGET = 30 * 1024;

/** The assets an HTML page loads before it runs: scripts, preloaded modules and styles. */
export function eagerAssets(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    out.add(m[1] as string);
  }
  for (const m of html.matchAll(
    /<link[^>]*\srel="(?:modulepreload|stylesheet)"[^>]*\shref="([^"]+)"/g,
  )) {
    out.add(m[1] as string);
  }
  return [...out].map((p) => p.replace(/^\//, ''));
}

const gzipped = (file: string): number => gzipSync(readFileSync(file), { level: 9 }).length;

function main(): void {
  const dist = 'dist';
  const assets = readdirSync(join(dist, 'assets'));
  const lines: string[] = ['### The parts loaded apart', ''];
  const approveHtml = join(dist, 'approve.html');
  const approve = [
    gzipped(approveHtml),
    ...eagerAssets(readFileSync(approveHtml, 'utf8')).map((f) => gzipped(join(dist, f))),
  ].reduce((a, b) => a + b, 0);
  lines.push(
    `The approval page, gzipped: **${(approve / 1024).toFixed(1)} KB** of ${APPROVE_BUDGET / 1024} KB.`,
    '',
  );
  const log = assets.filter(logAsset).reduce((n, f) => n + gzipped(join(dist, 'assets', f)), 0);
  lines.push(
    `The log, when first opened, gzipped: **${(log / 1024).toFixed(1)} KB** of ${LOG_BUDGET / 1024} KB.`,
    '',
  );
  const news = assets.filter(newsAsset).reduce((n, f) => n + gzipped(join(dist, 'assets', f)), 0);
  lines.push(
    `The news sheet, when first opened, gzipped: **${(news / 1024).toFixed(1)} KB** of ${NEWS_BUDGET / 1024} KB.`,
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `${lines.join('\n')}\n`);
  }
  if (log === 0 || log > LOG_BUDGET) {
    process.stderr.write('size: the log is not its own chunk, or is over its budget\n');
    process.exitCode = 1;
  }
  if (news === 0 || news > NEWS_BUDGET) {
    process.stderr.write('size: the news sheet is not its own chunk, or is over its budget\n');
    process.exitCode = 1;
  }
  if (approve > APPROVE_BUDGET) {
    process.stderr.write('size: the approval page is over its budget\n');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('size.ts')) {
  main();
}
