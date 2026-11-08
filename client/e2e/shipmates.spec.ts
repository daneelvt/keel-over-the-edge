// SPDX-License-Identifier: AGPL-3.0-only

// Shipmates, against keel and its database, on pages that draw nothing
// (?draw=off): a friend let aboard by a link; the two counted as having
// sailed together five minutes (the developer's command, so the test need
// not wait them); Be shipmates from who is aboard, the offer's notice and
// Accept; the friend ashore, on a boat of their own; messages between the
// two boats both ways, the thread opened from its notice; where each is,
// hidden by Appear offline; a message to a shipmate who has left the game
// refused with its words kept; and No longer shipmates, gone from both
// lists at once.

import { type Browser, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { answerBorn, GAME, holdPasskeys, sail, sailor, stamp } from './helpers';

/** keel's internal listener, as tools/e2e serves it (or KEEL_INTERNAL): its developer commands. */
const internal = process.env.KEEL_INTERNAL ?? 'http://127.0.0.1:19090';

interface Listed {
  offline: boolean;
  shipmates: { id: string; name: string; presence: string }[];
  offers: { id: string; name: string }[];
}

async function listOf(page: Page): Promise<Listed> {
  const res = await page.context().request.get('/api/shipmates');
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Listed;
}

/** Opens the menu's Shipmates. */
async function openShipmates(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Shipmates', exact: true }).click();
  await expect(page.locator('[data-panel=shipmates]')).toBeVisible({ timeout: 30_000 });
}

/** Sends a message in the open thread. */
async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Your message' }).fill(text);
  await page.locator('.shipmate-thread').getByRole('button', { name: 'Send', exact: true }).click();
}

async function friendOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  await context.credentials.install();
  return context.newPage();
}

