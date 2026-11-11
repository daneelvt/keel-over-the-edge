// SPDX-License-Identifier: AGPL-3.0-only

// A new sailor's start, against keel and its database: the start screen,
// names refused in words, when the player was born asked with nothing
// chosen and every answer taking the same steps, a sailor that can't be
// made told only that (and again from its cookie), a sailor made with a passkey (Playwright's
// virtual authenticator standing in for the browser's prompt), its recovery
// code shown once, Set sail with the voyage watched, its cookie, and the
// sailor kept across a reload, where its Set sail shows that voyage's
// choice. The page draws nothing (?draw=off): a form is the test.
//
// And the way to sea: the page's cover over everything from its first
// frame, the start screen on it, Set sail answered at once, and the screen
// at sea seen only once the cover has gone, with the world's sky, the
// boat's first snapshot and its first view in place.

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };
import { answerBorn, GAME, holdPasskeys, sailor, setSail, stamp } from './helpers';

test.beforeEach(async ({ context }) => {
  // The browser's prompt, answered by Playwright: it holds no passkey yet.
  await context.credentials.install();
});

/** A name no other test has taken: a word and stamp()'s digits. */
function freshName(word: string): string {
  return `${word} ${stamp()}`;
}

async function openStart(page: Page): Promise<void> {
  await page.goto(GAME);
  await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible({
    timeout: 30_000,
  });
}

/** The first form's Set sail, with a name: it makes the sailor, if the name will do. */
async function makeAs(page: Page, name: string): Promise<void> {
  await page.getByLabel('Your sailor’s name').fill(name);
  await answerBorn(page);
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
  await page.getByRole('button', { name: 'Close', exact: true }).click();
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
  // The picker, a look drawn at random, drawn again by Shuffle.
  const names = data.sailors.map((s) => s.name);
  const shown = page.locator('.picker-look-name');
  expect(names).toContain(await shown.textContent());
  const words = page.locator('.picker-words');
  const before = await words.textContent();
  await page.getByRole('button', { name: 'Shuffle' }).click();
  await expect(words).not.toHaveText(before ?? '');
  expect(names).toContain(await shown.textContent());
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

test('when the sailor’s player was born: both boxes empty, and asked before anything is sent', async ({
  page,
}) => {
  await openStart(page);
  const month = page.getByRole('combobox', { name: 'Month' });
  const year = page.getByRole('combobox', { name: 'Year' });
  await expect(page.getByRole('group', { name: 'When were you born?' })).toBeVisible();
  // Nothing chosen to start, and nothing said of any age.
  await expect(month).toHaveValue('');
  await expect(year).toHaveValue('');
  await expect(month.locator('option')).toHaveCount(13);
  await expect(month.locator('option').nth(1)).toHaveText('January');
  const thisYear = new Date().getFullYear();
  await expect(year.locator('option')).toHaveCount(122);
  await expect(year.locator('option').nth(1)).toHaveText(String(thisYear));
  await expect(year.locator('option').last()).toHaveText(String(thisYear - 120));
  await expect(page.getByRole('group', { name: 'When were you born?' })).not.toContainText(
    /\b(age|old|must|at least|under|over)\b/i,
  );
  // A name with no answer: told so, and nothing sent.
  let begun = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/account/begin')) {
      begun++;
    }
  });
  await page.getByLabel('Your sailor’s name').fill(freshName('Unborn'));
  await page.getByRole('button', { name: 'Set sail' }).click();
  await expect(page.locator('#start-problem')).toHaveText(
    'Choose the month and year you were born.',
  );
  await month.selectOption({ label: 'March' });
  await page.getByRole('button', { name: 'Set sail' }).click();
  await expect(page.locator('#start-problem')).toHaveText(
    'Choose the month and year you were born.',
  );
  expect(begun).toBe(0);
});

