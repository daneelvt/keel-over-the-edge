// SPDX-License-Identifier: AGPL-3.0-only

// The game connection in the browser, against keel (tools/e2e): a guest
// connects and the sea appears with the server's boat; a sail predicted
// with no correction; a wind changed on the server reaches the boat; a
// reload within the grace finds the same boat; a restart of keel brings the
// boat back to port; and a second device takes the boat, and is taken back
// from. One back end is enough: the drawing is not under test.

import { expect, type Page, test } from '@playwright/test';
import { guest, sail } from './helpers';

const internal = 'http://127.0.0.1:19090';
const control = 'http://127.0.0.1:19099';

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'webgl2', 'the connection: one back end is enough');
});

function net(page: Page) {
  return page.evaluate(() => globalThis.keel.net());
}

test('a guest connects, and the sea appears with the server’s boat', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  const n = await net(page);
  expect(n.boat).toBeGreaterThan(0);
  expect(n.tick).toBeGreaterThan(0);
  // The boat starts on the server's grid, south of the centre, heading east.
  const b = await page.evaluate(() => globalThis.keel.boat());
  expect(b.state.y).toBeLessThan(0);
  expect(Math.abs(b.state.heading - Math.PI / 2)).toBeLessThan(0.5);
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.locator('.menu-rtt')).toHaveText(/Round trip (\d+|under 1) ms/);
});

test('a sail predicted with no correction', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  await page.evaluate(() => globalThis.keel.script('wiggle'));
  await page.waitForTimeout(15_000);
  const n = await net(page);
  expect(n.counts.snapshots).toBeGreaterThan(150);
  expect(n.counts.corrections).toBe(0);
  expect(n.traffic.messagesOut).toBeGreaterThan(100);
});

test('a wind changed on the server reaches the boat', async ({ page, context, request }) => {
  await guest(context);
  await sail(page);
  const res = await request.post(`${internal}/debug/wind?knots=15&from=90`);
  expect(res.status()).toBe(204);
  await page.waitForFunction(
    () => Math.abs(globalThis.keel.boat().wind.speed - (15 * 1852) / 3600) < 1e-9,
    null,
    { timeout: 5_000 },
  );
  const b = await page.evaluate(() => globalThis.keel.boat());
  expect(b.wind.from).toBeCloseTo(Math.PI / 2, 12);
  // The ticks predicted in the old wind are corrected once.
  expect((await net(page)).counts.corrections).toBeLessThanOrEqual(2);
  await request.post(`${internal}/debug/wind?knots=10&from=0`);
});

test('a reload within the grace finds the same boat', async ({ page, context }) => {
  await guest(context);
  await sail(page);
  await page.evaluate(() => globalThis.keel.setControls(0.3, 0.4));
  await page.waitForTimeout(3_000);
  const before = await net(page);
  const at = (await page.evaluate(() => globalThis.keel.boat())).state;
  await sail(page);
  const after = await net(page);
  expect(after.boat).toBe(before.boat);
  const now = (await page.evaluate(() => globalThis.keel.boat())).state;
  // The boat sailed on while the page reloaded: near where it was, not back at the start.
  expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(40);
});

test('a restart of keel brings the boat back to port', async ({ page, context, request }) => {
  await guest(context);
  await sail(page);
  const before = await net(page);
  expect((await request.post(`${control}/restart`, { timeout: 60_000 })).status()).toBe(204);
  await page.waitForFunction(
    (boat) => {
      const n = globalThis.keel.net();
      return n.status === 'sailing' && n.boat !== boat;
    },
    before.boat,
    { timeout: 30_000 },
  );
  await expect(page.locator('[data-readout="connection"]')).toHaveText(/returned to port/);
});

test('another device takes the boat, and Take over takes it back', async ({ page, browser }) => {
  const context = page.context();
  await guest(context);
  await sail(page);
  const boat = (await net(page)).boat;
  const other = await browser.newContext({ storageState: await context.storageState() });
  const second = await other.newPage();
  await sail(second);
  expect((await net(second)).boat).toBe(boat);
  await expect(page.locator('[data-readout="connection"]')).toHaveText(/another device/);
  await page.getByRole('button', { name: 'Take over' }).click();
  await page.waitForFunction(() => globalThis.keel.net().status === 'sailing', null, {
    timeout: 10_000,
  });
  await expect(second.locator('[data-readout="connection"]')).toHaveText(/another device/);
  expect((await net(page)).boat).toBe(boat);
  await other.close();
});
