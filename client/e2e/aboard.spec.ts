// SPDX-License-Identifier: AGPL-3.0-only

// Sailing together, against keel and its database, on pages that draw
// nothing (?draw=off): a skipper's link opened by a friend who has never
// played, who answers the age question and makes a sailor from it, and is
// asked to come aboard in the same flow; the skipper's card and Let
// aboard; the friend's boat out of the water and the friend on deck,
// steering nothing; the controls handed over, taken, given back, handed
// again and taken back at once; and Go ashore, the friend's own boat in the
// water again.

import { type Browser, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { answerBorn, GAME, holdPasskeys, sail, sailor, stamp } from './helpers';

type Deck = ReturnType<typeof globalThis.keel.deck>;

function deck(page: Page): Promise<Deck> {
  return page.evaluate(() => globalThis.keel.deck());
}

/** A friend's page in a browser of its own, its prompt answered by Playwright, holding no passkey. */
async function friendOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  await context.credentials.install();
  return context.newPage();
}

test('a link opened by a friend who has never played: a sailor made, let aboard, the controls passed and taken back, ashore', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(300_000);
  // The skipper at sea, the Rules accepted, a link made.
  const ann = await sailor(context, 'Skipper');
  await holdPasskeys(context, ann.passkey);
  expect((await context.request.post('/api/me/rules', { data: {} })).status()).toBe(204);
  // The keelboat from the fleet: she carries five.
  const keelboat = data.boats.find((b) => b.capacity === 5)?.id;
  const fleet = (await (await context.request.get('/api/fleet')).json()) as {
    boats: { id: string; kind: string }[];
  };
  const theirs = fleet.boats.find((b) => b.kind === keelboat);
  expect(theirs).toBeDefined();
  const took = await context.request.post('/api/boat', { data: { boat: theirs?.id } });
  expect(took.status(), await took.text()).toBe(200);
  await sail(page);
  const made = await context.request.post('/api/sail/link', { data: {} });
  expect(made.status(), await made.text()).toBe(201);
  const { url } = (await made.json()) as { url: string };
  const path = new URL(url).pathname;
  expect(path).toMatch(/^\/sail\/[A-Za-z0-9_-]{22}$/);

  // A friend opens it: the start screen first, the age question with the
  // name, a passkey; then whose boat it is, and the Rules before the knock.
  const bob = await friendOf(browser);
  const errors: string[] = [];
  bob.on('pageerror', (e) => errors.push(e.message));
  await bob.goto(`${path}${GAME.slice(1)}`);
  await expect(bob.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 60_000,
  });
  const name = `Friend ${stamp()}`;
  await bob.getByLabel('Your sailor’s name').fill(name);
  await answerBorn(bob, 'June', '1999');
  await bob.getByRole('button', { name: 'Set sail' }).click();
  await bob.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 60_000 });
  const ask = bob.getByRole('button', { name: /^Ask to come aboard/ });
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(bob.locator('.come-aboard')).toContainText(ann.name);
  await ask.click();
  await bob.getByRole('button', { name: 'I’ll keep to them' }).click({ timeout: 30_000 });
  await bob.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 90_000 });
  await bob.waitForFunction(() => globalThis.keel.deck().knocking?.state === 'waiting', null, {
    timeout: 60_000,
  });
  // The link is gone from the address: a reload sails.
  expect(new URL(bob.url()).pathname).toBe('/');
  const bobBoat = (await deck(bob)).boat;

  // The skipper's card, and Let aboard.
  await expect(page.getByText(`${name} asks to come aboard`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Let aboard' }).click();
  await bob.waitForFunction(() => globalThis.keel.deck().aboard !== null, null, {
    timeout: 30_000,
  });
  const aboard = await deck(bob);
  expect(aboard.aboard?.skipper).toBe(ann.name);
  expect(aboard.boat).not.toBe(bobBoat);
  expect(aboard.holding).toBe(false);
  await expect
    .poll(async () => (await deck(page)).crew?.people.length, { timeout: 30_000 })
    .toBe(2);
  await expect.poll(async () => (await deck(bob)).crew?.people.length, { timeout: 30_000 }).toBe(2);

  // Handed: nothing moves until the friend takes them.
  await page.getByRole('button', { name: 'Crew' }).first().click();
  await page.getByRole('button', { name: `Hand over the controls: ${name}` }).click();
  await expect(bob.getByText(`${ann.name} hands you the controls`)).toBeVisible({
    timeout: 30_000,
  });
  expect((await deck(page)).holding).toBe(true);
  await bob.getByRole('button', { name: 'Take them' }).click();
  await bob.waitForFunction(() => globalThis.keel.deck().holding, null, { timeout: 30_000 });
  await page.waitForFunction(() => !globalThis.keel.deck().holding, null, { timeout: 30_000 });
  // The friend's screen has the controls now; the skipper's Take back.
  await expect(page.getByRole('button', { name: 'Take back the controls' }).first()).toBeVisible();

  // Given back.
  await bob.getByRole('button', { name: 'Crew' }).first().click();
  await bob.getByRole('button', { name: 'Give them back' }).click();
  await page.waitForFunction(() => globalThis.keel.deck().holding, null, { timeout: 30_000 });
  await bob.waitForFunction(() => !globalThis.keel.deck().holding, null, { timeout: 30_000 });

  // Handed again, and taken back at once.
  await page.getByRole('button', { name: 'Crew' }).first().click();
  await page.getByRole('button', { name: `Hand over the controls: ${name}` }).click();
  await bob.getByRole('button', { name: 'Take them' }).click({ timeout: 30_000 });
  await bob.waitForFunction(() => globalThis.keel.deck().holding, null, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Take back the controls' }).first().click();
  await page.waitForFunction(() => globalThis.keel.deck().holding, null, { timeout: 30_000 });
  await bob.waitForFunction(() => !globalThis.keel.deck().holding, null, { timeout: 30_000 });

  // Ashore: the friend's own boat in the water again.
  await bob.getByRole('button', { name: 'Go ashore' }).first().click();
  await bob.getByRole('button', { name: 'Go ashore' }).last().click();
  await bob.waitForFunction(() => globalThis.keel.deck().aboard === null, null, {
    timeout: 30_000,
  });
  await bob.waitForFunction(() => globalThis.keel.deck().holding, null, { timeout: 30_000 });
  await expect.poll(async () => (await deck(page)).crew, { timeout: 30_000 }).toBeNull();
  expect(errors).toEqual([]);
});
