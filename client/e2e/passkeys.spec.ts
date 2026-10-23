// SPDX-License-Identifier: AGPL-3.0-only

// A sailor's account in the browser, against keel and its database, on
// Chromium and WebKit: signed in with its passkey by the browser's prompt
// and by autofill, back in with its recovery code, a second passkey added
// and the first removed from the account page, signed out, and deleted.
// Playwright's virtual authenticator stands in for the prompt: it answers
// at once, even an autofill request, so autofill is tested as asked for,
// not as waited on. One test runs on Chrome's own virtual authenticator,
// which is the browser's WebAuthn and checks the passkey's origin.
//
// WebKit stops at the session: its tests do not wait for the sea.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { holdPasskeys, sailor, signInWith } from './helpers';

const look = data.sailors[0]?.id ?? '';

const chromium = () => test.info().project.name === 'webgl2';

test.beforeEach(() => {
  const p = test.info().project.name;
  test.skip(p !== 'webgl2' && p !== 'webkit', 'Chromium and WebKit');
});

async function openStart(page: Page): Promise<void> {
  await page.goto('/?backend=webgl2');
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 30_000,
  });
}

async function atSea(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible({ timeout: 60_000 });
}

async function session(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === '__Host-keel-session');
}

/** Waits for the start screen to give way to a sailor signed in. */
async function signedIn(page: Page, context: BrowserContext): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect.poll(async () => (await session(context)) !== undefined).toBe(true);
}

/**
 * The page's own autofill switched off, so the button alone signs in: after
 * holdPasskeys, whose authenticator would answer it otherwise.
 */
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

async function openAccount(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  await expect(page.locator('.account-passkeys li').first()).toBeVisible();
}

test('signed in on another device by the browser’s prompt, and by autofill', async ({
  browser,
  context,
}) => {
  const made = await sailor(context, 'Prompt');

  // Another device that holds the passkey, as a synced one would; its
  // autofill off: the button signs in.
  const other = await browser.newContext();
  await holdPasskeys(other, made.passkey);
  await noAutofill(other);
  const page = await other.newPage();
  await openStart(page);
  const finish = page.waitForRequest((r) => r.url().endsWith('/signin/finish'));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await finish;
  await signedIn(page, other);
  await other.close();

  // A third, autofill on: the passkey offered as the screen shows is taken
  // at once, by Playwright's authenticator, which waits for no one.
  const third = await browser.newContext();
  await holdPasskeys(third, made.passkey);
  const page3 = await third.newPage();
  const conditional = page3.waitForRequest((r) =>
    r.url().endsWith('/signin/finish?mediation=conditional'),
  );
  await page3.goto('/?backend=webgl2');
  await conditional;
  await signedIn(page3, third);
  if (chromium()) {
    await atSea(page3);
  }
  await third.close();
});

