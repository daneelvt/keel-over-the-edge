// SPDX-License-Identifier: AGPL-3.0-only

// A new sailor's start, against keel and its database: the start screen,
// names refused in words, a sailor made with a passkey (Playwright's
// virtual authenticator standing in for the browser's prompt), its recovery
// code shown once, Set sail with the voyage watched, its cookie, and the
// sailor kept across a reload, where its Set sail shows that voyage's
// choice. A form draws nothing, so one back end is enough.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { sailor, setSail } from './helpers';

test.beforeEach(async ({ context }) => {
  test.skip(test.info().project.name !== 'webgl2', 'a form: one back end is enough');
  // The browser's prompt, answered by Playwright: it holds no passkey yet.
  await context.credentials.install();
});

/** A name no other test has taken: a word and digits from the clock. */
function freshName(word: string): string {
  return `${word} ${Date.now() % 10_000_000}`;
}

async function openStart(page: Page): Promise<void> {
  await page.goto('/?backend=webgl2');
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 30_000,
  });
}

/** The first form's Set sail, with a name: it makes the sailor, if the name will do. */
async function makeAs(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your sailor’s name').fill(name);
  await page.getByRole('button', { name: 'Set sail' }).click();
}

/** Who may watch the account's boat, as GET /api/me says. */
async function spectators(page: Page): Promise<string> {
  const me = await page.request.get('/api/me');
  return ((await me.json()) as { spectators?: string }).spectators ?? '';
}

async function atSea(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toHaveCount(0);
}

async function sailingAs(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Menu' }).click();
  const name = page.locator('.menu-sailor bdi');
  await expect(name).toBeVisible();
  const text = await name.textContent();
  await page.getByRole('button', { name: 'Close' }).click();
  return text ?? '';
}

async function sessionCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === '__Host-keel-session');
}

test('the start screen: a name to give, a sailor drawn, and signing in beside it', async ({
  page,
}) => {
  // The browser is asked to offer the passkeys it holds as the field is
  // touched: a sign-in begun with conditional mediation as the screen shows.
  const autofill = page.waitForRequest((r) =>
    r.url().endsWith('/signin/begin?mediation=conditional'),
  );
  await openStart(page);
  await autofill;
  const field = page.getByLabel('Your sailor’s name');
  await expect(field).toHaveAttribute('autocomplete', 'username webauthn');
  await expect(field).toHaveAttribute('autocapitalize', 'words');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('enterkeyhint', 'go');
  await expect(field).toHaveAttribute('maxlength', '20');
  const names = data.sailors.map((s) => s.name);
  expect(names).toContain(await page.locator('.start-look-name').textContent());
  await page.getByRole('button', { name: 'Draw another sailor' }).click();
  expect(names).toContain(await page.locator('.start-look-name').textContent());
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Lost your passkey? Use your recovery code' }),
  ).toBeVisible();
  // The autofill request, turned down at once (no passkey held), says nothing.
  await expect(page.locator('#start-problem')).toHaveText('');
  // Nothing is made until the name is sent.
  expect(await sessionCookie(page.context())).toBeUndefined();
});

test('names refused are explained in words, before any passkey is made', async ({
  page,
  browser,
}) => {
  await openStart(page);
  const problem = page.locator('#start-problem');
  const cases: [string, RegExp][] = [
    ['Al', /too short/],
    ['Ann ⚓', /Use letters and numbers/],
    ['Harbour Master', /not allowed/],
    ['Pаypal', /one alphabet/],
  ];
  for (const [name, words] of cases) {
    await makeAs(page, name);
    await expect(problem).toHaveText(words);
  }

  // A name another player took, and a look-alike of it.
  const other = await browser.newContext();
  const taken = (await sailor(other, 'Captain Bob')).name;
  await other.close();
  for (const name of [taken, taken.replace('Bob', 'B0b'), taken.replace(' ', '-')]) {
    await makeAs(page, name);
    await expect(problem).toHaveText(/looks just like it, is taken\. If that’s you, sign in/);
  }
  expect(await page.context().credentials.get()).toEqual([]);
  expect(await sessionCookie(page.context())).toBeUndefined();
});

test('a sailor made: the passkey, the recovery code once, the sea, the cookie, a reload', async ({
  page,
  context,
}) => {
  await openStart(page);
  const name = freshName('Anne');
  await makeAs(page, `  ${name.replace(' ', '   ')} `);
  await expect(page.getByRole('heading', { name: 'Keep your recovery code' })).toBeVisible({
    timeout: 30_000,
  });
  const code = await page.locator('.recovery-code').textContent();
  expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
  const held = await context.credentials.get();
  expect(held).toHaveLength(1);
  expect(held[0]?.rpId).toBe('localhost');
  await page.getByRole('button', { name: 'I’ve written it down' }).click();
  // Then the choice: to sea, or a machine sailor made first; and whether
  // others may watch this voyage, unticked until the player ticks it.
  await expect(page.getByRole('button', { name: 'Make a machine sailor first' })).toBeVisible();
  const box = page.getByRole('checkbox', { name: 'Let others watch me sail' });
  await expect(box).not.toBeChecked();
  await box.check();
  await setSail(page);
  await atSea(page);
  expect(await sailingAs(page)).toBe(name);
  expect(await spectators(page)).toBe('voyage');

  const cookie = await sessionCookie(context);
  expect(cookie).toBeDefined();
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.secure).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.path).toBe('/');
  const days = ((cookie?.expires ?? 0) - Date.now() / 1000) / 86_400;
  expect(days).toBeGreaterThan(399);
  expect(days).toBeLessThanOrEqual(400);
  // The page's scripts never see it.
  expect(await page.evaluate(() => document.cookie)).not.toContain('keel-session');

  // Back again: the sailor's own Set sail, the start screen's form never
  // shown; the boat still in the water, the box shows the voyage's choice,
  // and a change is sent at once.
  let startShown = false;
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/me') && res.status() === 401) {
      startShown = true;
    }
  });
  await page.reload();
  const yours = page.locator('.your-sailor');
  await expect(yours).toContainText(name, { timeout: 90_000 });
  await expect(yours.getByText('at sea', { exact: true })).toBeVisible();
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect.poll(() => spectators(page)).toBe('no');
  await setSail(page);
  await atSea(page);
  expect(startShown).toBe(false);
  expect(await sailingAs(page)).toBe(name);
  await expect(page.locator('.recovery-code')).toHaveCount(0);
});

test('a second browser cannot take the same name', async ({ page, browser }) => {
  await openStart(page);
  const other = await browser.newContext();
  const name = (await sailor(other, 'Mary Read')).name;
  await other.close();
  await makeAs(page, name);
  await expect(page.locator('#start-problem')).toHaveText(/is taken/);
  await makeAs(page, name.toLowerCase());
  await expect(page.locator('#start-problem')).toHaveText(/is taken/);
  expect(await sessionCookie(page.context())).toBeUndefined();
});
