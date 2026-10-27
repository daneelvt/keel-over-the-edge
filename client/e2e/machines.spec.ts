// SPDX-License-Identifier: AGPL-3.0-only

// Machine sailors in the game, against keel and its database: a new
// sailor's choice after the recovery code, the machine sailor's form, how
// to connect it, and the start screen with machine sailors, shown again on
// every entry; then the account page: an approved app revoked, a
// connection token made (shown once, after the passkey) and revoked, and
// a machine sailor deleted. Playwright's virtual authenticator stands in
// for the browser's prompt. The other devices and the AI app are the
// test's own, through the server's routes: a second page beside the sea is
// slow on CI's software GPU.

import { createHash, randomBytes } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { holdPasskeys, type Made, sailor, steady } from './helpers';
import { assertPasskey } from './passkey';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'forms: one back end is enough');
});

async function atSea(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible({ timeout: 60_000 });
}

/** A machine sailor made through the server's route, its look the catalog's first. */
async function machine(context: BrowserContext, name: string): Promise<string> {
  const res = await context.request.post('/api/machines', {
    data: {
      name,
      version: data.machine.versions[0]?.id,
      finish: data.machine.finishes[0]?.id,
      colour: data.machine.colours[0]?.id,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const page = (await res.json()) as { machines: { id: string; name: string }[] };
  return page.machines.find((m) => m.name === name)?.id ?? '';
}

/**
 * An AI app approved for a machine sailor, as the approval page would,
 * through its routes: registered, the request made, the passkey's answer,
 * and the approval.
 */
async function approveApp(context: BrowserContext, made: Made, machineId: string): Promise<void> {
  const redirect = 'http://127.0.0.1:47616/callback';
  const reg = await context.request.post('/oauth/register', {
    data: { redirect_uris: [redirect], client_name: 'Test app' },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const challenge = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirect,
    state: 's',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authorize = await context.request.get(`/oauth/authorize?${q}`, { maxRedirects: 0 });
  expect(authorize.status(), await authorize.text()).toBe(303);
  const begun = await context.request.post('/oauth/approve/begin');
  expect(begun.status(), await begun.text()).toBe(200);
  const origin = new URL(begun.url()).origin;
  const finish = await context.request.post('/oauth/approve/finish', {
    data: assertPasskey({ ...made.passkey, origin }, await begun.json()),
  });
  expect(finish.status(), await finish.text()).toBe(200);
  const approved = await context.request.post('/oauth/approve', { data: { machine: machineId } });
  expect(approved.status(), await approved.text()).toBe(200);
}

test('a new sailor’s machine sailor: the choice, the form, how to connect, and the start screen with it', async ({
  browser,
  context,
  page,
}) => {
  await context.credentials.install();
  await page.goto('/?test&backend=webgl2&tier=low');
  await page.getByLabel('Your sailor’s name').fill(`Maker ${Date.now() % 10_000_000}`);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 30_000 });

  // The choice: to sea, or a machine sailor first.
  await expect(page.getByRole('heading', { name: 'Ready to sail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set sail' })).toBeVisible();
  await page.getByRole('button', { name: 'Make a machine sailor first' }).click();

  // The form, its look drawn at random, and drawn again.
  await expect(page.getByRole('heading', { name: 'Make a machine sailor' })).toBeVisible();
  const look = page.locator('.machine-look-row .machine-look');
  const words = data.machine.colours.map((c) => c.name);
  const before = (await look.textContent()) ?? '';
  expect(words.some((w) => before.endsWith(w))).toBe(true);
  await page.getByRole('button', { name: 'Draw another' }).click();
  await expect(look).not.toHaveText(before);
  // A name another sailor has is refused in words.
  const other = await browser.newContext();
  const taken = await sailor(other, 'Taken');
  await other.close();
  await page.getByLabel('Its name').fill(taken.name);
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page.locator('#machine-problem')).toHaveText(/is taken/);
  const name = `Brassy ${Date.now() % 10_000_000}`;
  await page.getByLabel('Its name').fill(name);
  await page.getByRole('button', { name: 'Make it' }).click();

  // How to connect: the MCP address, and a recipe for each app.
  await expect(page.getByRole('heading', { name: 'Connect your AI' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  await expect(page.locator('[data-mcp]')).toHaveText(`${origin}/mcp`);
  const connecting = page.locator('.connect-recipes:not(.connect-sailing)');
  for (const app of ['Claude', 'Claude Code', 'ChatGPT', 'Gemini', 'Codex', 'VS Code']) {
    await expect(connecting.getByRole('heading', { name: app, exact: true })).toBeVisible();
  }
  // And how to let it sail, once connected.
  await expect(
    page.locator('.connect-sailing').getByRole('heading', { name: 'Claude Code', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`claude mcp add --transport http keel ${origin}/mcp`)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  // The start screen with machine sailors: this one, not at sea.
  const row = page.locator('.machine-list li', { hasText: name });
  await expect(row).toContainText('not at sea');
  await expect(row).toContainText('No AI app approved yet');
  await row.getByRole('button', { name: 'How to connect' }).click();
  await expect(row.locator('[data-mcp]')).toBeVisible();
  // The account may have one: no other to make.
  await expect(page.getByRole('button', { name: 'Make another machine sailor' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await atSea(page);

  // The menu's panel shows it too.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Machine sailors' }).click();
  await expect(page.locator('.machines .machine-list li', { hasText: name })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // Every entry shows them before the sea. (Reloaded only once the page
  // draws steadily: on CI's software GPU a reload amid its start can hang.)
  await steady(page);
  await page.reload();
  await expect(page.locator('.machine-list li', { hasText: name })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Set sail' }).click();
  await atSea(page);
});

test('the account page: an app revoked, a connection token made once and revoked, a machine sailor deleted', async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  const made = await sailor(context, 'Owner');
  const name = `Cog ${Date.now() % 10_000_000}`;
  const id = await machine(context, name);
  await approveApp(context, made, id);
  await holdPasskeys(context, made.passkey);

  await page.goto('/?test&backend=webgl2&tier=low');
  await page.getByRole('button', { name: 'Set sail' }).click({ timeout: 30_000 });
  await atSea(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Account' }).click();
  const row = page.locator('.machines-account li[data-machine]', { hasText: name });
  await expect(row).toBeVisible();
  const boat = data.boats[0]?.name ?? '';
  // A boat for the player, and one for the machine sailor.
  await expect(page.locator('.machines-account')).toContainText(`Your fleet: 2 ${boat}s`);

  // The app: its host, approved today, ending in the grant's lifetime.
  const app = row.locator('.machine-apps li', { hasText: 'Test app' });
  await expect(app).toContainText('an app on this computer');
  await expect(app).toContainText(/approved on \d+ \w+, not used yet, ends on \d+ \w+/);
  await app.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.machines-status')).toHaveText('App revoked.');
  await expect(row.locator('.machine-apps')).toHaveCount(0);
  await expect(row).toContainText('No AI app approved.');

  // A connection token: the passkey first, then shown once.
  await expect(row).toContainText('Connection token: none');
  await row.getByRole('button', { name: 'Make a token' }).click();
  await expect(
    page.getByText(`Whoever holds this token sails ${name} and speaks as it.`),
  ).toBeVisible();
  const token = (await page.locator('[data-token]').getAttribute('data-token')) ?? '';
  expect(token.length).toBeGreaterThan(20);
  // It opens the MCP address.
  const mcp = (body: object) =>
    context.request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
      },
      data: body,
    });
  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  };
  expect((await mcp(init)).status()).not.toBe(401);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(row).toContainText(/Connection token: made on \d+ \w+/);
  await expect(page.locator('[data-token]')).toHaveCount(0);
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.machines-status')).toHaveText('Token revoked.');
  await expect(row).toContainText('Connection token: none');
  expect((await mcp(init)).status()).toBe(401);

  // Deleted: its name typed again.
  await row.getByRole('button', { name: 'Delete this machine sailor' }).click();
  await expect(page.getByRole('heading', { name: `Delete ${name} for good?` })).toBeVisible();
  await page.locator('input[name="machine-delete-name"]').fill(name.toUpperCase());
  await page.getByRole('button', { name: 'Delete this machine sailor' }).click();
  await expect(page.locator('.machines-status')).toHaveText('Machine sailor deleted.');
  await expect(page.locator('.machines-account li[data-machine]')).toHaveCount(0);
});
