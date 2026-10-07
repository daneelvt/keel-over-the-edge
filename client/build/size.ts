// SPDX-License-Identifier: AGPL-3.0-only

// The size of the game's first download: what dist/index.html loads before
// the game can start (its scripts, the modules they preload, its styles)
// and the models the scene loads at once, gzipped. Reported against the
// 4 MB critical set; enforced from the phase that readies the game for
// phones.
//
//   node build/size.ts   (after vite build, in client/)

import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** The critical download's budget, in bytes. */
export const BUDGET = 4 * 1024 * 1024;

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

function main(): void {
  const dist = 'dist';
  const files = eagerAssets(readFileSync(join(dist, 'index.html'), 'utf8'));
  // The boats' models load as the scene starts.
  for (const f of readdirSync(join(dist, 'assets'))) {
    if (f.endsWith('.glb')) {
      files.push(`assets/${f}`);
    }
  }
  let total = 0;
  const rows = files.sort().map((f) => {
    const size = gzipSync(readFileSync(join(dist, f)), { level: 9 }).length;
    total += size;
    return `| ${f} | ${(size / 1024).toFixed(1)} KB |`;
  });
  const lines = [
    '### The first download, gzipped',
    '',
    '| File | Size |',
    '|------|------|',
    ...rows,
    `| **Total** | **${(total / 1024).toFixed(1)} KB**, ${((100 * total) / BUDGET).toFixed(1)}% of 4 MB |`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `${lines.join('\n')}\n`);
  }
}

if (process.argv[1]?.endsWith('size.ts')) {
  main();
}
