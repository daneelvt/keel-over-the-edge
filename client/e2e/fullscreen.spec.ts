// SPDX-License-Identifier: AGPL-3.0-only

// The whole screen, in the offline sandbox: the menu's switch takes it on
// its tap and gives it back, the choice kept with the device's settings;
// left as by back, the switch turns off. And Chrome finds the game
// installable from the page's manifest and icons, as a phone's Chrome
// does before offering to install it.

import { expect, type Page, test } from '@playwright/test';
import { openScene } from './helpers';

/**
 * Waits for the next fullscreenchange, the page's own listeners heard: the
 * element is set a frame before it.
 */
function changed(page: Page): Promise<unknown> {
  return page.evaluate(
    () => new Promise((r) => document.addEventListener('fullscreenchange', r, { once: true })),
  );
}

test('the menu’s switch takes the whole screen; left as by back, it turns off', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the switch is tried in Chromium');
  await openScene(page, '', true);
  await page.getByRole('button', { name: 'Menu' }).click();
  const full = page.getByRole('checkbox', { name: 'Full screen' });
  await expect(full).not.toBeChecked();
  // A real click: the tap the browser requires.
  let change = changed(page);
  await full.click();
  await change;
  expect(await page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(
    true,
  );
  await expect(full).toBeChecked();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('keel.settings') ?? '{}').fullScreen as unknown,
    ),
  ).toBe(true);
  // Off from the menu gives the screen back.
  change = changed(page);
  await full.click();
  await change;
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  // On again, then left as back leaves it, with the page in sight.
  change = changed(page);
  await full.click();
  await change;
  change = changed(page);
  await page.evaluate(() => document.exitFullscreen());
  await change;
  await expect(full).not.toBeChecked();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('keel.settings') ?? '{}').fullScreen as unknown,
    ),
  ).toBe(false);
  // No key: leaving was the player's choice.
  await page.getByRole('button', { name: 'Close the menu' }).click();
  await expect(page.locator('.fullscreen-key')).toHaveCount(0);
});

test('Chrome finds the game installable', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'installability is Chrome’s');
  await page.goto('/?sandbox&test&backend=webgl2');
  await page.waitForFunction(() => globalThis.keel !== undefined, null, { timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const manifest = (await cdp.send('Page.getAppManifest')) as {
    url: string;
    errors: { message: string }[];
  };
  expect(manifest.url).toMatch(/\/manifest\.webmanifest$/);
  expect(manifest.errors).toEqual([]);
  const { installabilityErrors } = (await cdp.send('Page.getInstallabilityErrors')) as {
    installabilityErrors: { errorId: string }[];
  };
  // A test's browser profile is a private one's, where nothing installs;
  // every other reason is the page's.
  expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual(
    [],
  );
});
