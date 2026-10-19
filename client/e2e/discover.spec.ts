// SPDX-License-Identifier: AGPL-3.0-only

// Two players discover seed 1's world together, against keel (tools/e2e):
// each is put by /debug/place off a great island of its own, and charts
// it; each page's chart then holds both, each credited to the player who
// charted it, with the island's model; each player is told of their own
// with a notice; the news has both; the world page lists both by whom; and
// a third player, joining after, is sent the whole chart at once. One back
// end is enough: the drawing is not under test.

import { existsSync, readFileSync } from 'node:fs';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { guest, sail } from './helpers';

const direct = 'http://localhost:5181';
const internal = 'http://127.0.0.1:19090';
const chartFile = new URL('../../.dev/worlds/1.chart', import.meta.url);

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
  test.skip(!existsSync(chartFile), 'no chart for seed 1: run go run ./tools/dev -world 1');
});

interface Entry {
  subject: string;
  number: number;
  name: string;
  north: number;
  worth: number;
  bounds: number[] | null;
}

/**
 * Two great islands of seed 1 far apart, not yet charted: not known from
 * the start, and not sighted by a boat of another test.
 */
function islands(charted: Set<string>): [Entry, Entry] {
  const c = JSON.parse(readFileSync(chartFile, 'utf8')) as { entries: Entry[]; known: number[] };
  const great = c.entries
    .filter(
      (e, i) =>
        e.subject === 'island' &&
        e.worth >= 20 &&
        !c.known.includes(i) &&
        e.bounds !== null &&
        !charted.has(`island:${e.number}`),
    )
    .sort((a, b) => (a.bounds?.[2] ?? 0) - (b.bounds?.[2] ?? 0));
  const a = great[0];
  const b = great[great.length - 1];
  if (a === undefined || b === undefined || a === b) {
    throw new Error('seed 1 has not two great islands left to chart');
  }
  return [a, b];
}

/** A player sailing in a small page of its own. */
async function player(browser: import('@playwright/test').Browser, name: string) {
  const c = await browser.newContext({ baseURL: direct, viewport: { width: 320, height: 200 } });
  await guest(c, name);
  const p = await c.newPage();
  await sail(p, direct);
  const me = (await (await c.request.get('/api/me')).json()) as { name: string };
  return { context: c, page: p, name: me.name };
}

/** Puts a page's boat off an island's east coast, within sight of it. */
async function off(page: Page, isle: Entry): Promise<void> {
  const boat = await page.evaluate(() => globalThis.keel.net().boat);
  const east = (isle.bounds?.[2] ?? 0) + 120;
  const res = await page.request.post(
    `${internal}/debug/place?east=${east}&north=${isle.north}&heading=270&boat=${boat}`,
  );
  expect(res.status(), await res.text()).toBe(200);
}

test('two players discover a world: the chart fills in for both, with the credit for each place', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const before = (
    await (await browser.newContext()).request.get(`${internal}/owner/api/charted.json`)
  ).json() as Promise<{
    charted: { subject: string; number: number }[];
  }>;
  const [isleA, isleB] = islands(
    new Set((await before).charted.map((c) => `${c.subject}:${c.number}`)),
  );
  const ann = await player(browser, 'Ann');
  const bob = await player(browser, 'Bob');
  const contexts: BrowserContext[] = [ann.context, bob.context];
  // Port Royal's island is known from the start, to everyone.
  for (const p of [ann.page, bob.page]) {
    await expect
      .poll(() => p.evaluate(() => globalThis.keel.chartInfo().credits))
      .toContainEqual(['Port Royal', '']);
  }
  await off(ann.page, isleA);
  await off(bob.page, isleB);
  const credits = (p: Page) => p.evaluate(() => globalThis.keel.chartInfo().credits);
  for (const p of [ann.page, bob.page]) {
    await expect.poll(() => credits(p), { timeout: 30_000 }).toContainEqual([isleA.name, ann.name]);
    await expect.poll(() => credits(p), { timeout: 30_000 }).toContainEqual([isleB.name, bob.name]);
  }
  // Each was told of their own.
  // Each was told of their own: the first, and the rest folded in.
  for (const p of [ann.page, bob.page]) {
    const shown = await p.evaluate(() => globalThis.keel.noticesShown());
    expect(shown.some((t) => t.startsWith('You charted'))).toBe(true);
  }
  // The islands' models, on the chart.
  await ann.page.evaluate(() => globalThis.keel.openChart('chart'));
  await expect
    .poll(
      async () => {
        await ann.page.evaluate(() => globalThis.keel.render());
        return ann.page.evaluate(() => globalThis.keel.chartInfo().models);
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(3);
  // The news, and the world page.
  const news = (await (await ann.context.request.get('/api/news')).json()) as {
    items: { title: string; by: string }[];
  };
  expect(news.items).toContainEqual(expect.objectContaining({ title: isleA.name, by: ann.name }));
  expect(news.items).toContainEqual(expect.objectContaining({ title: isleB.name, by: bob.name }));
  const owner = (await (
    await ann.page.request.get(`${internal}/owner/api/charted.json`)
  ).json()) as {
    charted: { subject: string; by: string }[];
  };
  expect(
    owner.charted.filter((c) => c.by === ann.name || c.by === bob.name).length,
  ).toBeGreaterThanOrEqual(2);
  // A third, joining after, is sent the whole chart at once.
  const carol = await player(browser, 'Carol');
  contexts.push(carol.context);
  await expect
    .poll(() => credits(carol.page), { timeout: 10_000 })
    .toEqual(
      expect.arrayContaining([
        [isleA.name, ann.name],
        [isleB.name, bob.name],
      ]),
    );
  for (const c of contexts) {
    await c.close();
  }
});
