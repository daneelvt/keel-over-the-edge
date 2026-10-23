// SPDX-License-Identifier: AGPL-3.0-only

// The owner's tools online, against keel (tools/e2e): two sailors, Ann
// flagged from the world page's API, Bob not. Ann's free camera roams, her
// boat staying where it was; Bob's is not offered, and a Roam his page
// sends anyway is refused. Ann's boat is teleported beside Bob: he sees it
// leave his view and arrive; hidden, he no longer sees it. Each control is
// counted. One back end is enough: the drawing is not under test.

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { sail, sailor } from './helpers';

const internal = 'http://127.0.0.1:19090';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

async function metric(request: APIRequestContext, line: string): Promise<number> {
  const text = await (await request.get(`${internal}/metrics`)).text();
  const l = text.split('\n').find((s) => s.startsWith(`${line} `));
  return l === undefined ? 0 : Number(l.split(' ')[1]);
}

/** A control of the world page, as the page sends it. */
async function control(request: APIRequestContext, path: string, body: unknown): Promise<void> {
  const res = await request.post(`${internal}/owner/api/${path}`, { data: body });
  expect(res.status(), await res.text()).toBe(200);
}

/** The account of a boat, as the world page has it once it has seen the boat: within a second. */
async function accountOf(request: APIRequestContext, boat: number): Promise<string> {
  let account = '';
  await expect
    .poll(
      async () => {
        const w = (await (await request.get(`${internal}/owner/api/world.json`)).json()) as {
          boats: { boat: number; account: string }[];
        };
        account = w.boats.find((x) => x.boat === boat)?.account ?? '';
        return account;
      },
      { timeout: 5000 },
    )
    .not.toBe('');
  return account;
}

/** Whether a page sees another boat within 10 m of (x, y). */
async function sees(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([x, y]) =>
      globalThis.keel
        .fleet()
        .boats.some(
          (b) => b.opacity > 0.5 && Math.hypot(b.east - (x ?? 0), b.north - (y ?? 0)) < 10,
        ),
    [x, y],
  );
}

test('the owner roams and teleports; another sailor can do neither', async ({
  browser,
  request,
}) => {
  const placed = await metric(request, 'keel_owner_actions_total{action="place"}');
  const refused = await metric(request, 'keel_owner_refused_total{what="roam"}');
  // Small pages, so CI's software renderer draws two of them often enough.
  const small = { viewport: { width: 320, height: 200 } };
  const contexts: BrowserContext[] = [
    await browser.newContext(small),
    await browser.newContext(small),
  ];
  const [ann, bob] = await Promise.all(contexts.map((c) => c.newPage()));
  if (ann === undefined || bob === undefined) {
    throw new Error('no pages');
  }
  await sailor(contexts[0] as BrowserContext, 'Ann');
  await sailor(contexts[1] as BrowserContext, 'Bob');
  await sail(ann);
  await sail(bob);
  const annBoat = await ann.evaluate(() => globalThis.keel.net().boat);
  const bobBoat = await bob.evaluate(() => globalThis.keel.net().boat);
  await control(request, 'flag', { account: await accountOf(request, annBoat), on: true });
  await expect.poll(() => ann.evaluate(() => globalThis.keel.net().tools)).toBe(true);
  expect(await bob.evaluate(() => globalThis.keel.net().tools)).toBe(false);

  // Bob: F does nothing, and no camera is offered.
  await bob.keyboard.press('KeyF');
  await bob.evaluate(() => globalThis.keel.fly({ east: 3000, north: 0, height: 100 }));
  expect(await bob.evaluate(() => globalThis.keel.freeCam().on)).toBe(false);
  // Ann: the free camera roams 2 km off, and her boat stays.
  const before = await ann.evaluate(() => globalThis.keel.boat().state);
  await ann.evaluate(() => globalThis.keel.fly({ east: 2000, north: 2000, height: 120 }));
  await expect
    .poll(() => ann.evaluate(() => globalThis.keel.net().stays), { timeout: 10_000 })
    .toBe(true);
  await ann.waitForTimeout(2000);
  const held = await ann.evaluate(() => globalThis.keel.boat().state);
  expect(Math.hypot(held.x - before.x, held.y - before.y)).toBeLessThan(20);
  await ann.waitForTimeout(1500);
  const still = await ann.evaluate(() => globalThis.keel.boat().state);
  expect(Math.hypot(still.x - held.x, still.y - held.y)).toBeLessThan(0.01);
  // Back on the boat: it sails again.
  await ann.keyboard.press('Escape');
  await expect
    .poll(() => ann.evaluate(() => globalThis.keel.net().stays), { timeout: 10_000 })
    .toBe(false);

  // Bob's page sends a Roam all the same, as a modified client could: refused.
  await bob.evaluate(() => globalThis.keel.roamAnyway(3000, 0, 100));
  await expect
    .poll(() => metric(request, 'keel_owner_refused_total{what="roam"}'), { timeout: 10_000 })
    .toBeGreaterThan(refused);

  // Ann's boat put 1 km away, then 40 m beside Bob's: he sees it arrive.
  await control(request, 'place', { boat: annBoat, east: 1500, north: 1500 });
  const bobAt = await bob.evaluate(() => globalThis.keel.boat().state);
  await expect.poll(() => sees(bob, held.x, held.y), { timeout: 10_000 }).toBe(false);
  const there = [bobAt.x + 40, bobAt.y];
  await control(request, 'place', { boat: annBoat, east: there[0], north: there[1] });
  await expect.poll(() => sees(bob, there[0] ?? 0, there[1] ?? 0), { timeout: 10_000 }).toBe(true);
  // Hidden: gone from Bob's view; shown again.
  await control(request, 'unseen', { boat: annBoat, on: true });
  await expect.poll(() => sees(bob, there[0] ?? 0, there[1] ?? 0), { timeout: 10_000 }).toBe(false);
  await control(request, 'unseen', { boat: annBoat, on: false });
  await expect.poll(() => sees(bob, there[0] ?? 0, there[1] ?? 0), { timeout: 10_000 }).toBe(true);
  // Bob's boat is not the page's to move.
  const res = await request.post(`${internal}/owner/api/place`, {
    data: { boat: bobBoat, start: true },
  });
  expect(res.status()).toBe(403);
  expect(await metric(request, 'keel_owner_actions_total{action="place"}')).toBe(placed + 2);
  await Promise.all(contexts.map((c) => c.close()));
});
