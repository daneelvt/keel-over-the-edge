// SPDX-License-Identifier: AGPL-3.0-only

// The page's life at sea, against keel (tools/e2e), on a page that draws
// nothing. The screen kept on from the reveal, with the browser's wake lock
// replaced by a recorder: not on the start screen, taken at the reveal,
// let go as the page hides and taken again as it comes back. The start's
// report and an error reach keel's metrics. Away to the rules and back:
// the page comes back from the back/forward cache, connects again and sails
// the same boat. And the home screen: on a third day of play the player's
// own panel offers it, Add Keel asks the browser, and once the browser has
// offered to install the game the menu has an Install key.

import { expect, type Page, test } from '@playwright/test';
import { GAME, sail, sailor, setSail } from './helpers';

// Playwright keeps Chromium's back/forward cache off; these tests need it.
// Chromium's headless shell keeps it off all the same: there the test
// checks only that nothing of the page's own would keep it out.
test.use({ launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } });

/** keel's metrics, on its internal listener (tools/e2e). */
async function metric(page: Page, line: RegExp): Promise<number> {
  const res = await page.request.get('http://127.0.0.1:19090/metrics');
  expect(res.status()).toBe(200);
  let sum = 0;
  for (const l of (await res.text()).split('\n')) {
    if (line.test(l)) {
      sum += Number(l.split(' ').pop());
    }
  }
  return sum;
}

test('the screen kept on at sea; the start’s report and an error reach the server', async ({
  context,
  page,
}) => {
  // The browser's wake lock, recorded; the page hidden and shown at the
  // test's word, the lock let go as the browser lets it go.
  await page.addInitScript(() => {
    const log: string[] = [];
    const held: (EventTarget & { released: boolean })[] = [];
    let hidden = false;
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
    const api = {
      request(type: string) {
        log.push(`request ${type}`);
        const s = Object.assign(new EventTarget(), {
          released: false,
          type,
          release: async () => {
            if (!s.released) {
              s.released = true;
              log.push('release');
              s.dispatchEvent(new Event('release'));
            }
          },
        });
        held.push(s);
        return Promise.resolve(s);
      },
    };
    Object.defineProperty(Navigator.prototype, 'wakeLock', { configurable: true, get: () => api });
    Object.assign(globalThis, {
      wakeTest: {
        log,
        hide(on: boolean) {
          hidden = on;
          if (on) {
            for (const s of held.filter((h) => !h.released)) {
              s.released = true;
              log.push('let go');
              s.dispatchEvent(new Event('release'));
            }
          }
          document.dispatchEvent(new Event('visibilitychange'));
        },
      },
    });
  });
  type WakeTest = { log: string[]; hide(on: boolean): void };
  const wake = () =>
    page.evaluate(() => (globalThis as unknown as { wakeTest: WakeTest }).wakeTest.log);
  await sailor(context, 'Awake');
  const startups = await metric(page, /^keel_client_startup_seconds_count\{stage="reveal"/);
  const errors = await metric(page, /^keel_client_errors_total\{build="dev"\}/);
  await page.goto(GAME);
  await expect(page.getByRole('button', { name: /^Set sail/ })).toBeVisible({ timeout: 90_000 });
  // The start screen: the phone keeps its own timeout.
  expect(await wake()).toEqual([]);
  await setSail(page);
  await page.waitForFunction(() => globalThis.keel?.net().status === 'sailing', null, {
    timeout: 60_000,
  });
  await expect.poll(wake).toEqual(['request screen']);
  await page.evaluate(() => (globalThis as unknown as { wakeTest: WakeTest }).wakeTest.hide(true));
  expect(await wake()).toEqual(['request screen', 'let go']);
  await page.evaluate(() => (globalThis as unknown as { wakeTest: WakeTest }).wakeTest.hide(false));
  await expect.poll(wake).toEqual(['request screen', 'let go', 'request screen']);

  // The start's report went at the reveal; an error goes at once, its
  // quoted words left on the page.
  await expect
    .poll(() => metric(page, /^keel_client_startup_seconds_count\{stage="reveal"/))
    .toBeGreaterThan(startups);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("a test's error, quoting 'Awake'");
    });
  });
  await expect
    .poll(() => metric(page, /^keel_client_errors_total\{build="dev"\}/))
    .toBeGreaterThan(errors);
});