test('shipmates: made after sailing together, messages between two boats, appear offline, away, and ended for both', async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(300_000);
  // The skipper at sea in a keelboat, a link made.
  const ann = await sailor(context, 'Skipper');
  await holdPasskeys(context, ann.passkey);
  expect((await context.request.post('/api/me/rules', { data: {} })).status()).toBe(204);
  const keelboat = data.boats.find((b) => b.capacity === 5)?.id;
  const fleet = (await (await context.request.get('/api/fleet')).json()) as {
    boats: { id: string; kind: string }[];
  };
  const took = await context.request.post('/api/boat', {
    data: { boat: fleet.boats.find((b) => b.kind === keelboat)?.id },
  });
  expect(took.status(), await took.text()).toBe(200);
  await sail(page);
  const made = await context.request.post('/api/sail/link', { data: {} });
  expect(made.status(), await made.text()).toBe(201);
  const path = new URL(((await made.json()) as { url: string }).url).pathname;

  // A friend makes a sailor from the link and is let aboard.
  const bob = await friendOf(browser);
  const errors: string[] = [];
  bob.on('pageerror', (e) => errors.push(e.message));
  page.on('pageerror', (e) => errors.push(e.message));
  await bob.goto(`${path}${GAME.slice(1)}`);
  const name = `Friend ${stamp()}`;
  await bob.getByLabel('Your sailor’s name').fill(name, { timeout: 60_000 });
  await answerBorn(bob, 'June', '1999');
  await bob.getByRole('button', { name: 'Set sail' }).click();
  await bob.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 60_000 });
  await bob.getByRole('button', { name: /^Ask to come aboard/ }).click({ timeout: 30_000 });
  await bob.getByRole('button', { name: 'I’ll keep to them' }).click({ timeout: 30_000 });
  await bob.waitForFunction(() => globalThis.keel?.deck().knocking?.state === 'waiting', null, {
    timeout: 90_000,
  });
  await page.getByRole('button', { name: 'Let aboard' }).click({ timeout: 30_000 });
  await bob.waitForFunction(() => globalThis.keel.deck().aboard !== null, null, {
    timeout: 30_000,
  });
  await expect
    .poll(async () => await bob.evaluate(() => globalThis.keel.deck().crew?.people.length), {
      timeout: 30_000,
    })
    .toBe(2);

  // Before five minutes together, an offer waits for them.
  await bob.getByRole('button', { name: 'Crew' }).first().click();
  await bob.getByRole('button', { name: `More: ${ann.name}` }).click();
  await bob.getByRole('button', { name: `Be shipmates: ${ann.name}` }).click();
  await expect(bob.locator('.deck-row-note')).toContainText('sailed together a while', {
    timeout: 30_000,
  });

  // Five minutes together, by the developer's command; then the offer.
  const hurried = await context.request.post(`${internal}/debug/sailed`);
  expect(hurried.status()).toBe(200);
  expect(await hurried.text()).toContain('pairs sailed together');
  await bob.getByRole('button', { name: `More: ${ann.name}` }).click();
  await bob.getByRole('button', { name: `Be shipmates: ${ann.name}` }).click();
  await expect(bob.locator('.deck-row-note')).toContainText('Offered', { timeout: 30_000 });
  await bob.getByRole('button', { name: 'Close' }).last().click();

  // The skipper's notice of it, and Accept.
  const offer = page.locator('.shipmate-notice[data-notice=offer]');
  await expect(offer).toContainText(name, { timeout: 30_000 });
  await offer.getByRole('button', { name: 'See' }).click();
  await page.getByRole('button', { name: `Accept: ${name}` }).click();
  await expect(page.locator('li[data-row=shipmate]')).toContainText(name, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Close' }).last().click();
  // The mark aboard.
  await expect
    .poll(async () => bob.evaluate(() => globalThis.keel.deck().crew?.people[0]?.shipmate), {
      timeout: 30_000,
    })
    .toBe(true);

  // The friend goes ashore: a boat of their own, at the nearest port.
  await bob.getByRole('button', { name: 'Go ashore' }).first().click();
  await bob.getByRole('button', { name: 'Go ashore' }).last().click();
  await bob.waitForFunction(() => globalThis.keel.deck().aboard === null, null, {
    timeout: 30_000,
  });
  await bob.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 30_000,
  });

  // From one boat to the other: the skipper sees the friend at sea and
  // writes; the friend's notice opens the thread, and they answer.
  await openShipmates(page);
  const row = page.locator('li[data-row=shipmate]', { hasText: name });
  await expect(row).toHaveAttribute('data-presence', 'sea', { timeout: 30_000 });
  await row.getByRole('button', { name: `Message: ${name}` }).click();
  await send(page, 'Fair winds from my boat to yours');
  const wrote = bob.locator('.shipmate-notice[data-notice=message]');
  await expect(wrote).toContainText(ann.name, { timeout: 30_000 });
  await wrote.getByRole('button', { name: 'Open' }).click();
  await expect(bob.locator('.shipmate-thread')).toContainText('Fair winds from my boat to yours', {
    timeout: 30_000,
  });
  await bob.waitForTimeout(2_100);
  await send(bob, 'And to you, skipper');
  await expect(page.locator('.shipmate-thread')).toContainText('And to you, skipper', {
    timeout: 30_000,
  });

  // Appear offline hides where the skipper is from the friend.
  const annID = (await listOf(bob)).shipmates[0]?.id ?? '';
  expect((await listOf(bob)).shipmates[0]?.presence).toBe('sea');
  expect((await context.request.post('/api/me/offline', { data: { on: true } })).status()).toBe(
    204,
  );
  expect((await listOf(bob)).shipmates.find((s) => s.id === annID)?.presence ?? '').toBe('');
  expect((await context.request.post('/api/me/offline', { data: { on: false } })).status()).toBe(
    204,
  );

  // The friend leaves the game: a message to them is refused, its words
  // kept in the field, and kept nowhere else.
  const bobContext = bob.context();
  await bob.close();
  await page.waitForTimeout(2_000);
  await send(page, 'Are you still there?');
  await expect(page.locator('.shipmate-thread')).toContainText('isn’t in the game', {
    timeout: 30_000,
  });
  await expect(page.getByRole('textbox', { name: 'Your message' })).toHaveValue(
    'Are you still there?',
  );

  // No longer shipmates: gone from both lists at once.
  await page.getByRole('button', { name: 'Close the messages' }).click();
  await openShipmates(page);
  await page
    .locator('li[data-row=shipmate]', { hasText: name })
    .getByRole('button', { name: `More: ${name}` })
    .click();
  await page.getByRole('button', { name: `No longer shipmates: ${name}` }).click();
  await page
    .locator('[data-asking=end]')
    .getByRole('button', { name: 'No longer shipmates' })
    .click();
  await expect(page.locator('li[data-row=shipmate]')).toHaveCount(0, { timeout: 30_000 });
  const theirs = await bobContext.request.get('/api/shipmates');
  expect(((await theirs.json()) as Listed).shipmates).toEqual([]);
  expect((await listOf(page)).shipmates).toEqual([]);
  expect(errors).toEqual([]);
});
