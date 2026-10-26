// SPDX-License-Identifier: AGPL-3.0-only

// A sailor stopped by the owner, against keel (tools/e2e). On the world
// page's Accounts tab: found by part of its name, its card opened, stopped
// with a reason once keel's words of what it does are confirmed, and a
// confirmation cancelled sends nothing but its check; refused at sign-in
// while stopped, started again, and deleted with its name typed again. At
// sea: stopped through the owner's routes, its page says so and goes back
// to the start screen, where its passkey is refused in the player's words
// until it is started again; then deleted. A second page beside the sea
// takes over a minute to load on CI's software GPU: the test at sea works
// the owner's routes with requests, no world page opened.

import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { holdPasskeys, sail, sailor, signInWith } from './helpers';

const internal = 'http://127.0.0.1:19090';
const owner = 'http://localhost:5184/owner/';

const STOPPED = 'This sailor has been stopped. It cannot sign in or sail.';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the world page: one back end is enough');
});

/** The account of a sailor, by its name, as the owner's search finds it. */
async function accountOf(request: APIRequestContext, name: string): Promise<string | null> {
  const res = await request.post(`${internal}/owner/api/accounts/search`, {
    data: { text: name, sort: 'active-new', page: 0 },
  });
  expect(res.status(), await res.text()).toBe(200);
  const found = (await res.json()) as { accounts: { id: string; name: string }[] };
  return found.accounts.find((a) => a.name === name)?.id ?? null;
}

/** An action on an account through the owner's routes: checked first, as the page does, then done. */
async function owned(
  request: APIRequestContext,
  action: 'stop' | 'start' | 'delete',
  body: Record<string, string>,
): Promise<void> {
  if (action !== 'start') {
    const check = await request.post(`${internal}/owner/api/accounts/${action}`, {
      data: { ...body, check: true },
    });
    expect(check.status(), await check.text()).toBe(200);
    expect(await check.json()).toMatchObject({ action, done: false });
  }
  const done = await request.post(`${internal}/owner/api/accounts/${action}`, { data: body });
  expect(done.status(), await done.text()).toBe(200);
  expect(await done.json()).toMatchObject({ action, done: true });
}

/** Signs in through the routes in a context of its own, as another device would: the answer's status and code. */
async function signInElsewhere(
  context: BrowserContext,
  made: Awaited<ReturnType<typeof sailor>>,
): Promise<{ status: number; error: string }> {
  const other = await context.browser()?.newContext();
  if (other === undefined) {
    throw new Error('no browser');
  }
  const res = await signInWith(other, made.passkey);
  const status = res.status();
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  await other.close();
  return { status, error: body.error ?? '' };
}

/** The page's own autofill switched off, so the button alone signs in. */
async function noAutofill(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const pkc = (
      globalThis as { PublicKeyCredential?: { isConditionalMediationAvailable?: unknown } }
    ).PublicKeyCredential;
    if (pkc !== undefined) {
      pkc.isConditionalMediationAvailable = async () => false;
    }
  });
}

/** Opens the world page on its Accounts tab, the counts read. */
async function openAccounts(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(owner);
  await expect(page.locator('[data-field="tick"]')).toHaveText(/^\d+$/, { timeout: 30_000 });
  await page.locator('button[name="tab-accounts"]').click();
  await expect(page.locator('[data-field="account-counts"]')).toContainText('made this week');
  expect(errors).toEqual([]);
}

