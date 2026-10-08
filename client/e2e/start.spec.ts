// SPDX-License-Identifier: AGPL-3.0-only

// A guest's start, against keel and its database: the start screen, names
// refused in words, a name accepted, its cookie, and the sailor kept across
// a reload. A form draws nothing, so one back end is enough.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };

const look = data.sailors[0]?.id ?? '';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'a form: one back end is enough');
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

async function setSail(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your sailor’s name').fill(name);
  await page.getByRole('button', { name: 'Set sail' }).click();
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

test('the start screen: a name to give, and a sailor drawn from the catalog', async ({ page }) => {
  await openStart(page);
  const field = page.getByLabel('Your sailor’s name');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('autocomplete', 'off');
  await expect(field).toHaveAttribute('autocapitalize', 'words');
  await expect(field).toHaveAttribute('spellcheck', 'false');
  await expect(field).toHaveAttribute('enterkeyhint', 'go');
  await expect(field).toHaveAttribute('maxlength', '20');
  const names = data.sailors.map((s) => s.name);
  expect(names).toContain(await page.locator('.start-look-name').textContent());
  await page.getByRole('button', { name: 'Draw another sailor' }).click();
  expect(names).toContain(await page.locator('.start-look-name').textContent());
  // Nothing is made until the name is sent.
  expect(await sessionCookie(page.context())).toBeUndefined();
});

test('names refused are explained in words', async ({ page, request }) => {
  await openStart(page);
  const problem = page.locator('#start-problem');
  const cases: [string, RegExp][] = [
    ['Al', /too short/],
    ['Ann ⚓', /Use letters and numbers/],
    ['Harbour Master', /not allowed/],
    ['Pаypal', /one alphabet/],
  ];
  for (const [name, words] of cases) {
    await setSail(page, name);
    await expect(problem).toHaveText(words);
  }

  // A name another player took, through the API, and a look-alike of it.
  const taken = freshName('Captain Bob');
  const made = await request.post('/guest', { data: { name: taken, look } });
  expect(made.status()).toBe(201);
  for (const name of [taken, taken.replace('Bob', 'B0b'), taken.replace(' ', '-')]) {
    await setSail(page, name);
    await expect(problem).toHaveText(/looks just like it, is taken/);
  }
  expect(await sessionCookie(page.context())).toBeUndefined();
});

test('a name accepted: the sea, the cookie, and the sailor kept across a reload', async ({
  page,
  context,
}) => {
  await openStart(page);
  const name = freshName('Anne');
  await setSail(page, `  ${name.replace(' ', '   ')} `);
  await atSea(page);
  expect(await sailingAs(page)).toBe(name);

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

  // Back again: straight to sea, the start screen never shown.
  let startShown = false;
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/me') && res.status() === 401) {
      startShown = true;
    }
  });
  await page.reload();
  await atSea(page);
  expect(startShown).toBe(false);
  expect(await sailingAs(page)).toBe(name);
});

test('a second browser cannot take the same name', async ({ page, browser }) => {
  await openStart(page);
  const name = freshName('Mary Read');
  await setSail(page, name);
  await atSea(page);

  const other = await browser.newContext({ viewport: { width: 960, height: 600 } });
  try {
    const second = await other.newPage();
    await openStart(second);
    await setSail(second, name);
    await expect(second.locator('#start-problem')).toHaveText(/is taken/);
    await setSail(second, name.toLowerCase());
    await expect(second.locator('#start-problem')).toHaveText(/is taken/);
  } finally {
    await other.close();
  }
});
