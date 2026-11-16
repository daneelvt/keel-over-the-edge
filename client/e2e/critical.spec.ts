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
import { expect, test } from '@playwright/test';
import { answerBorn, stamp } from './helpers';
import {
  kb,
  markPage,
  mb,
  measure,
  NETWORKS,
  type Response,
  readMarks,
  record,
  revealed,
  s,
  throttle,
  unreadFiles,
} from './wire';

/** The critical download's budget, bytes on the wire to the reveal. */
const BUDGET = 4 * 1024 * 1024;

test('a new sailor’s download to the reveal is under 4 MB on the wire', async ({
  context,
  page,
}) => {
  const network = NETWORKS[(process.env.CRITICAL_NETWORK as keyof typeof NETWORKS) ?? 'fast4g'];
  expect(network, 'CRITICAL_NETWORK is fast4g or slow4g').toBeDefined();
  // The browser's prompt, answered by Playwright: it holds no passkey yet.
  await context.credentials.install();
  // The page's own marks, with no hooks of its own.
  await markPage(page);
  await throttle(context, page, network);
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
  await revealed(page);
  const { marks, origin } = await readMarks(page);
  // Let the requests that ended before the reveal be told.
  await page.waitForTimeout(1000);

  const all = (await Promise.all(finished.map((r) => measure(r, origin)))).filter(
    (r): r is Response => r !== null,
  );
  expect(unreadFiles(all), 'files whose bytes could not be read').toEqual([]);
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
