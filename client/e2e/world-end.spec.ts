// SPDX-License-Identifier: AGPL-3.0-only

// A world's end, against keel (tools/e2e), its end brought near by the
// developer's command: two players sail; the countdown counts on both; the
// closing's notice and the news's Notices to Mariners come; at the end the
// falls take the world on both pages at the same world time, and both are
// welcomed into the new world, its chart blank but for what is known from
// its start; one's charting is the other's. Then a world's end missed while
// keel is down is switched as it starts again. Both end the shared world,
// so the spec's name sorts it after the others that sail it.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { sailor as newSailor, sail } from './helpers';

const internal = 'http://127.0.0.1:19090';
const control = 'http://127.0.0.1:19099';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the world’s life: one back end is enough');
});

type Ending = {
  world: string;
  ends: number;
  now: number;
  falls: string;
  stage: { sound: number; mist: number; cut: number; veil: number };
};

const ending = (p: Page): Promise<Ending> => p.evaluate(() => globalThis.keel.ending());

/** Brings the world's end near: in seconds from now. */
async function endIn(page: Page, seconds: number): Promise<number> {
  const res = await page.request.post(`${internal}/debug/end?in=${seconds}s`);
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { ends: number }).ends;
}

/** A player sailing in a context of its own, its page small for CI's renderer. */
async function sailor(browser: import('@playwright/test').Browser, name: string) {
  const c: BrowserContext = await browser.newContext({
    baseURL: 'http://localhost:5181',
    viewport: { width: 320, height: 200 },
  });
  await newSailor(c, name);
  const p = await c.newPage();
  await sail(p);
  return { c, p };
}

test('@long a world ends on stage, and a new one begins with a blank chart', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const opener = await browser.newPage();
  const ends = await endIn(opener, 75);
  await opener.close();
  const ann = await sailor(browser, 'Ann');
  const bob = await sailor(browser, 'Bob');
  const before = await ending(ann.p);
  expect(before.ends).toBe(ends);
  expect((await ending(bob.p)).world).toBe(before.world);

  // The countdown, on both, by the world clock.
  await expect.poll(async () => (await ending(ann.p)).falls).toMatch(/^Falls in \d/);
  await expect.poll(async () => (await ending(bob.p)).falls).toMatch(/^Falls in \d/);
  // The world is in its last days at once: the closing's notice, once.
  await expect
    .poll(() => ann.p.evaluate(() => globalThis.keel.noticesShown()), { timeout: 15_000 })
    .toContainEqual(expect.stringMatching(/^The falls take this world on /));
  // The news tells of the end.
  await expect
    .poll(
      async () => {
        const res = await request.get('http://localhost:5181/api/news');
        const page = (await res.json()) as { items: { subject: string; endsAt?: number }[] };
        return page.items.filter((it) => it.subject === 'world').map((it) => it.endsAt);
      },
      { timeout: 30_000 },
    )
    .toContain(ends);

  // Ten seconds before: the near sea breaking away, the same on both pages
  // at the same world time.
  await expect
    .poll(async () => (await ending(ann.p)).now, { timeout: 90_000 })
    .toBeGreaterThan(ends - 10_000);
  // Each page draws a frame and reads its stage in one go: the stage is
  // set as a frame is drawn, and two pages on CI's renderer draw one only
  // every second or so.
  const drawn = (p: Page): Promise<Ending> =>
    p.evaluate(() => {
      globalThis.keel.render();
      return globalThis.keel.ending();
    });
  const [a, b] = await Promise.all([drawn(ann.p), drawn(bob.p)]);
  expect(a.stage.cut).toBeGreaterThan(0);
  const rate = 120 / 20; // the near sea's metres a second
  expect(Math.abs(a.stage.cut - b.stage.cut)).toBeLessThan(
    rate * (Math.abs(a.now - b.now) / 1000 + 0.5),
  );
  expect(a.stage.sound).toBeGreaterThan(0.5);

  // The new world: both welcomed into it, back at sea in under 10 s.
  for (const s of [ann, bob]) {
    await expect
      .poll(async () => (await ending(s.p)).world, { timeout: 30_000 })
      .not.toBe(before.world);
    await expect
      .poll(() => s.p.evaluate(() => globalThis.keel.net().status), { timeout: 10_000 })
      .toBe('sailing');
  }
  const after = await ending(ann.p);
  expect(after.ends).toBeGreaterThan(Date.now() + 3600_000);
  // A blank chart: what is known from the world's start, credited to no
  // one, and what these two sailors' lookouts have sighted since; nothing
  // of the old world's charting.
  const chart = await ann.p.evaluate(() => globalThis.keel.chartInfo());
  expect(chart.credits.every(([, by]) => by === '' || /^(Ann|Bob) \d+$/.test(by))).toBe(true);
  expect(chart.titles).toContain('Port Royal');
  // One charts an island of the new world; the other sees it.
  const charted = await request.post(`${internal}/debug/chart?subject=island:1`);
  expect(charted.status()).toBe(204);
  await expect
    .poll(async () => (await bob.p.evaluate(() => globalThis.keel.chartInfo())).size, {
      timeout: 15_000,
    })
    .toBeGreaterThan(chart.size);
  await ann.c.close();
  await bob.c.close();
});

test('@long a world’s end missed while keel was down is switched as it starts', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const ann = await sailor(browser, 'Ann');
  const ends = await endIn(ann.p, 15);
  const before = await ending(ann.p);
  // Down across the end: the page cannot reach keel meanwhile.
  const restart = request.post(`${control}/restart?down=25s`, { timeout: 120_000 });
  await expect
    .poll(() => ann.p.evaluate(() => globalThis.keel.net().status), { timeout: 20_000 })
    .not.toBe('sailing');
  expect((await restart).status()).toBe(204);
  await expect
    .poll(async () => (await ending(ann.p)).world, { timeout: 60_000 })
    .not.toBe(before.world);
  await expect
    .poll(() => ann.p.evaluate(() => globalThis.keel.net().status), { timeout: 20_000 })
    .toBe('sailing');
  const after = await ending(ann.p);
  expect(after.ends).toBeGreaterThan(ends);
  await ann.c.close();
});
