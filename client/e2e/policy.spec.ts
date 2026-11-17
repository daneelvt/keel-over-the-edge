// SPDX-License-Identifier: AGPL-3.0-only

// The pages under their Content Security Policy, enforced as keel sends it
// by default (internal/api/policy.go), with the page's Trusted Types
// policies (src/boot/policy.ts): on the built page as keel serves it, each
// page listened to for securitypolicyviolation from its first moment, and
// any violation, or the browser's own words of one, fails the test.
//
// - The game's page: a new sailor made on the start screen, the human
//   check's script loaded and run there, sets sail, the chart's tabs (the
//   list, the news, the log) and the menu's race window open, the service
//   worker registers through the keel policy, and HTML written as a string
//   is refused.
// - The dressing room: the sailors in a boat, their textures transcoded
//   by workers started from the page's own file (a blob's worker would
//   keep the policy, which the transcoder's functions made from strings
//   break, and its refusals never reach the page's listener).
// - The developer page (module workers found by a blob's worker, the
//   physics compiled), the sound room, the notice page, and the pages
//   without script, each with its own policy.

import { expect, type Page, type Response, test } from '@playwright/test';
import { answerBorn, stamp } from './helpers';
import { markPage, revealed } from './wire';

/**
 * Listens on the page for what its policy refuses, from its first moment:
 * each violation the page hears, the browser's own console words of one,
 * and any error the page throws. The list fills as the page runs.
 */
async function watchPolicy(page: Page): Promise<string[]> {
  const heard: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(
        `policy violation: ${e.effectiveDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`,
      );
    });
  });
  page.on('console', (m) => {
    if (/policy violation|Content Security Policy|Trusted Type/i.test(m.text())) {
      heard.push(`${new URL(page.url()).pathname}: ${m.text()}`);
    }
  });
  // A refusal often shows as an error thrown where the page asked: every
  // error the page throws is heard too.
  page.on('pageerror', (e) => {
    heard.push(`${new URL(page.url()).pathname}: ${e.message}`);
  });
  return heard;
}

/** The policy an answer carries, enforced: none reported only, and no framing. */
function enforced(res: Response | null): string {
  expect(res, 'an answer').not.toBeNull();
  const h = res?.headers() ?? {};
  expect(h['content-security-policy-report-only'], 'reported only').toBeUndefined();
  expect(h['x-frame-options']).toBe('DENY');
  return h['content-security-policy'] ?? '';
}

test('the game’s page: a new sailor sets sail and opens the windows, nothing refused', async ({
  context,
  page,
}) => {
  const heard = await watchPolicy(page);
  // The browser's prompt, answered by Playwright: it holds no passkey yet.
  await context.credentials.install();
  await markPage(page);
  const res = await page.goto('/');
  const policy = enforced(res);
  expect(policy).toContain("require-trusted-types-for 'script'");
  expect(policy).toContain('trusted-types keel default');
  expect(policy).toMatch(/style-src 'self' 'sha256-[A-Za-z0-9+/]+=*';/);

  // A new sailor, made on the start screen. The human check runs here
  // under the same policy, its script added through the keel policy: its
  // stand-in in tools/e2e is served under /turnstile/ on this origin.
  const script = page.waitForResponse((r) => new URL(r.url()).pathname === '/turnstile/api.js');
  const token = page.waitForResponse((r) => new URL(r.url()).pathname === '/turnstile/issue');
  const field = page.getByLabel('Your sailor’s name');
  await expect(field).toBeVisible({ timeout: 60_000 });
  expect((await script).status()).toBe(200);
  expect((await token).status()).toBe(200);
  await expect(page.locator('.start-check .turnstile-stand-in')).toHaveCount(1);
  await field.fill(`Policy ${stamp()}`);
  await answerBorn(page);
  await page.getByRole('button', { name: 'Set sail' }).click();
  await page.getByRole('button', { name: 'I’ve written it down' }).click({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Set sail/ }).click({ timeout: 60_000 });
  await revealed(page);

  // The chart's tabs, each loading its own code, and the menu's race
  // window.
  await page.locator('.pocket-chart').click();
  const tabs = page.locator('.chart-tabs');
  await tabs.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.chart-list')).toBeVisible();
  // The news's tab may carry a mark for new stories in its name.
  await tabs.getByRole('button', { name: /^News/ }).click();
  await expect(page.locator('.news-sheet')).toBeVisible();
  await tabs.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page.locator('.log-name')).toBeVisible();
  await tabs.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chart-tabs')).toHaveCount(0);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.locator('.menu').getByRole('button', { name: 'Make a race' }).click();
  await expect(page.getByRole('button', { name: 'Make it' })).toBeVisible();

  // The service worker, registered at the reveal through the keel policy.
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined),
      { message: 'the service worker registered', timeout: 30_000 },
    )
    .toBe(true);
  expect(heard).toEqual([]);

  // HTML as a string reaches no sink: the default policy refuses it, and
  // the page hears that it did.
  const written = await page.evaluate(() => {
    try {
      // The sink named, not written: the game's own code never uses one.
      Reflect.set(document.createElement('div'), 'innerHTML', '<b>bold</b>');
      return 'written';
    } catch {
      return 'refused';
    }
  });
  expect(written).toBe('refused');
  await expect.poll(() => heard.some((h) => h.includes('require-trusted-types-for'))).toBe(true);
});

test('the dressing room: sailors in a boat, their textures transcoded, nothing refused', async ({
  page,
}) => {
  const heard = await watchPolicy(page);
  const res = await page.goto('/sailors.html#view=lineup&boat=1');
  const policy = enforced(res);
  expect(policy).toContain("worker-src 'self' blob:");
  expect(policy).not.toContain('challenges.cloudflare.com');
  await page.waitForFunction(
    () => globalThis.dressing?.ready === true || (globalThis.dressing?.error ?? '') !== '',
    null,
    { timeout: 150_000 },
  );
  expect(await page.evaluate(() => globalThis.dressing.error)).toBe('');
  expect((await page.evaluate(() => globalThis.dressing.figures())).length).toBeGreaterThan(0);
  expect(heard).toEqual([]);
});

test('the other pages: each with its policy, nothing refused', async ({ page }) => {
  const heard = await watchPolicy(page);

  // The developer page: a module worker found by a blob's, and the
  // physics compiled.
  enforced(await page.goto('/dev.html'));
  const modules = page.locator('li', { hasText: 'Module workers' });
  await expect(modules).toHaveClass(/ok/);
  const physics = page.locator('ul.rows').nth(2);
  await expect(physics).not.toContainText('checking', { timeout: 60_000 });
  await expect(physics.locator('li').first()).toHaveClass(/\bok\b/);

  enforced(await page.goto('/sounds.html'));
  await expect(page.locator('body')).not.toBeEmpty();

  for (const path of ['/report', '/report.html']) {
    expect(enforced(await page.goto(path))).toContain("form-action 'self'");
    await expect(page.locator('#notice')).toBeVisible();
  }

  for (const path of ['/rules.html', '/safety.html', '/privacy.html']) {
    const policy = enforced(await page.goto(path));
    expect(policy).not.toContain('script-src');
    expect(policy).toContain("form-action 'none'");
    // Its style sheet, its own, was applied.
    expect(await page.evaluate(() => document.styleSheets.length)).toBeGreaterThan(0);
  }
  expect(heard).toEqual([]);
});