test('back in with the recovery code: a new passkey, a new code, and the old code spent', async ({
  browser,
  context,
}) => {
  const made = await sailor(context, 'Recovered');
  const lost = await browser.newContext();
  await lost.credentials.install();
  const page = await lost.newPage();
  await openStart(page);
  await page.getByRole('button', { name: 'Lost your passkey? Use your recovery code' }).click();
  // Typed in small letters, without its hyphens.
  await page.getByLabel('Recovery code').fill(made.recoveryCode.toLowerCase().replace(/-/g, ''));
  await expect(page.getByLabel('Recovery code')).toHaveValue(made.recoveryCode);
  await page.getByRole('button', { name: 'Use the code' }).click();
  await expect(page.getByRole('heading', { name: 'Add a passkey' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Your new recovery code' })).toBeVisible();
  const code = await page.locator('.recovery-code').textContent();
  expect(code).not.toBe(made.recoveryCode);
  expect(await lost.credentials.get()).toHaveLength(1);
  await page.getByRole('button', { name: 'I’ve written it down' }).click();
  await expect(page.getByRole('heading', { name: 'Your new recovery code' })).toHaveCount(0);

  // The session the code made is the account's: the old one is spent, and
  // the old device's session ended.
  const me = await page.request.get('/api/me');
  expect(await me.json()).toMatchObject({ name: made.name });
  expect((await context.request.get('/api/me')).status()).toBe(401);
  const again = await browser.newContext();
  const res = await again.request.post('/recovery', { data: { code: made.recoveryCode } });
  expect(res.status()).toBe(422);
  await again.close();
  await lost.close();
});

test('the account page: a passkey added and one removed, signed out, and the sailor deleted', async ({
  browser,
  context,
  page,
}) => {
  test.skip(!chromium(), 'the account page is at sea, which WebKit does not draw here');
  test.setTimeout(150_000);
  // The sailor made by the test's own authenticator, which this browser
  // does not hold: its prompt makes the second passkey.
  const made = await sailor(context, 'Account');
  await context.credentials.install();
  await page.goto('/?test&backend=webgl2&tier=low');
  await atSea(page);
  await openAccount(page);
  const passkeys = page.locator('.account-passkeys li');
  await expect(passkeys).toHaveCount(1);
  await expect(passkeys.first()).toContainText(/added .*last used/);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.locator('.account-status')).toHaveText('Passkey added.');
  await expect(passkeys).toHaveCount(2);
  await expect(passkeys.nth(1)).toContainText('Chrome');

  // Removing asks for a passkey of the account's own first: this browser's.
  await passkeys.first().getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.account-status')).toHaveText('Passkey removed.');
  await expect(passkeys).toHaveCount(1);
  // The other devices sign in through the routes, no page opened: a second
  // page beside the sea takes over a minute to load on CI's software GPU.
  // The removed passkey signs in no more.
  const gone = await browser.newContext();
  const refused = await signInWith(gone, made.passkey);
  expect(refused.status()).toBe(404);
  expect(await refused.json()).toMatchObject({ error: 'unknown-passkey' });
  await gone.close();

  // Another device signed in with the passkey this browser added, then
  // signed out from here.
  const other = await browser.newContext();
  const [added] = await context.credentials.get();
  if (added === undefined) {
    throw new Error('the browser holds no passkey');
  }
  const signin = await signInWith(other, {
    rpId: added.rpId,
    origin: '',
    id: added.id,
    userHandle: added.userHandle ?? '',
    privateKey: added.privateKey,
    publicKey: added.publicKey ?? '',
    signCount: added.signCount ?? 0,
  });
  expect(signin.status(), await signin.text()).toBe(200);
  expect((await other.request.get('/api/me')).status()).toBe(200);
  await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
  await expect(page.locator('.account-status')).toHaveText('Signed out on 1 other device.');
  expect((await other.request.get('/api/me')).status()).toBe(401);
  await other.close();

  // Deleted: the name typed again, and the start screen.
  await page.getByRole('button', { name: 'Delete this sailor' }).click();
  await expect(page.getByRole('heading', { name: `Delete ${made.name} for good?` })).toBeVisible();
  await page.locator('input[name="delete-name"]').fill(made.name.toLowerCase());
  await page.getByRole('button', { name: 'Delete this sailor' }).click();
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 30_000,
  });
  expect(await session(context)).toBeUndefined();
  // Its name is free at once.
  const next = await browser.newContext();
  const begun = await next.request.post('/account/begin', { data: { name: made.name, look } });
  expect(begun.status()).toBe(200);
  await next.close();
});

test('Chrome’s own authenticator: a passkey made and used at localhost, forgotten once deleted', async ({
  context,
  page,
}) => {
  test.skip(!chromium(), "Chrome's DevTools protocol");
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const held = async () =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

  await openStart(page);
  const name = `Chrome ${Date.now() % 10_000_000}`;
  await page.getByLabel('Your sailor’s name').fill(name);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await expect(page.getByRole('heading', { name: 'Keep your recovery code' })).toBeVisible({
    timeout: 30_000,
  });
  const made = await held();
  expect(made).toHaveLength(1);
  expect(made[0]?.rpId).toBe('localhost');
  expect(made[0]?.isResidentCredential).toBe(true);

  // Signed out, and in again with it: Chrome's own prompt, its origin
  // checked against the relying party.
  const out = await page.request.post('/logout');
  expect(out.status()).toBe(204);
  await page.reload();
  await signedIn(page, context);

  // Deleted through the routes, the page tells Chrome to forget it.
  const me = await page.request.get('/api/me');
  expect((await me.json()).name).toBe(name);
  await page.evaluate(async (n) => {
    // The page's own module, as Vite serves it.
    const url = '/src/account/passkeys.ts';
    const { confirmPasskey, deleteSailor } = await import(/* @vite-ignore */ url);
    const c = await confirmPasskey();
    if (!c.ok) {
      throw new Error(c.reason);
    }
    const d = await deleteSailor(n);
    if (!d.ok) {
      throw new Error(d.reason);
    }
  }, name);
  await expect.poll(async () => (await held()).length).toBe(0);
});
