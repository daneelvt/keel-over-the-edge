// SPDX-License-Identifier: AGPL-3.0-only

// The upgrade from a worker, on Chromium and WebKit: a dedicated worker's
// WebSocket carries the page's cookies and its Origin (WHATWG WebSockets
// Standard), so the server welcomes it. The page runs the net worker alone.

import { expect, test } from '@playwright/test';
import data from '../src/catalog/catalog.gen.json' with { type: 'json' };

test.beforeEach(() => {
  const p = test.info().project.name;
  test.skip(p !== 'webgl2' && p !== 'webkit', 'Chromium and WebKit');
});

test('the net worker connects with the page’s cookie', async ({ page, context }) => {
  const look = data.sailors[0]?.id ?? '';
  const res = await context.request.post('/guest', {
    data: { name: `Worker ${Date.now() % 10_000_000}`, look },
  });
  expect(res.status()).toBe(201);
  await page.goto('/e2e/net.html');
  await expect(page.locator('#result')).toHaveText(/welcome \d+.*snapshot/, { timeout: 30_000 });
});

test('without a session, the worker is sent to the start screen', async ({ page }) => {
  await page.goto('/e2e/net.html');
  await expect(page.locator('#result')).toHaveText(/signed-out/, { timeout: 30_000 });
});