test('every answer takes the same steps: one Set sail, the answer sent with the name', async ({
  page,
}) => {
  const sent: unknown[] = [];
  // The harbour stands still, whatever the answer: what the page does
  // before it answers is the same.
  await page.route('**/account/begin', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  await openStart(page);
  const thisYear = new Date().getFullYear();
  for (const [month, year] of [
    ['April', '2001'],
    ['December', String(thisYear - 5)],
    ['January', String(thisYear - 90)],
  ] as const) {
    await page.getByLabel('Your sailor’s name').fill(freshName('Same'));
    await answerBorn(page, month, year);
    await page.getByRole('button', { name: 'Set sail' }).click();
    await expect(page.locator('#start-problem')).toHaveText(
      'The harbour cannot answer just now. Try again in a moment.',
    );
  }
  expect(sent).toHaveLength(3);
  expect(sent.map((b) => (b as { born: unknown }).born)).toEqual([
    { year: 2001, month: 4 },
    { year: thisYear - 5, month: 12 },
    { year: thisYear - 90, month: 1 },
  ]);
});

test('a sailor that can’t be made: only that said, and the same answer from the cookie', async ({
  page,
  context,
}) => {
  await page.route('**/account/begin', (route) =>
    route.fulfill({ status: 403, json: { error: 'young' } }),
  );
  await openStart(page);
  await page.getByLabel('Your sailor’s name').fill(freshName('Small'));
  await answerBorn(page, 'June', String(new Date().getFullYear() - 6));
  await page.getByRole('button', { name: 'Set sail' }).click();
  const panel = page.locator('.start-panel');
  await expect(panel.getByText('Sorry, a sailor can’t be made.')).toBeVisible();
  // No reason, no age, nothing to try again: the form is gone.
  await expect(page.getByLabel('Your sailor’s name')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set sail' })).toHaveCount(0);
  await expect(panel).not.toContainText(/\d|age|old|try again/i);
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  expect(await context.credentials.get()).toEqual([]);

  // The server's cookie: the screen answers the same at once.
  const fresh = await page.context().browser()?.newContext();
  if (fresh === undefined) {
    throw new Error('no browser');
  }
  const other = await fresh.newPage();
  await other.goto(GAME);
  await fresh.addCookies([{ name: 'keel-young', value: '1', url: new URL(other.url()).origin }]);
  await other.goto(GAME);
  await expect(other.getByText('Sorry, a sailor can’t be made.')).toBeVisible({ timeout: 30_000 });
  await expect(other.getByLabel('Your sailor’s name')).toHaveCount(0);
  await expect(other.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await fresh.close();
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
  // and a change is sent at once. The full screen's switch left on, Set
  // sail takes the whole screen, in its tap, before the voyage is sent.
  await page.evaluate(() =>
    localStorage.setItem(
      'keel.settings',
      JSON.stringify({
        ...JSON.parse(localStorage.getItem('keel.settings') ?? '{}'),
        fullScreen: true,
      }),
    ),
  );
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
  await page.waitForFunction(() => document.fullscreenElement === document.documentElement);
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

test('the cover from the first frame until the world is ready, then the world revealed', async ({
  context,
  page,
}) => {
  const made = await sailor(context, 'Covered');
  await holdPasskeys(context, made.passkey);
  // Each animation frame from the page's first: whether the cover is over
  // the page, whether the screen at sea is seen, and every line the cover
  // says.
  await page.addInitScript(() => {
    const seen: { cover: boolean; sea: boolean }[] = [];
    const lines: string[] = [];
    Object.assign(globalThis, { coverSeen: { seen, lines } });
    const look = () => {
      const c = document.getElementById('cover');
      const hud = document.querySelector('.hud:not(.watch-waiting)');
      seen.push({
        cover: c !== null && !c.hidden && getComputedStyle(c).opacity === '1',
        sea: hud !== null && getComputedStyle(hud).opacity !== '0',
      });
      const line = c?.querySelector('.cover-line')?.textContent ?? '';
      if (line !== '' && lines[lines.length - 1] !== line) {
        lines.push(line);
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.goto(GAME);
  await expect(page.locator('.your-sailor')).toBeVisible({ timeout: 90_000 });
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.revealed() != null, null, { timeout: 30_000 });
  const { seen, lines } = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          coverSeen: { seen: { cover: boolean; sea: boolean }[]; lines: string[] };
        }
      ).coverSeen,
  );
  expect(seen[0]).toEqual({ cover: true, sea: false });
  const first = seen.findIndex((f) => f.sea);
  expect(first).toBeGreaterThan(0);
  // Never the screen at sea and the cover together, nor neither before it.
  expect(seen.slice(0, first).every((f) => f.cover)).toBe(true);
  expect(seen.slice(first).some((f) => f.cover)).toBe(false);
  // Set sail answered at once.
  expect(lines[0]).toBe('Setting sail…');
  const r = await page.evaluate(() => globalThis.keel.revealed());
  expect(r).toMatchObject({ epoch: true, view: true, drawn: 0, timedOut: false });
  expect(r?.arrived).toBeGreaterThanOrEqual(1);
  expect(r?.waits[0]?.waiting).toBe('boat');
  expect(r?.waits[r.waits.length - 1]?.waiting).toBe('ready');
  expect(await page.evaluate(() => globalThis.keel.covered())).toBe(false);
});