test('away to the rules and back: the page comes back from the cache and sails on', async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    const shows: boolean[] = [];
    Object.assign(globalThis, { shows });
    window.addEventListener('pageshow', (e) => shows.push(e.persisted));
  });
  // Why a page was not kept, as Chromium says it: the page's own faults
  // ("PageSupportNeeded") apart from the browser's.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  const notKept: { type: string; reason: string }[] = [];
  cdp.on('Page.backForwardCacheNotUsed', (e) => notKept.push(...e.notRestoredExplanations));
  await sailor(context, 'Back');
  await sail(page);
  const boat = await page.evaluate(() => globalThis.keel.net().boat);
  await page.goto('/rules.html');
  await expect(page.locator('h1').first()).toBeVisible();
  // A page restored from the cache fires pageshow, not load.
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(
    () => ((globalThis as unknown as { shows?: boolean[] }).shows ?? []).length > 0,
    null,
    { timeout: 30_000 },
  );
  const shows = await page.evaluate(() => (globalThis as unknown as { shows: boolean[] }).shows);
  if (shows.length === 1) {
    // Loaded again: nothing of the page's own kept it out. Chromium's
    // headless shell (CI) keeps no page at all; Chrome does.
    await expect.poll(() => notKept.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(notKept.filter((x) => x.type === 'PageSupportNeeded')).toEqual([]);
    await expect(page.getByRole('heading', { name: 'Keel Over the Edge' })).toBeVisible();
    test.info().annotations.push({
      type: 'not kept',
      description: notKept.map((x) => x.reason).join(', '),
    });
    return;
  }
  // The same page, its hooks still there: restored, not loaded again.
  expect(shows).toEqual([false, true]);
  expect(notKept).toEqual([]);
  await page.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => globalThis.keel.net().boat)).toBe(boat);
});

test('a third day’s offer to play from the home screen, and the menu’s Install key', async ({
  context,
  page,
}) => {
  // Two days of play before today, and the browser's own offer to install,
  // as Chrome makes it, answered yes.
  await page.addInitScript(() => {
    if (localStorage.getItem('keel.homeScreen') === null) {
      localStorage.setItem(
        'keel.homeScreen',
        JSON.stringify({ days: 2, last: '2026-01-02', done: false }),
      );
    }
    Object.assign(globalThis, {
      offerInstall() {
        const asked: string[] = [];
        const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
          prompt: async () => {
            asked.push('prompt');
          },
          userChoice: Promise.resolve({ outcome: 'dismissed' }),
        });
        window.dispatchEvent(e);
        return asked;
      },
    });
  });
  type Offering = { offerInstall(): string[] };
  await sailor(context, 'Thrice');
  await page.goto(GAME);
  await expect(page.getByRole('button', { name: /^Set sail/ })).toBeVisible({ timeout: 90_000 });
  // Nothing to offer until the browser can install the game.
  await expect(page.getByRole('button', { name: 'Add Keel' })).toHaveCount(0);
  await page.evaluate(() => {
    (globalThis as unknown as { asked: string[] }).asked = (
      globalThis as unknown as Offering
    ).offerInstall();
  });
  await expect(
    page.getByText('Play from your home screen, without the browser’s bars.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add Keel' }).click();
  expect(await page.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)).toEqual([
    'prompt',
  ]);
  await expect(page.getByRole('button', { name: 'Add Keel' })).toHaveCount(0);
  await setSail(page);
  // Today counted: the third day, and the offer put away for good.
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('keel.homeScreen') ?? '{}')),
  ).toMatchObject({ days: 3, done: true });

  // At sea, the browser offers again: the menu's Install key asks it.
  await page.evaluate(() => {
    (globalThis as unknown as { asked: string[] }).asked = (
      globalThis as unknown as Offering
    ).offerInstall();
  });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  expect(await page.evaluate(() => (globalThis as unknown as { asked: string[] }).asked)).toEqual([
    'prompt',
  ]);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
});