/** The bodies of the page's POSTs of an action, from now on. */
function sent(page: Page, action: string): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/owner/api/accounts/${action}`)) {
      bodies.push(r.postDataJSON() as Record<string, unknown>);
    }
  });
  return bodies;
}

test('on the Accounts tab: found by part of its name, stopped, started again, deleted', async ({
  browser,
  page,
}) => {
  const maker = await browser.newContext();
  const made = await sailor(maker, 'Stopped');
  await maker.close();
  await openAccounts(page);

  // Found by part of its name: the figures after its word.
  const part = made.name.split(' ')[1] ?? made.name;
  await page.locator('input[name="search"]').fill(part);
  await page.locator('button[name="find"]').click();
  const row = page.locator('table.accounts tr[data-account]', { hasText: made.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('human');
  await row.click();
  const card = page.locator('section.account-card');
  await expect(card.locator('[data-field="card-name"]')).toHaveText(made.name);
  await expect(card.locator('[data-field="card-stopped"]')).toHaveText('no');

  // No reason, no stop: the page says why and asks keel nothing.
  const stops = sent(page, 'stop');
  await card.locator('button[name="stop"]').click();
  await expect(card.locator('[data-field="hand-why"]')).toContainText('A reason is needed');
  expect(stops).toEqual([]);

  // Checked, then cancelled: keel was asked what it would do, and nothing more.
  await card.locator('input[name="reason"]').fill('a test of stopping');
  await card.locator('button[name="stop"]').click();
  const confirmation = card.locator('[data-field="account-confirmation"]');
  await expect(confirmation).toContainText(made.name);
  await confirmation.locator('button[name="cancel"]').click();
  await expect(confirmation).toHaveCount(0);
  expect(stops).toHaveLength(1);
  expect(stops[0]).toMatchObject({ reason: 'a test of stopping', check: true });
  expect((await signInElsewhere(page.context(), made)).status).toBe(200);

  // Checked again and confirmed: stopped, and its passkey refused.
  await card.locator('button[name="stop"]').click();
  await expect(confirmation).toContainText(made.name);
  await confirmation.locator('button[name="confirm"]').click();
  await expect(page.locator('.message')).toContainText(`Done: ${made.name} stopped`);
  expect(stops).toHaveLength(3);
  expect(stops[2]).not.toHaveProperty('check');
  await expect(card.locator('[data-field="card-stopped"]')).toContainText('a test of stopping');
  await expect(row.locator('[data-field="row-stopped"]')).toHaveText('stopped');
  expect(await signInElsewhere(page.context(), made)).toEqual({ status: 403, error: 'stopped' });

  // Started again, as asked in the page's words: its passkey signs in.
  await card.locator('button[name="start"]').click();
  await expect(confirmation).toContainText(`Start ${made.name} again?`);
  await confirmation.locator('button[name="confirm"]').click();
  await expect(page.locator('.message')).toContainText(`Done: ${made.name} started again`);
  await expect(card.locator('[data-field="card-stopped"]')).toHaveText('no');
  expect((await signInElsewhere(page.context(), made)).status).toBe(200);
  // What was done is on its record.
  await expect(card.locator('table.record')).toContainText('a test of stopping');

  // Deleted, its name typed again: the card closes, the passkey names no one.
  await card.locator('input[name="reason"]').fill('a test of deleting');
  await card.locator('input[name="delete-name"]').fill(made.name);
  await card.locator('button[name="delete"]').click();
  await expect(confirmation).toContainText(made.name);
  await confirmation.locator('button[name="confirm"]').click();
  await expect(page.locator('.message')).toContainText(`Done: ${made.name} deleted`);
  await expect(card.locator('[data-field="card-name"]')).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(await signInElsewhere(page.context(), made)).toEqual({
    status: 404,
    error: 'unknown-passkey',
  });
});

test('stopped at sea: put ashore, refused at sign-in, started again, signed in, deleted', async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const made = await sailor(context, 'Ashore');
  // The browser holds the sailor's passkey for the start screen's button,
  // autofill off so that the button alone signs in.
  await holdPasskeys(context, made.passkey);
  await noAutofill(context);
  await sail(page);
  const id = await accountOf(request, made.name);
  expect(id).not.toBeNull();
  const account = id ?? '';

  // Stopped: the page says so, then goes back to the start screen, which
  // takes half a minute and more on CI's software GPU.
  await owned(request, 'stop', { account, reason: 'a test at sea' });
  await expect(page.getByText('This sailor has been stopped.').first()).toBeVisible({
    timeout: 30_000,
  });
  const start = page.getByRole('heading', { name: 'Keel Over the Edge' });
  await expect(start).toBeVisible({ timeout: 90_000 });

  // Its passkey is refused in the player's words.
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 30_000 });
  await expect(start).toBeVisible();

  // Started again: signed in, and at sea.
  await owned(request, 'start', { account });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(start).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible({ timeout: 90_000 });

  // Deleted, its name typed again: gone from the search, its passkey naming no one.
  await owned(request, 'delete', { account, name: made.name, reason: 'a test at sea' });
  expect(await accountOf(request, made.name)).toBeNull();
  expect(await signInElsewhere(context, made)).toEqual({ status: 404, error: 'unknown-passkey' });
  await expect(start).toBeVisible({ timeout: 90_000 });
});
